// JWT 验签结果写入 event.context.xidAuth（仅 Nitro 服务端可见）。
// 生产须全局注册本 middleware，并在部署边界剥离客户端伪造的 x-xid-auth 等头。

import {
  authenticateRequest,
  type JwtKey,
  type SessionTokenExchangeOptions,
} from '@xid-kit/backend'
import { isOrganizationMembershipRole } from '@xid-kit/types'

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
  jwtKey: JwtKey
  issuer?: string
  authorizedParties?: readonly string[]
  // 应用侧 short-lived JWT cookie 名；无默认值，须显式配置。
  jwtCookieName?: string
  // 同源 Core opaque cookie -> short-lived JWT exchange。
  sessionTokenExchange?: SessionTokenExchangeOptions
  // H3 v1 相对 URL 时的可信应用 origin；禁止用客户端可伪造的 forwarded host/proto 拼接。
  requestOrigin?: string
  protectedRoutes?: readonly string[]
  onUnauthenticated?: (event: H3Event) => { statusCode: number; message: string } | null
}

function normalizeRequestOrigin(value: string | undefined): URL | undefined {
  if (!value) return undefined
  const origin = new URL(value)
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new TypeError('requestOrigin must be an origin without credentials, path, query, or hash')
  }
  return origin
}

function webStandardRequest(event: H3Event): Request | undefined {
  if (event.req instanceof Request) return event.req
  if (event.web?.request instanceof Request) return event.web.request
  return undefined
}

function absoluteEventUrl(event: H3Event): URL | undefined {
  if (event.url instanceof URL) return event.url
  if (event.web?.url instanceof URL) return event.web.url

  const rawUrl = event.node.req.url
  if (!rawUrl) return undefined
  try {
    const parsed = new URL(rawUrl)
    return parsed
  } catch {
    return undefined
  }
}

function toWebRequest(
  event: H3Event,
  trustedOrigin: URL | undefined,
  requireTrustedOrigin: boolean,
): Request {
  const standardRequest = webStandardRequest(event)
  if (standardRequest) return standardRequest

  const headers = new Headers()
  if (event.headers) {
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

  // Nitro/H3 v1 Node 常只给相对 URL；同源 cookie exchange 不得信任 x-forwarded-*，须用配置的可信 origin。
  const rawUrl = event.node.req.url ?? '/'
  const absoluteUrl = absoluteEventUrl(event)
  if (!absoluteUrl && requireTrustedOrigin && !trustedOrigin) {
    throw new TypeError(
      'sessionTokenExchange on a relative H3 request requires requestOrigin or a web-standard Request URL',
    )
  }
  const url = absoluteUrl ?? new URL(rawUrl, trustedOrigin ?? new URL('https://localhost'))

  return new Request(url, { method: event.method ?? 'GET', headers })
}

export function createXidServerMiddleware(options: XidServerMiddlewareOptions) {
  const {
    jwtKey,
    issuer,
    authorizedParties,
    jwtCookieName,
    sessionTokenExchange,
    requestOrigin,
    protectedRoutes = [],
    onUnauthenticated,
  } = options
  const trustedOrigin = normalizeRequestOrigin(requestOrigin)

  return async function xidEventHandler(event: H3Event): Promise<void | Response> {
    const webReq = toWebRequest(event, trustedOrigin, sessionTokenExchange !== undefined)
    const requestState = await authenticateRequest(webReq, {
      jwtKey,
      ...(issuer ? { issuer } : {}),
      ...(authorizedParties ? { authorizedParties } : {}),
      ...(jwtCookieName ? { jwtCookieName } : {}),
      ...(sessionTokenExchange ? { sessionTokenExchange } : {}),
    })

    let authResult: AuthResult
    if (requestState.isSignedIn) {
      const { claims } = requestState
      authResult = {
        userId: requestState.userId,
        sessionId: requestState.sessionId,
        orgId: typeof claims['active_org_id'] === 'string' ? claims['active_org_id'] : undefined,
        orgRole: isOrganizationMembershipRole(claims.org_role) ? claims.org_role : undefined,
        orgPermissions: Array.isArray(claims['org_permissions'])
          ? (claims['org_permissions'] as string[])
          : undefined,
        claims,
      }
    } else {
      authResult = UNAUTHENTICATED
    }

    event.context[XID_AUTH_CONTEXT_KEY] = authResult

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

export function getXidAuth(event: H3Event): AuthResult {
  return (event.context[XID_AUTH_CONTEXT_KEY] as AuthResult | undefined) ?? UNAUTHENTICATED
}
