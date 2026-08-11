import type { AccessTokenClaims, OrganizationMembershipRole } from '@xid-kit/types'
import type { OidcXidClientOptions, SameOriginXidClientOptions } from '@xid-kit/core'

export const XID_AUTH_CONTEXT_KEY = 'xidAuth' as const

export type AuthObject = {
  userId: string
  sessionId: string | undefined
  orgId: string | undefined
  orgRole: OrganizationMembershipRole | undefined
  orgPermissions: readonly string[] | undefined
  claims: AccessTokenClaims
}

// userId=null 表示未登录，便于 if (auth.userId) 类型收窄。
export type UnauthenticatedAuthObject = {
  userId: null
  sessionId: null
  orgId: null
  orgRole: null
  orgPermissions: null
  claims: null
}

export type AuthResult = AuthObject | UnauthenticatedAuthObject

export type XidNuxtBrowserOptions =
  | Omit<SameOriginXidClientOptions, 'fetcher' | 'now' | 'secretKey'>
  | Omit<OidcXidClientOptions, 'fetcher' | 'now' | 'tokenCache'>

export type XidNuxtModuleOptions = {
  // 跨域用 oidc + clientId；同源反代可用 same-origin。
  browser?: XidNuxtBrowserOptions
  // 旧同源配置兼容；须为相对 URL 或 exact same-origin，与 browser 互斥。
  apiUrl?: string
  // 缺省则 server middleware 不验签。
  jwtKey?: string
  issuer?: string
  protectedRoutes?: readonly string[]
  signInUrl?: string
  // 应用侧 short-lived JWT cookie 名；无默认值。
  jwtCookieName?: string
  sessionTokenEndpoint?: string
}

// 最小 H3Event 形状：由宿主 nuxt/h3 提供，避免 import h3 拖入全量 bundle。
export type H3EventContext = {
  [XID_AUTH_CONTEXT_KEY]?: AuthResult
  [key: string]: unknown
}

export type H3Event = {
  context: H3EventContext
  // H3 v2 web-standard 字段。
  req?: unknown
  url?: unknown
  // H3 v1 web adapter；Node adapter 可能缺省。
  web?: {
    request?: Request
    url?: URL
  }
  node: {
    req: {
      headers: Record<string, string | string[] | undefined>
      url?: string
    }
  }
  headers?: Headers | undefined
  method?: string
}
