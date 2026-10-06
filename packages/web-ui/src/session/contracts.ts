import type {
  BrowserAuthOrganization,
  BrowserAuthSession,
  BrowserAuthUser,
  BrowserMeResponse,
} from '@xid-kit/types'

export type AuthUser = BrowserAuthUser
export type AuthOrg = BrowserAuthOrganization
export type AuthSession = BrowserAuthSession
export type MeResponse = BrowserMeResponse

export type PendingMfaAuthStatus = 'pending_mfa' | 'pending_mfa_setup'

// Pending statuses are not authenticated; only the MFA challenge and enrollment pages may render.
export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated' | PendingMfaAuthStatus

export function isGuestUser(user: AuthUser | null | undefined): boolean {
  return user?.provisioned_by === 'anonymous'
}

export function authStatusFromMe(me: MeResponse | null | undefined): AuthStatus {
  if (me === undefined) return 'loading'
  if (me?.user) return 'authenticated'
  const sessionStatus = me?.session?.status
  if (sessionStatus === 'pending_mfa' || sessionStatus === 'pending_mfa_setup') {
    return sessionStatus
  }
  return 'unauthenticated'
}

export function isPendingMfaStatus(status: AuthStatus): status is PendingMfaAuthStatus {
  return status === 'pending_mfa' || status === 'pending_mfa_setup'
}

// Where a pending MFA session completes authentication before resuming `returnTo`.
export function pendingMfaCompletionPath(status: PendingMfaAuthStatus, returnTo: string): string {
  if (status === 'pending_mfa') {
    return `/mfa?${new URLSearchParams({ redirect_to: returnTo }).toString()}`
  }
  return `/account/security?${new URLSearchParams({ setup: 'mfa', redirect_to: returnTo }).toString()}`
}
