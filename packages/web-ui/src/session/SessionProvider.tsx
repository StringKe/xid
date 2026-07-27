import { useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createApiClient } from '../api'
import type { ApiClient } from '../api'
import {
  authStatusFromMe,
  type AuthOrg,
  type AuthSession,
  type AuthStatus,
  type AuthUser,
  type MeResponse,
} from './contracts'

const ME_QUERY_KEY = ['me'] as const

type TokenResponse = { token: string }

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
  session: AuthSession | null
  refresh: () => Promise<void>
  setActiveOrganization: (organizationId: string | null) => Promise<boolean>
  getToken: () => Promise<string | null>
  signOut: () => Promise<void>
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

  const apiClient = useMemo<ApiClient>(
    () => client ?? createApiClient({ onUnauthorized: handleUnauthorized }),
    [client, handleUnauthorized],
  )

  const fetchSession = useCallback(async (): Promise<MeResponse | null> => {
    const result = await apiClient.get<MeResponse>('/v1/me')
    return result.ok ? result.value : null
  }, [apiClient])

  const loadSession = useCallback(async (): Promise<MeResponse | null> => {
    const nextMe = await fetchSession()
    applySession(nextMe)
    return nextMe
  }, [applySession, fetchSession])

  useEffect(() => {
    if (!loadOnMount) return

    let active = true
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined
    const probe = (): void => {
      void fetchSession().then((nextMe) => {
        if (!active) return
        applySession(nextMe)
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
  }, [applySession, deferLoadMs, fetchSession, loadOnMount])

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
  const status = authStatusFromMe(meState)
  statusRef.current = status

  useEffect(() => {
    callbacksRef.current?.onUserChange?.(me?.user ?? null)
  }, [me?.user])

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
    applySession(null)
    await callbacksRef.current?.onSignOut?.()
  }, [apiClient, applySession])

  const value = useMemo<SessionContextValue>(
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

  return <SessionContext value={value}>{children}</SessionContext>
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
