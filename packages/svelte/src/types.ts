// 认证对象契约与 nextjs adapter 语义对齐。

import type { AccessTokenClaims, OrganizationMembershipRole } from '@xid-kit/types'

export const XID_AUTH_HEADER = 'x-xid-auth'

export type AuthObject = {
  userId: string
  sessionId: string | null
  orgId: string | null
  orgRole: OrganizationMembershipRole | null
  orgPermissions: readonly string[] | null
  claims: AccessTokenClaims
}

export type UnauthenticatedAuthObject = {
  userId: null
  sessionId: null
  orgId: null
  orgRole: null
  orgPermissions: null
  claims: null
}

export type AuthResult = AuthObject | UnauthenticatedAuthObject
