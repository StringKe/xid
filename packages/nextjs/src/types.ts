// Next.js 适配层契约；Auth 形状对标 @clerk/nextjs auth() 返回值。

import type { AccessTokenClaims, OrganizationMembershipRole } from '@xid-kit/types'

// middleware 注入、server context 读取的内部头名。
export const XID_AUTH_HEADER = 'x-xid-auth'

export type AuthObject = {
  userId: string
  sessionId: string | undefined
  orgId: string | undefined
  orgRole: OrganizationMembershipRole | undefined
  orgPermissions: readonly string[] | undefined
  claims: AccessTokenClaims
}

// userId=null 便于 if (auth.userId) 类型收窄。
export type UnauthenticatedAuthObject = {
  userId: null
  sessionId: null
  orgId: null
  orgRole: null
  orgPermissions: null
  claims: null
}

export type AuthResult = AuthObject | UnauthenticatedAuthObject

export type XidServerClientOptions = {
  // sk_live_ / sk_test_；仅 server 端传入，禁止进 client bundle。
  secretKey: string
  // 默认 https://api.xid.dev；自托管时覆盖。
  apiUrl?: string
  // 测试注入；默认 globalThis.fetch。
  fetcher?: typeof fetch
}

export type PaginationParams = {
  after?: string
  limit?: number
}

export type PaginatedResponse<T> = {
  data: readonly T[]
  totalCount: number
  hasNextPage: boolean
  nextCursor: string | null
}
