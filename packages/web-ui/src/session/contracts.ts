export type AuthUser = {
  id: string
  email: string
  emailVerified: boolean
  name: string | null
  imageUrl: string | null
  locale: string | null
  hasMfa: boolean
  instanceManager: boolean
  provisioned_by?: 'anonymous' | (string & {})
}

export type AuthOrg = {
  id: string
  slug: string
  name: string
  role: string
  permissions: readonly string[]
}

export type AuthSession = {
  id: string
  status: 'active' | 'pending_mfa' | 'pending_mfa_setup'
  expiresAt: string
  isImpersonation: boolean
}

export type MeResponse = {
  user: AuthUser | null
  activeOrg: AuthOrg | null
  organizations: readonly AuthOrg[]
  session: AuthSession | null
}

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated'

export function isGuestUser(user: AuthUser | null | undefined): boolean {
  return user?.provisioned_by === 'anonymous'
}

export function authStatusFromMe(me: MeResponse | null | undefined): AuthStatus {
  if (me === undefined) return 'loading'
  return me?.user ? 'authenticated' : 'unauthenticated'
}
