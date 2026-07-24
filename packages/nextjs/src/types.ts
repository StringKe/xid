// @xid-kit/nextjs 内部类型:Next.js 适配层公共契约。
// Auth 对象对标 @clerk/nextjs auth() 返回值,提供 userId/sessionId/claims 只读视图。
// 见 docs/design/06-developer-experience.md SDK 分层。

import type { AccessTokenClaims } from '@xid-kit/types'

// xidMiddleware 注入到 Request headers,供 server context 读取。
export const XID_AUTH_HEADER = 'x-xid-auth'

// 已认证态:来自 JWT claims 的核心字段,供 server component/handler 快速访问。
export type AuthObject = {
  userId: string
  sessionId: string | undefined
  orgId: string | undefined
  orgRole: string | undefined
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
  // 分页游标(上一页末尾 id),首页省略。
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
