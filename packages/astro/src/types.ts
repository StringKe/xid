// @xid-kit/astro 内部类型:Astro 适配层公共契约。
// Auth 对象对标 @xid-kit/nextjs AuthResult 的 Astro 版,提供 userId/sessionId/claims 只读视图。

import type { AccessTokenClaims, OrganizationMembershipRole } from '@xid-kit/types'
import type { JwtKey, SessionTokenExchangeOptions } from '@xid-kit/backend'
import type { OidcXidClientOptions, SameOriginXidClientOptions } from '@xid-kit/core'

// xidMiddleware 注入到 Astro.locals,供 .astro 页面 server 侧读取。
export const XID_AUTH_LOCALS_KEY = 'xidAuth' as const

// 已认证态
export type AuthObject = {
  userId: string
  sessionId: string | undefined
  orgId: string | undefined
  orgRole: OrganizationMembershipRole | undefined
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
  // 应用自己持有的 short-lived JWT cookie。无默认值。
  jwtCookieName?: string
  // 同源 Core opaque cookie -> short-lived JWT exchange。
  sessionTokenExchange?: SessionTokenExchangeOptions
  // 受保护路由 pathname 前缀列表;匹配且未登录则 302 到 signInUrl。
  protectedRoutes?: readonly string[]
  // 登录页路径,默认 /sign-in。
  signInUrl?: string
  // 公开路由:即使被 protectedRoutes 覆盖也不重定向。
  publicRoutes?: readonly string[]
}

// Astro integration 的配置会在 astro.config 构建进 server middleware bundle。
// 已导入的 CryptoKey、fetcher 和 AbortSignal 都不能跨这个序列化边界。
export type SerializableJwtKey = Exclude<JwtKey, { readonly publicKey: CryptoKey }>
export type XidIntegrationSessionTokenExchangeOptions = Pick<
  SessionTokenExchangeOptions,
  'endpoint'
>

export type XidIntegrationBrowserOptions =
  | Omit<SameOriginXidClientOptions, 'fetcher' | 'now' | 'secretKey'>
  | Omit<OidcXidClientOptions, 'fetcher' | 'now' | 'tokenCache'>

// Astro Integration 初始化选项(注入 middleware 时使用)。
export type XidIntegrationOptions = {
  // 可序列化的 browser Core 配置。跨域应用使用 oidc + clientId。
  browser?: XidIntegrationBrowserOptions
  // 以下选项通过 server-only virtual module 传给 xidMiddleware。
  jwtKey?: SerializableJwtKey
  issuer?: string
  authorizedParties?: readonly string[]
  jwtCookieName?: string
  sessionTokenExchange?: XidIntegrationSessionTokenExchangeOptions
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
