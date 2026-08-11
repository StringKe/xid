// Remix 适配层公共契约；Auth 形态对标 @clerk/remix auth() 的只读视图。

import type { AccessTokenClaims, OrganizationMembershipRole } from '@xid-kit/types'

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

export const XID_SESSION_ACCESS_TOKEN_KEY = 'xid:access_token'
export const XID_SESSION_REFRESH_TOKEN_KEY = 'xid:refresh_token'
export const XID_SESSION_RETURN_TO_KEY = 'xid:return_to'

export type XidSessionStorageOptions = {
  // cookie 签名 secret，防篡改；禁止进客户端 bundle。
  secret: string | readonly string[]
  cookieName?: string
  maxAge?: number
  // 默认 true；本地 HTTP 开发可传 false。
  secure?: boolean
  path?: string
  // 多租户子域共享 cookie 时覆盖。
  domain?: string
  sameSite?: 'strict' | 'lax' | 'none'
}

export type XidSessionStorage = {
  getSession: (cookieHeader: string | null | undefined) => Promise<XidSession>
  commitSession: (session: XidSession) => Promise<string>
  destroySession: (session: XidSession) => Promise<string>
}

export type XidSession = {
  get: (key: string) => string | undefined
  set: (key: string, value: string) => void
  unset: (key: string) => void
  has: (key: string) => boolean
  data: Record<string, string>
}

export type XidServerClientOptions = {
  // sk_live_ / sk_test_，仅服务端传入，禁止进客户端 bundle。
  secretKey: string
  // 默认 https://api.xid.dev；自托管时覆盖。
  apiUrl?: string
  // 测试可注入；默认 globalThis.fetch。
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
