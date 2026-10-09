import { useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createApiClient, observeApiClientErrors } from '../api'
import type { ApiClient } from '../api'
import type { XidError } from '@xid-kit/types'
import type { SessionTokenResponse } from '@xid-kit/types'
import type { BrowserManagerAssignment } from '@xid-kit/types'
import { executeBrowserSamlLogout } from '@xid-kit/core'
import type { SignOutResponse } from '@xid-kit/core'
import { EmailVerificationPanel } from './EmailVerificationPanel'
import {
  authStatusFromMe,
  isConfirmedSignedOut,
  type AuthOrg,
  type AuthSession,
  type AuthStatus,
  type AuthUser,
  type MeResponse,
} from './contracts'

const ME_QUERY_KEY = ['me'] as const
const VISIBLE_REFRESH_MIN_INTERVAL_MS = 2_000

type SessionProbe = { kind: 'resolved'; me: MeResponse | null } | { kind: 'transient' }

export type SessionCallbacks = {
  onUnauthorized?: () => void
  onUserChange?: (user: AuthUser | null) => void
  onSignOut?: () => void | Promise<void>
}

export type SessionContextValue = {
  status: AuthStatus
  user: AuthUser | null
  activeOrg: AuthOrg | null
  organizations: readonly AuthOrg[]
  managerAssignments: readonly BrowserManagerAssignment[]
  session: AuthSession | null
  activeSessionId: string | null
  sessions: readonly AuthSession[]
  refresh: () => Promise<void>
  setActiveSession: (sessionId: string) => Promise<boolean>
  setActiveOrganization: (organizationId: string | null) => Promise<boolean>
  getToken: () => Promise<string | null>
  signOut: () => Promise<void>
  openEmailVerification: () => void
  api: ApiClient
}

export type SessionProviderProps = {
  children: ReactNode
  client?: ApiClient
  callbacks?: SessionCallbacks
  initialSession?: MeResponse | null
  loadOnMount?: boolean
  deferLoadMs?: number
}

const SessionContext = createContext<SessionContextValue | null>(null)

export function SessionProvider(props: SessionProviderProps): ReactNode {
  const { children, client, callbacks, initialSession, loadOnMount = true, deferLoadMs = 0 } = props
  const queryClient = useQueryClient()
  const [meState, setMeState] = useState<MeResponse | null | undefined>(() => initialSession)
  const [loadFailed, setLoadFailed] = useState(false)
  const [emailVerificationOpen, setEmailVerificationOpen] = useState(false)
  const statusRef = useRef<AuthStatus>('loading')
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

  const applySession = useCallback(
    (nextMe: MeResponse | null): void => {
      setMeState(nextMe)
      queryClient.setQueryData<MeResponse | null>(ME_QUERY_KEY, nextMe)
    },
    [queryClient],
  )

  const handleUnauthorized = useCallback(() => {
    if (statusRef.current === 'authenticated') applySession(null)
    callbacksRef.current?.onUnauthorized?.()
  }, [applySession])

  const handleApiError = useCallback((error: XidError): void => {
    if (error.code === 'email_verification_required') {
      setEmailVerificationOpen(true)
    }
  }, [])

  const apiClient = useMemo<ApiClient>(
    () =>
      observeApiClientErrors(
        client ?? createApiClient({ onUnauthorized: handleUnauthorized }),
        handleApiError,
      ),
    [client, handleApiError, handleUnauthorized],
  )

  // 只有 401 或匿名响应才算已登出;离线、5xx、限流保留上一次会话,首次失败进入 'error'。
  const fetchSession = useCallback(async (): Promise<SessionProbe> => {
    const result = await apiClient.get<MeResponse>('/v1/me')
    if (result.ok) return { kind: 'resolved', me: result.value }
    if (isConfirmedSignedOut(result.error)) return { kind: 'resolved', me: null }
    return { kind: 'transient' }
  }, [apiClient])

  const applyProbe = useCallback(
    (probe: SessionProbe): void => {
      if (probe.kind === 'resolved') {
        setLoadFailed(false)
        applySession(probe.me)
        return
      }
      setLoadFailed(true)
    },
    [applySession],
  )

  const loadSession = useCallback(async (): Promise<void> => {
    applyProbe(await fetchSession())
  }, [applyProbe, fetchSession])

  useEffect(() => {
    if (!loadOnMount) return

    let active = true
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined
    const probe = (): void => {
      void fetchSession().then((result) => {
        if (!active) return
        applyProbe(result)
      })
    }
    const schedule = (): void => {
      if (deferLoadMs > 0) {
        timeoutId = globalThis.setTimeout(probe, deferLoadMs)
        return
      }
      probe()
    }

    if (deferLoadMs > 0 && globalThis.document?.readyState !== 'complete') {
      globalThis.addEventListener('load', schedule, { once: true })
    } else {
      schedule()
    }

    return () => {
      active = false
      globalThis.removeEventListener?.('load', schedule)
      if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId)
    }
  }, [applyProbe, deferLoadMs, fetchSession, loadOnMount])

  // 会话没有 useQuery 观察者:['me'] 常驻缓存,mutation 失效它时由这里重新拉取 /v1/me。
  useEffect(() => {
    queryClient.setQueryDefaults(ME_QUERY_KEY, { gcTime: Infinity })
    const cache = queryClient.getQueryCache()
    const meQueryHash = cache.build(queryClient, { queryKey: ME_QUERY_KEY }).queryHash
    return cache.subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'invalidate') return
      if (event.query.queryHash !== meQueryHash) return
      void loadSession()
    })
  }, [loadSession, queryClient])

  // 租户级资源的 queryKey 不含租户:切换会话或活跃组织后,丢弃上一范围的数据和失败状态并重新拉取。
  const cacheScope =
    meState === undefined
      ? undefined
      : `${meState?.activeSessionId ?? ''}:${meState?.activeOrg?.id ?? ''}`
  const cacheScopeRef = useRef(cacheScope)
  useEffect(() => {
    const previous = cacheScopeRef.current
    cacheScopeRef.current = cacheScope
    if (previous === undefined || cacheScope === undefined || previous === cacheScope) return
    void queryClient.resetQueries({ predicate: (query) => query.queryKey[0] !== ME_QUERY_KEY[0] })
  }, [cacheScope, queryClient])

  // focus 与 visibilitychange 在切回标签页时成对触发,合并为一次并限制最小间隔。
  const lastVisibleRefreshRef = useRef(0)
  useEffect(() => {
    function handleVisibleRefresh(): void {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      if (now - lastVisibleRefreshRef.current < VISIBLE_REFRESH_MIN_INTERVAL_MS) return
      lastVisibleRefreshRef.current = now
      void loadSession()
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
  const status = authStatusFromMe(meState, { loadFailed })
  statusRef.current = status

  useEffect(() => {
    if (!me?.user || me.user.emailVerified) setEmailVerificationOpen(false)
  }, [me?.user])

  useEffect(() => {
    callbacksRef.current?.onUserChange?.(me?.user ?? null)
  }, [me?.user])

  const refresh = useCallback(async (): Promise<void> => {
    await loadSession()
  }, [loadSession])

  const setActiveSession = useCallback(
    async (sessionId: string): Promise<boolean> => {
      const result = await apiClient.post<unknown>('/v1/sessions/active', { sessionId })
      if (!result.ok) return false
      await refresh()
      return true
    },
    [apiClient, refresh],
  )

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
    const result = await apiClient.post<SessionTokenResponse>('/v1/sessions/token')
    return result.ok ? result.value.token : null
  }, [apiClient])

  const signOut = useCallback(async (): Promise<void> => {
    const result = await apiClient.post<SignOutResponse>('/auth/sign-out')
    if (!result.ok) return
    // 先落到已登出,随后的 /v1/me 即使失败也不会把用户留在已登录状态;另一个浏览器会话仍会被刷新出来。
    applySession(null)
    if (result.value.samlLogout) {
      await callbacksRef.current?.onSignOut?.()
      if (executeBrowserSamlLogout(result.value.samlLogout)) return
      await loadSession()
      return
    }
    await loadSession()
    await callbacksRef.current?.onSignOut?.()
  }, [apiClient, applySession, loadSession])

  const openEmailVerification = useCallback((): void => {
    setEmailVerificationOpen(true)
  }, [])

  const value = useMemo<SessionContextValue>(
    () => ({
      status,
      user: me?.user ?? null,
      activeOrg: me?.activeOrg ?? null,
      organizations: me?.organizations ?? [],
      managerAssignments: me?.managerAssignments ?? [],
      session: me?.session ?? null,
      activeSessionId: me?.activeSessionId ?? null,
      sessions: me?.sessions ?? [],
      refresh,
      setActiveSession,
      setActiveOrganization,
      getToken,
      signOut,
      openEmailVerification,
      api: apiClient,
    }),
    [
      status,
      me,
      refresh,
      setActiveSession,
      setActiveOrganization,
      getToken,
      signOut,
      openEmailVerification,
      apiClient,
    ],
  )

  return (
    <SessionContext value={value}>
      {children}
      {emailVerificationOpen ? (
        <EmailVerificationPanel
          api={apiClient}
          email={me?.user?.email ?? ''}
          onClose={() => setEmailVerificationOpen(false)}
        />
      ) : null}
    </SessionContext>
  )
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext)
  if (!context) throw new Error('useSession must be used within SessionProvider')
  return context
}

export function useAuthenticatedUser(): AuthUser {
  const { user } = useSession()
  if (!user) throw new Error('useAuthenticatedUser requires an authenticated session')
  return user
}

export const useAuth = useSession
export type AuthContextValue = SessionContextValue
