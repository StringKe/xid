// @xid-kit/remix 内部类型:Remix 适配层公共契约。
// Auth 对象对标 @clerk/remix auth() 返回值,提供 userId/sessionId/claims 只读视图。
// 见 docs/design/06-developer-experience.md SDK 分层。

import type { AccessTokenClaims, OrganizationMembershipRole } from '@xid-kit/types'

// 已认证态:来自 JWT claims 的核心字段,供 loader/action 快速访问。
export type AuthObject = {
  userId: string
  sessionId: string | undefined
  orgId: string | undefined
  orgRole: OrganizationMembershipRole | undefined
  orgPermissions: readonly string[] | undefined
  claims: AccessTokenClaims
}

// 未认证态:userId=null 标识未登录,方便 if (auth.userId) 类型收窄。
export type UnauthenticatedAuthObject = {
  userId: null
  sessionId: null
  orgId: null
  orgRole: null
  orgPermissions: null
  claims: null
}

export type AuthResult = AuthObject | UnauthenticatedAuthObject

// Remix session cookie 内的 token 键名约定。
export const XID_SESSION_ACCESS_TOKEN_KEY = 'xid:access_token'
export const XID_SESSION_REFRESH_TOKEN_KEY = 'xid:refresh_token'
export const XID_SESSION_RETURN_TO_KEY = 'xid:return_to'

// createXidSessionStorage 配置。
export type XidSessionStorageOptions = {
  // cookie 签名 secret(必填,防篡改)。
  secret: string | readonly string[]
  // session cookie 名,默认 __xid_session。
  cookieName?: string
  // max-age 秒,默认 30 天(2592000)。
  maxAge?: number
  // 仅 HTTPS,默认 true;本地开发可传 false。
  secure?: boolean
  // cookie path,默认 /。
  path?: string
  // cookie domain;多租户子域时覆盖。
  domain?: string
  // SameSite 策略,默认 lax。
  sameSite?: 'strict' | 'lax' | 'none'
}

// XidSession 存储接口(抽象 Remix cookie session 操作)。
export type XidSessionStorage = {
  // 从 Cookie header 字符串解析 session。
  getSession: (cookieHeader: string | null | undefined) => Promise<XidSession>
  // 序列化 session 为 Set-Cookie 响应头值。
  commitSession: (session: XidSession) => Promise<string>
  // 销毁 session(生成清除 cookie 头值)。
  destroySession: (session: XidSession) => Promise<string>
}

// XidSession 操作接口(包装底层 Remix Session)。
export type XidSession = {
  get: (key: string) => string | undefined
  set: (key: string, value: string) => void
  unset: (key: string) => void
  has: (key: string) => boolean
  data: Record<string, string>
}

// xidClient server 端配置(sk_ 认证 Management API)。
export type XidServerClientOptions = {
  // Secret key(sk_live_xxx / sk_test_xxx),必须从 server 端传入,禁止硬编码至客户端 bundle。
  secretKey: string
  // Management API 根,默认 https://api.xid.dev。自托管时覆盖。
  apiUrl?: string
  // 注入 fetch(测试用);默认 globalThis.fetch。
  fetcher?: typeof fetch
}

// Management API 通用分页参数(api-sdk-conventions rule:cursor + limit)。
export type PaginationParams = {
  after?: string
  limit?: number
}

// cursor 分页响应包装(api-sdk-conventions rule)。
export type PaginatedResponse<T> = {
  data: readonly T[]
  totalCount: number
  hasNextPage: boolean
  nextCursor: string | null
}
