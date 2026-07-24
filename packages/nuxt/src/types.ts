// @xid-kit/nuxt 内部类型:Nuxt 适配层公共契约。
// 对标 @xid-kit/nextjs 的 AuthResult 模型,但用于 Nuxt/H3 event context。

import type { AccessTokenClaims } from '@xid-kit/types'

// XID_AUTH_CONTEXT_KEY:H3 event.context に注入认证结果的键。
export const XID_AUTH_CONTEXT_KEY = 'xidAuth' as const

// 已认证态:来自 JWT claims 的核心字段,供 server route/API handler 快速访问。
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

// XidNuxtModuleOptions:nuxt.config.ts 中的配置项。
export type XidNuxtModuleOptions = {
  // 客户端 publishable key(pk_live_xxx / pk_test_xxx)。
  publishableKey?: string
  // 认证 API 根,默认同域相对路径(自托管场景填绝对 URL)。
  apiUrl?: string
  // server middleware 所需 JWKS 公钥;不填则 server middleware 跳过验签。
  jwtKey?: string
  // 期望 issuer(多租户:https://{tenant}.xid.dev)。
  issuer?: string
  // 受保护路由前缀列表(Nitro server routes 路径,如 ['/api/admin'])。
  protectedRoutes?: readonly string[]
  // 登录页路径;未认证访问受保护路由时重定向;默认 /sign-in。
  signInUrl?: string
  // session cookie 名;默认 __session。
  cookieName?: string
}

// H3 event 最小类型声明(h3 peer dep,运行时由 nuxt/h3 提供)。
// 避免 import 导致 bundle 引入 h3 全量。
export type H3EventContext = {
  [XID_AUTH_CONTEXT_KEY]?: AuthResult
  [key: string]: unknown
}

export type H3Event = {
  context: H3EventContext
  node: {
    req: {
      headers: Record<string, string | string[] | undefined>
      url?: string
    }
  }
  headers?: Headers | undefined
  method?: string
}
