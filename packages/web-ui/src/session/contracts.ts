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
// 'error' means the first session probe failed transiently (offline, 5xx): neither signed in nor out.
export type AuthStatus =
  | 'loading'
  | 'authenticated'
  | 'unauthenticated'
  | 'error'
  | PendingMfaAuthStatus

export function isGuestUser(user: AuthUser | null | undefined): boolean {
  return user?.provisioned_by === 'anonymous'
}

// A 401 or an anonymous /v1/me body is a confirmed sign-out; any other failure is transient.
export function isConfirmedSignedOut(error: { httpStatus: number }): boolean {
  return error.httpStatus === 401
}

export function authStatusFromMe(
  me: MeResponse | null | undefined,
  options: { loadFailed?: boolean } = {},
): AuthStatus {
  if (me === undefined) return options.loadFailed ? 'error' : 'loading'
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

export function signInRedirectTarget(pathname: string, search: string, hash: string): string {
  if (pathname === '/sign-in') return `${pathname}${search}${hash}`
  const returnTo = `${pathname}${search}${hash}`
  return `/sign-in?continue=${encodeURIComponent(returnTo)}`
}

// Where a pending MFA session completes authentication before resuming `returnTo`.
export function pendingMfaCompletionPath(status: PendingMfaAuthStatus, returnTo: string): string {
  if (status === 'pending_mfa') {
    return `/mfa?${new URLSearchParams({ redirect_to: returnTo }).toString()}`
  }
  return `/mfa/setup?${new URLSearchParams({ redirect_to: returnTo }).toString()}`
}
