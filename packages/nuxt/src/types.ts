// @xid-kit/nuxt 内部类型:Nuxt 适配层公共契约。
// 对标 @xid-kit/nextjs 的 AuthResult 模型,但用于 Nuxt/H3 event context。

import type { AccessTokenClaims, OrganizationMembershipRole } from '@xid-kit/types'
import type { OidcXidClientOptions, SameOriginXidClientOptions } from '@xid-kit/core'

// 认证结果注入到 H3 event.context 时使用的键。
export const XID_AUTH_CONTEXT_KEY = 'xidAuth' as const

// 已认证态:来自 JWT claims 的核心字段,供 server route/API handler 快速访问。
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

// XidNuxtModuleOptions:nuxt.config.ts 中的配置项。
export type XidNuxtBrowserOptions =
  | Omit<SameOriginXidClientOptions, 'fetcher' | 'now' | 'secretKey'>
  | Omit<OidcXidClientOptions, 'fetcher' | 'now' | 'tokenCache'>

export type XidNuxtModuleOptions = {
  // 跨域开发者应用使用 oidc + clientId；同源反向代理可使用 same-origin。
  browser?: XidNuxtBrowserOptions
  // 兼容旧同源配置；只能是相对 URL 或当前页面 exact same-origin,与 browser 互斥。
  apiUrl?: string
  // server middleware 所需 JWKS 公钥;不填则 server middleware 跳过验签。
  jwtKey?: string
  // 期望 issuer(多租户:https://{tenant}.xid.dev)。
  issuer?: string
  // 受保护路由前缀列表(Nitro server routes 路径,如 ['/api/admin'])。
  protectedRoutes?: readonly string[]
  // 登录页路径;未认证访问受保护路由时重定向;默认 /sign-in。
  signInUrl?: string
  // 应用自己持有的 short-lived JWT cookie。无默认值。
  jwtCookieName?: string
  // 同源 Core session-token endpoint;例如 /v1/sessions/token。
  sessionTokenEndpoint?: string
}

// H3 event 最小类型声明(h3 peer dep,运行时由 nuxt/h3 提供)。
// 避免 import 导致 bundle 引入 h3 全量。
export type H3EventContext = {
  [XID_AUTH_CONTEXT_KEY]?: AuthResult
  [key: string]: unknown
}

export type H3Event = {
  context: H3EventContext
  // H3 v2 web-standard request and parsed URL.
  req?: unknown
  url?: unknown
  // H3 v1 web adapter context. Node adapters may leave this absent.
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
