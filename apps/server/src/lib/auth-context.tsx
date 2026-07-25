// AuthProvider / useAuth:当前 user / org / session 状态的唯一来源(SPA 侧)。
// 会话从同源 session cookie 拉(GET /v1/me,credentials:include);getToken 取 short-lived JWT
// (POST /v1/sessions/token,见 api-sdk-conventions:getToken 返回 60s JWT);signOut 走 POST /auth/sign-out。
// /v1/me 与 token 端点的响应契约在此定义,worker 侧据此实现(此 agent 不碰 worker/)。

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { createApiClient } from './api'
import type { ApiClient } from './api'
import { setAnalyticsUserId } from './google-analytics'
import { trackLogout } from './google-analytics-funnel'

// /v1/me 的 queryKey。字面量不 import lib/queries 的 queryKeys,避免与该模块的 useAuth 形成循环依赖。
const ME_QUERY_KEY = ['me'] as const

const LANDING_SESSION_DEFER_MS = 3_000

export function isPublicLandingPath(pathname: string): boolean {
  return pathname === '/' || pathname.startsWith('/docs')
}

function initialMeState(): MeResponse | null | undefined {
  const path = globalThis.location?.pathname ?? ''
  return isPublicLandingPath(path) ? null : undefined
}

export function authStatusFromMe(me: MeResponse | null | undefined): AuthStatus {
  if (me === undefined) return 'loading'
  return me?.user ? 'authenticated' : 'unauthenticated'
}

// 当前用户视图(GET /v1/me 的 user 字段;不含密钥/凭证)。
export type AuthUser = {
  id: string
  email: string
  emailVerified: boolean
  name: string | null
  imageUrl: string | null
  locale: string | null
  hasMfa: boolean
  instanceManager: boolean
}

// 当前成员组织视图(active org + 用户可切换的 org 列表)。
export type AuthOrg = {
  id: string
  slug: string
  name: string
  role: string
  permissions: readonly string[]
}

// 当前会话视图(对照 worker SessionData 对外可见部分)。
export type AuthSession = {
  id: string
  status: 'active' | 'pending_mfa' | 'pending_mfa_setup'
  expiresAt: string
  isImpersonation: boolean
}

// GET /v1/me 响应契约(worker 侧实现据此)。
export type MeResponse = {
  user: AuthUser | null
  activeOrg: AuthOrg | null
  organizations: readonly AuthOrg[]
  session: AuthSession | null
}

// 认证状态:status 驱动 UI 三态(加载中 / 已登录 / 未登录)。
export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated'

type AuthContextValue = {
  status: AuthStatus
  user: AuthUser | null
  activeOrg: AuthOrg | null
  organizations: readonly AuthOrg[]
  session: AuthSession | null
  // 重新拉取 /v1/me(登录成功 / org 切换后调用)。
  refresh: () => Promise<void>
  // 切换当前 session 的 active organization;null 表示清空 org 上下文。
  setActiveOrganization: (organizationId: string | null) => Promise<boolean>
  // 取 short-lived JWT 供前端直调受保护资源(networkless 验证,见 api-sdk-conventions)。
  getToken: () => Promise<string | null>
  // 登出:撤销服务端会话 + 清本地状态。
  signOut: () => Promise<void>
  // 共享 api client(已注入 401 处理),页面层复用避免各自 new。
  api: ApiClient
}

const AuthContext = createContext<AuthContextValue | null>(null)

// POST /v1/sessions/token 响应契约。
type TokenResponse = { token: string }

export type AuthProviderProps = {
  children: ReactNode
  // 测试/自托管注入:覆盖默认同源 client(便于断言 / 改 baseUrl)。
  client?: ApiClient
}

export function AuthProvider({ children, client }: AuthProviderProps): ReactNode {
  const queryClient = useQueryClient()
  const [meState, setMeState] = useState<MeResponse | null | undefined>(initialMeState)

  // status 由显式 /v1/me state 派生,用 ref 给 onUnauthorized 闭包读最新值(避免捕获过期态)。
  const statusRef = useRef<AuthStatus>('loading')

  // 401 统一处理:仅在已登录态收到 401 才降级为未登录(避免登录页探活时误触发)。
  // 同步写 query 缓存,让依赖 ['me'] 的旧调用点看到同一会话状态。
  const handleUnauthorized = useCallback(() => {
    if (statusRef.current === 'authenticated') {
      setMeState(null)
      queryClient.setQueryData<MeResponse | null>(ME_QUERY_KEY, null)
    }
  }, [queryClient])

  // client 注入 onUnauthorized;外部传入的 client 不覆盖其回调(测试可控)。
  const apiClient = useMemo<ApiClient>(
    () => client ?? createApiClient({ onUnauthorized: handleUnauthorized }),
    [client, handleUnauthorized],
  )

  const applySession = useCallback(
    (nextMe: MeResponse | null): void => {
      setMeState(nextMe)
      queryClient.setQueryData<MeResponse | null>(ME_QUERY_KEY, nextMe)
    },
    [queryClient],
  )

  const loadSession = useCallback(async (): Promise<MeResponse | null> => {
    const result = await apiClient.get<MeResponse>('/v1/me')
    const nextMe = result.ok ? result.value : null
    applySession(nextMe)
    return nextMe
  }, [apiClient, applySession])

  useEffect(() => {
    const path = globalThis.location?.pathname ?? ''
    if (!isPublicLandingPath(path)) return

    let active = true
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined
    const probe = (): void => {
      void apiClient.get<MeResponse>('/v1/me').then((result) => {
        if (!active) return
        const nextMe = result.ok ? result.value : null
        applySession(nextMe)
      })
    }
    const schedule = (): void => {
      timeoutId = globalThis.setTimeout(probe, LANDING_SESSION_DEFER_MS)
    }

    if (globalThis.document?.readyState === 'complete') schedule()
    else globalThis.addEventListener('load', schedule, { once: true })

    return () => {
      active = false
      if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId)
    }
  }, [apiClient, applySession])

  useEffect(() => {
    function handleVisibleRefresh(): void {
      if (document.visibilityState === 'visible') void loadSession()
    }

    window.addEventListener('focus', handleVisibleRefresh)
    window.addEventListener('online', handleVisibleRefresh)
    document.addEventListener('visibilitychange', handleVisibleRefresh)
    return () => {
      window.removeEventListener('focus', handleVisibleRefresh)
      window.removeEventListener('online', handleVisibleRefresh)
      document.removeEventListener('visibilitychange', handleVisibleRefresh)
    }
  }, [loadSession])

  const me = meState ?? null
  const status: AuthStatus = authStatusFromMe(meState)
  statusRef.current = status

  const refresh = useCallback(async (): Promise<void> => {
    await loadSession()
  }, [loadSession])

  const setActiveOrganization = useCallback(
    async (organizationId: string | null): Promise<boolean> => {
      const result = await apiClient.post<unknown>('/v1/sessions/active-organization', {
        organizationId,
      })
      if (!result.ok) return false
      await refresh()
      return true
    },
    [apiClient, refresh],
  )

  const getToken = useCallback(async (): Promise<string | null> => {
    const result = await apiClient.post<TokenResponse>('/v1/sessions/token')
    return result.ok ? result.value.token : null
  }, [apiClient])

  const signOut = useCallback(async (): Promise<void> => {
    await apiClient.post<unknown>('/auth/sign-out')
    trackLogout()
    setAnalyticsUserId(null)
    applySession(null)
  }, [apiClient, applySession])

  useEffect(() => {
    setAnalyticsUserId(me?.user?.id ?? null)
  }, [me?.user?.id])

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user: me?.user ?? null,
      activeOrg: me?.activeOrg ?? null,
      organizations: me?.organizations ?? [],
      session: me?.session ?? null,
      refresh,
      setActiveOrganization,
      getToken,
      signOut,
      api: apiClient,
    }),
    [status, me, refresh, setActiveOrganization, getToken, signOut, apiClient],
  )

  return <AuthContext value={value}>{children}</AuthContext>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider')
  return context
}

// 便捷断言型 hook:已登录页面用,user 非空收窄;未登录时 throw(由路由守卫保证不触达)。
export function useAuthenticatedUser(): AuthUser {
  const { user } = useAuth()
  if (!user) throw new Error('useAuthenticatedUser requires an authenticated session')
  return user
}
