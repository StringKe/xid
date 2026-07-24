// createXidServerMiddleware:Nuxt server middleware(H3 event handler)。
// 职责:从请求提取并验证 JWT,将 AuthResult 注入 event.context.xidAuth。
// 参照 @xid-kit/nextjs xidMiddleware 语义,但使用 H3/Nitro API。
// 依赖 @xid-kit/backend authenticateRequest(networkless JWT 验证)。
//
// 安全铁律:event.context.xidAuth 只在服务端 Nitro handler 可见,不会下发给客户端。
// 生产配置中须保证:
//   1) 此 middleware 注册为全局 server middleware(覆盖所有 Nitro routes);
//   2) 部署边界剥离客户端传入的 x-xid-auth 等伪造头。

import { authenticateRequest, type JwtKey } from '@xid-kit/backend'

import type { AuthResult, H3Event } from './types'
import { XID_AUTH_CONTEXT_KEY } from './types'

const UNAUTHENTICATED: AuthResult = {
  userId: null,
  sessionId: null,
  orgId: null,
  orgRole: null,
  orgPermissions: null,
  claims: null,
}

export type XidServerMiddlewareOptions = {
  // JWKS 公钥:networkless 验签所需(JwtKey = PublicJwk | PublicJwk[])。
  jwtKey: JwtKey
  // 期望 issuer。
  issuer?: string
  // 授权方白名单(azp 校验)。
  authorizedParties?: readonly string[]
  // session cookie 名;默认 __session。
  cookieName?: string
  // 受保护路由前缀列表;匹配且未登录则返回 401。
  protectedRoutes?: readonly string[]
  // 自定义保护响应:返回 non-null 可短路 default 401 处理。
  onUnauthenticated?: (event: H3Event) => { statusCode: number; message: string } | null
}

// 把 H3 event 适配为标准 Request(authenticateRequest 接受标准 Request)。
function toWebRequest(event: H3Event): Request {
  // 优先取 event.headers(Nuxt 3.9+ H3 unified request),回退到 node.req.headers。
  const headers = new Headers()
  if (event.headers) {
    // event.headers 是 Headers 实例时直接用。
    event.headers.forEach((value, key) => {
      headers.set(key, value)
    })
  } else {
    const rawHeaders = event.node.req.headers
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (value === undefined) continue
      headers.set(key, Array.isArray(value) ? value.join(', ') : value)
    }
  }

  // Nitro/H3 提供的 URL 可能是相对路径;补全为绝对 URL 供 authenticateRequest 使用。
  const rawUrl = event.node.req.url ?? '/'
  const url = rawUrl.startsWith('http') ? rawUrl : `https://localhost${rawUrl}`

  return new Request(url, { method: event.method ?? 'GET', headers })
}

// createXidServerMiddleware:工厂函数,返回 H3 event handler。
// 用法:
//   // server/middleware/xid.ts
//   import { createXidServerMiddleware } from '@xid-kit/nuxt'
//   export default createXidServerMiddleware({ jwtKey: { ... } })
export function createXidServerMiddleware(options: XidServerMiddlewareOptions) {
  const {
    jwtKey,
    issuer,
    authorizedParties,
    cookieName,
    protectedRoutes = [],
    onUnauthenticated,
  } = options

  return async function xidEventHandler(event: H3Event): Promise<void | Response> {
    const webReq = toWebRequest(event)
    const requestState = await authenticateRequest(webReq, {
      jwtKey,
      ...(issuer ? { issuer } : {}),
      ...(authorizedParties ? { authorizedParties } : {}),
      ...(cookieName ? { cookieName } : {}),
    })

    let authResult: AuthResult
    if (requestState.isSignedIn) {
      const { claims } = requestState
      authResult = {
        userId: requestState.userId,
        sessionId: requestState.sessionId,
        orgId: typeof claims['active_org_id'] === 'string' ? claims['active_org_id'] : undefined,
        orgRole: typeof claims['org_role'] === 'string' ? claims['org_role'] : undefined,
        orgPermissions: Array.isArray(claims['org_permissions'])
          ? (claims['org_permissions'] as string[])
          : undefined,
        claims,
      }
    } else {
      authResult = UNAUTHENTICATED
    }

    // 注入认证结果到 event.context.xidAuth(服务端专属,不下发客户端)。
    event.context[XID_AUTH_CONTEXT_KEY] = authResult

    // 路由保护:匹配受保护路由且未认证 -> 401。
    const pathname = new URL(webReq.url).pathname
    const isProtected =
      protectedRoutes.length > 0 && protectedRoutes.some((prefix) => pathname.startsWith(prefix))

    if (isProtected && !requestState.isSignedIn) {
      if (onUnauthenticated) {
        const custom = onUnauthenticated(event)
        if (custom) {
          return new Response(JSON.stringify({ error: custom.message }), {
            status: custom.statusCode,
            headers: { 'content-type': 'application/json' },
          })
        }
      }
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }
  }
}

// getXidAuth:从 event.context 读取 middleware 注入的 AuthResult。
// 供 server routes / defineEventHandler 快速访问。
export function getXidAuth(event: H3Event): AuthResult {
  return (event.context[XID_AUTH_CONTEXT_KEY] as AuthResult | undefined) ?? UNAUTHENTICATED
}
