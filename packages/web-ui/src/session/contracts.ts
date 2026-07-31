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

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated'

export function isGuestUser(user: AuthUser | null | undefined): boolean {
  return user?.provisioned_by === 'anonymous'
}

export function authStatusFromMe(me: MeResponse | null | undefined): AuthStatus {
  if (me === undefined) return 'loading'
  return me?.user ? 'authenticated' : 'unauthenticated'
}
