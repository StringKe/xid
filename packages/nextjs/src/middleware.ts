// Edge 中间件：networkless 验签后把 AuthResult 注入下游 request 的 x-xid-auth，并做路由保护 / locale。
// 安全：x-xid-auth 含完整 claims，必须用 NextResponse.next({ request: { headers } }) 只透传到服务端，
// 绝不能进浏览器响应；matcher 须覆盖受保护路由，部署边界剥离客户端该头，生产配 XID_AUTH_HMAC_SECRET。

import { authenticateRequest } from '@xid-kit/backend'
import type { JwtKey, SessionTokenExchangeOptions } from '@xid-kit/backend'
import { isOrganizationMembershipRole } from '@xid-kit/types'

import { resolveAuthSecret, serializeAuthHeader } from './auth-header'
import type { AuthResult } from './types'
import { XID_AUTH_HEADER } from './types'

// peer dep 类型契约，避免 import next 把全量打进 library bundle。
type NextRequest = {
  nextUrl: URL
  url: string
  headers: Headers
  cookies: { get: (name: string) => { value: string } | undefined }
  method: string
}

type NextResponse = Response & {
  headers: Headers
}

// next() 只改下游 request headers；redirect 生成 302。
type NextResponseStatic = {
  next: (init?: { request?: { headers?: Headers } }) => NextResponse
  redirect: (url: string | URL, init?: number | { status?: number }) => NextResponse
}

type NextMiddlewareResult = Response | null | undefined

async function getNextResponse(): Promise<NextResponseStatic> {
  const mod = (await import('next/server')) as unknown as { NextResponse: NextResponseStatic }
  return mod.NextResponse
}

// 优先级：?locale= -> Accept-Language -> fallback；Accept-Language 做语言前缀宽松匹配。
function detectLocale(
  request: NextRequest,
  supportedLocales: readonly string[],
  fallback: string,
): string {
  const qp = request.nextUrl.searchParams.get('locale')
  if (qp && supportedLocales.includes(qp)) return qp

  const acceptLang = request.headers.get('accept-language')
  if (acceptLang) {
    for (const part of acceptLang.split(',')) {
      const tag = part.split(';')[0]?.trim()
      if (!tag) continue
      if (supportedLocales.includes(tag)) return tag
      const base = tag.split('-')[0]
      if (base) {
        const found = supportedLocales.find((l) => l === base || l.startsWith(base + '-'))
        if (found) return found
      }
    }
  }
  return fallback
}

export type XidMiddlewareOptions = {
  // networkless 验签公钥（必填）。
  jwtKey: JwtKey
  issuer?: string
  authorizedParties?: readonly string[]
  // pathname 前缀；匹配且未登录则 302 到 signInUrl。
  protectedRoutes?: readonly string[]
  signInUrl?: string
  publicRoutes?: readonly string[]
  supportedLocales?: readonly string[]
  defaultLocale?: string
  // 应用 short-lived JWT cookie；Core 的 opaque refresh cookie 不得填这里。
  jwtCookieName?: string
  // 同源 Core cookie -> JWT exchange；endpoint 须与当前请求 exact same-origin。
  sessionTokenExchange?: SessionTokenExchangeOptions
  afterAuth?: (auth: AuthResult, request: NextRequest) => Response | null | undefined | void
  // 与 server context 共用的 HMAC secret；缺省读 XID_AUTH_HMAC_SECRET。
  authHeaderSecret?: string
}

function toWebRequest(req: NextRequest): Request {
  return req as unknown as Request
}

export function xidMiddleware(options: XidMiddlewareOptions) {
  const {
    jwtKey,
    issuer,
    authorizedParties,
    protectedRoutes = [],
    signInUrl = '/sign-in',
    publicRoutes = [],
    supportedLocales,
    defaultLocale = 'en',
    jwtCookieName,
    sessionTokenExchange,
    afterAuth,
    authHeaderSecret,
  } = options
  const secret = resolveAuthSecret(authHeaderSecret)

  return async function middleware(request: NextRequest): Promise<NextMiddlewareResult> {
    const NextResponse = await getNextResponse()
    const webReq = toWebRequest(request)
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
      authResult = {
        userId: null,
        sessionId: null,
        orgId: null,
        orgRole: null,
        orgPermissions: null,
        claims: null,
      }
    }

    if (afterAuth) {
      const custom = afterAuth(authResult, request)
      if (custom) return custom
    }

    const pathname = request.nextUrl.pathname

    const isProtected =
      protectedRoutes.length > 0 &&
      protectedRoutes.some((prefix) => pathname.startsWith(prefix)) &&
      !publicRoutes.some((prefix) => pathname.startsWith(prefix))

    if (isProtected && !requestState.isSignedIn) {
      const redirectUrl = new URL(signInUrl, request.url)
      redirectUrl.searchParams.set('redirect_url', request.url)
      return NextResponse.redirect(redirectUrl.toString(), 302)
    }

    // 先删客户端可能伪造的 x-xid-auth，再写入本中间件验签后的可信态。
    const requestHeaders = new Headers(request.headers)
    requestHeaders.delete(XID_AUTH_HEADER)
    requestHeaders.set(XID_AUTH_HEADER, await serializeAuthHeader(authResult, secret))

    if (supportedLocales && supportedLocales.length > 0) {
      const locale = detectLocale(request, supportedLocales, defaultLocale)
      requestHeaders.set('x-xid-locale', locale)
    }

    // request.headers 仅下游服务端可见，不会写回浏览器响应（防 claims 泄露）。
    return NextResponse.next({ request: { headers: requestHeaders } })
  }
}
