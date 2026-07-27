import type { ReactNode } from 'react'
import { SessionProvider as SharedSessionProvider } from '@xid-kit/web-ui/session'
import type { ApiClient } from '@xid-kit/web-ui/api'
import type { SessionCallbacks as SharedSessionCallbacks } from '@xid-kit/web-ui/session'
import { setAnalyticsUserId } from './google-analytics'
import { trackLogout } from './google-analytics-funnel'

const CORE_SESSION_CALLBACKS: SharedSessionCallbacks = {
  onUserChange: (user) => setAnalyticsUserId(user?.id ?? null),
  onSignOut: () => trackLogout(),
}

export type AuthProviderProps = {
  children: ReactNode
  client?: ApiClient
}

export function AuthProvider({ children, client }: AuthProviderProps): ReactNode {
  return (
    <SharedSessionProvider client={client} callbacks={CORE_SESSION_CALLBACKS}>
      {children}
    </SharedSessionProvider>
  )
}

export {
  SessionProvider,
  authStatusFromMe,
  isGuestUser,
  useAuthenticatedUser,
  useAuth,
  useSession,
} from '@xid-kit/web-ui/session'
export type {
  AuthContextValue,
  AuthOrg,
  AuthSession,
  AuthStatus,
  AuthUser,
  MeResponse,
  SessionCallbacks,
  SessionContextValue,
  SessionProviderProps,
} from '@xid-kit/web-ui/session'
