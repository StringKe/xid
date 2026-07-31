// types.ts:@xid-kit/svelte 内部类型 -- 认证对象契约(与 nextjs adapter 保持语义一致)。

import type { AccessTokenClaims, OrganizationMembershipRole } from '@xid-kit/types'

// XID_AUTH_HEADER:与 nextjs 保持一致,供 handleXid 与 getXidAuth 使用。
export const XID_AUTH_HEADER = 'x-xid-auth'

// AuthObject:已认证态。
export type AuthObject = {
  userId: string
  sessionId: string | null
  orgId: string | null
  orgRole: OrganizationMembershipRole | null
  orgPermissions: readonly string[] | null
  claims: AccessTokenClaims
}

// UnauthenticatedAuthObject:未认证态。
export type UnauthenticatedAuthObject = {
  userId: null
  sessionId: null
  orgId: null
  orgRole: null
  orgPermissions: null
  claims: null
}

export type AuthResult = AuthObject | UnauthenticatedAuthObject
