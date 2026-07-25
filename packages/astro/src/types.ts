// @xid-kit/astro 内部类型:Astro 适配层公共契约。
// Auth 对象对标 @xid-kit/nextjs AuthResult 的 Astro 版,提供 userId/sessionId/claims 只读视图。

import type { AccessTokenClaims } from '@xid-kit/types'
import type { JwtKey } from '@xid-kit/backend'

// xidMiddleware 注入到 Astro.locals,供 .astro 页面 server 侧读取。
export const XID_AUTH_LOCALS_KEY = 'xidAuth' as const

// 已认证态
export type AuthObject = {
  userId: string
  sessionId: string | undefined
  orgId: string | undefined
  orgRole: string | undefined
  orgPermissions: readonly string[] | undefined
  claims: AccessTokenClaims
}

// 未认证态:userId=null 标识未登录,方便 if (locals.xidAuth.userId) 类型收窄。
export type UnauthenticatedAuthObject = {
  userId: null
  sessionId: null
  orgId: null
  orgRole: null
  orgPermissions: null
  claims: null
}

export type AuthResult = AuthObject | UnauthenticatedAuthObject

// Astro middleware 初始化选项。
export type XidMiddlewareOptions = {
  // JWKS 公钥(必填):networkless 验签所需。
  jwtKey: JwtKey
  // 期望 issuer。
  issuer?: string
  // 授权方白名单(azp 校验)。
  authorizedParties?: readonly string[]
  // session cookie 名,默认 __session。
  cookieName?: string
  // 受保护路由 pathname 前缀列表;匹配且未登录则 302 到 signInUrl。
  protectedRoutes?: readonly string[]
  // 登录页路径,默认 /sign-in。
  signInUrl?: string
  // 公开路由:即使被 protectedRoutes 覆盖也不重定向。
  publicRoutes?: readonly string[]
}

// Astro Integration 初始化选项(注入 middleware 时使用)。
export type XidIntegrationOptions = {
  // publishableKey:客户端可见的公钥(pk_live_xxx / pk_test_xxx)。
  publishableKey: string
  // 以下选项透传给 xidMiddleware。
  jwtKey?: JwtKey
  issuer?: string
  authorizedParties?: readonly string[]
  cookieName?: string
  protectedRoutes?: readonly string[]
  signInUrl?: string
  publicRoutes?: readonly string[]
}

// xidClient server 端配置(sk_ 认证 Management API)。
export type XidServerClientOptions = {
  secretKey: string
  apiUrl?: string
  fetcher?: typeof fetch
}

// cursor 分页响应包装。
export type PaginatedResponse<T> = {
  data: readonly T[]
  totalCount: number
  hasNextPage: boolean
  nextCursor: string | null
}
