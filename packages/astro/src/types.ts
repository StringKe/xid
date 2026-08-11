// Astro 适配层公共契约;Auth 形状对标 @xid-kit/nextjs AuthResult。

import type { AccessTokenClaims, OrganizationMembershipRole } from '@xid-kit/types'
import type { JwtKey, SessionTokenExchangeOptions } from '@xid-kit/backend'
import type { OidcXidClientOptions, SameOriginXidClientOptions } from '@xid-kit/core'

export const XID_AUTH_LOCALS_KEY = 'xidAuth' as const

export type AuthObject = {
  userId: string
  sessionId: string | undefined
  orgId: string | undefined
  orgRole: OrganizationMembershipRole | undefined
  orgPermissions: readonly string[] | undefined
  claims: AccessTokenClaims
}

// userId=null 便于 if (locals.xidAuth.userId) 类型收窄。
export type UnauthenticatedAuthObject = {
  userId: null
  sessionId: null
  orgId: null
  orgRole: null
  orgPermissions: null
  claims: null
}

export type AuthResult = AuthObject | UnauthenticatedAuthObject

export type XidMiddlewareOptions = {
  jwtKey: JwtKey
  issuer?: string
  authorizedParties?: readonly string[]
  // 应用自有 short-lived JWT cookie,无默认值。
  jwtCookieName?: string
  // 同源 Core opaque cookie 换 short-lived JWT;不在本地验 opaque refresh。
  sessionTokenExchange?: SessionTokenExchangeOptions
  protectedRoutes?: readonly string[]
  signInUrl?: string
  publicRoutes?: readonly string[]
}

// integration 配置在构建期序列化进 middleware bundle;CryptoKey/fetcher/AbortSignal 不能跨边界。
export type SerializableJwtKey = Exclude<JwtKey, { readonly publicKey: CryptoKey }>
export type XidIntegrationSessionTokenExchangeOptions = Pick<
  SessionTokenExchangeOptions,
  'endpoint'
>

export type XidIntegrationBrowserOptions =
  | Omit<SameOriginXidClientOptions, 'fetcher' | 'now' | 'secretKey'>
  | Omit<OidcXidClientOptions, 'fetcher' | 'now' | 'tokenCache'>

// browser 进 head-inline;其余经 server-only virtual module 注入 middleware。
export type XidIntegrationOptions = {
  browser?: XidIntegrationBrowserOptions
  jwtKey?: SerializableJwtKey
  issuer?: string
  authorizedParties?: readonly string[]
  jwtCookieName?: string
  sessionTokenExchange?: XidIntegrationSessionTokenExchangeOptions
  protectedRoutes?: readonly string[]
  signInUrl?: string
  publicRoutes?: readonly string[]
}

export type XidServerClientOptions = {
  secretKey: string
  apiUrl?: string
  fetcher?: typeof fetch
}

export type PaginatedResponse<T> = {
  data: readonly T[]
  totalCount: number
  hasNextPage: boolean
  nextCursor: string | null
}
