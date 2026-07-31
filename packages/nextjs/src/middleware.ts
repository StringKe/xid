// xidMiddleware:Next.js Edge 中间件适配(对标 @clerk/nextjs clerkMiddleware)。
// 职责:读 auth 状态(authenticateRequest networkless),把认证态注入到下游 request headers(x-xid-auth),
// 支持路由保护与 locale 设置。运行在 Edge Runtime,不访问 Node.js API。见 docs/design/06-developer-experience.md。
//
// 安全铁律:x-xid-auth 携带完整 JWT claims,只能在服务端内部从 middleware 透传到 RSC/route handler,
//   绝不能出现在发回浏览器的响应头里。本实现用 NextResponse.next({ request: { headers } }) 注入,
//   该 API 让修改后的 headers 只对下游服务端生效,不写回响应。
//   配套要求:(1) middleware matcher 必须覆盖所有受保护路由;(2) 部署边界必须剥离客户端传入的
//   x-xid-auth(防止外部伪造);(3) 生产配置 XID_AUTH_HMAC_SECRET 开启签名校验(见 auth-header.ts)。

import { authenticateRequest } from '@xid-kit/backend'
import type { JwtKey, SessionTokenExchangeOptions } from '@xid-kit/backend'
import { isOrganizationMembershipRole } from '@xid-kit/types'

import { resolveAuthSecret, serializeAuthHeader } from './auth-header'
import type { AuthResult } from './types'
import { XID_AUTH_HEADER } from './types'

// Next.js NextRequest/NextResponse 类型声明(peer dep,运行时由 next 提供)。
// 避免 import 导致 bundle 引入 next 全量,这里只用类型。
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

// next/server NextResponse 静态接口的最小契约(peer dep,运行时由 next 提供)。
// next() 透传修改后的 request headers 到下游服务端,不写回响应;redirect 生成 302。
type NextResponseStatic = {
  next: (init?: { request?: { headers?: Headers } }) => NextResponse
  redirect: (url: string | URL, init?: number | { status?: number }) => NextResponse
}

type NextMiddlewareResult = Response | null | undefined

// 动态 import next/server,仅取 NextResponse 静态对象。
// 用动态 import 避免在 library bundle 硬引入 next 全量(peer dep 由消费者提供)。
async function getNextResponse(): Promise<NextResponseStatic> {
  const mod = (await import('next/server')) as unknown as { NextResponse: NextResponseStatic }
  return mod.NextResponse
}

// locale 检测策略:?locale= query param -> Accept-Language header -> fallback。
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
      // 宽松匹配:zh-Hans 匹配 zh-Hans-CN。
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
  // JWKS 公钥(必填):networkless 验签所需,从 process.env 或 server 初始化时传入。
  jwtKey: JwtKey
  // 期望 issuer(多租户:https://{tenant}.xid.dev)。
  issuer?: string
  // 授权方白名单(azp 校验,见 oidc-oauth rule)。
  authorizedParties?: readonly string[]
  // 受保护路由 pathname 前缀列表;匹配且未登录则 302 到 signInUrl。
  protectedRoutes?: readonly string[]
  // 登录页路径;未认证访问受保护路由时重定向。默认 /sign-in。
  signInUrl?: string
  // 公开路由:matcher 也覆盖时排除。
  publicRoutes?: readonly string[]
  // 支持的 locale 列表(i18n,见 i18n-lingui rule 07 章)。
  supportedLocales?: readonly string[]
  // fallback locale;默认 en。
  defaultLocale?: string
  // 应用自己持有的 short-lived JWT cookie。Core 的 opaque refresh cookie 不得填在这里。
  jwtCookieName?: string
  // 同源 Core cookie -> short-lived JWT exchange。endpoint 必须与当前请求 exact same-origin。
  sessionTokenExchange?: SessionTokenExchangeOptions
  // 注入自定义 handler(在认证后执行);返回 Response 可短路。
  afterAuth?: (auth: AuthResult, request: NextRequest) => Response | null | undefined | void
  // x-xid-auth HMAC 签名 secret(纵深防御,见 auth-header.ts)。
  // 缺省读 process.env.XID_AUTH_HMAC_SECRET;两端(middleware 与 server context)必须一致。
  authHeaderSecret?: string
}

// 把 NextRequest 适配为标准 Request(authenticateRequest 接受标准 Request)。
function toWebRequest(req: NextRequest): Request {
  // Edge middleware 的 NextRequest 继承 Request,直接 cast。
  return req as unknown as Request
}

// xidMiddleware 工厂:返回 Next.js middleware 函数。
// 用法:export default xidMiddleware({ jwtKey: ... })
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

    // afterAuth 钩子:允许调用方短路返回自定义 Response。
    if (afterAuth) {
      const custom = afterAuth(authResult, request)
      if (custom) return custom
    }

    const pathname = request.nextUrl.pathname

    // 路由保护:匹配受保护路由且未认证 -> 302 到 signInUrl(携带 redirectUrl)。
    const isProtected =
      protectedRoutes.length > 0 &&
      protectedRoutes.some((prefix) => pathname.startsWith(prefix)) &&
      !publicRoutes.some((prefix) => pathname.startsWith(prefix))

    if (isProtected && !requestState.isSignedIn) {
      const redirectUrl = new URL(signInUrl, request.url)
      redirectUrl.searchParams.set('redirect_url', request.url)
      return NextResponse.redirect(redirectUrl.toString(), 302)
    }

    // 克隆请求头,剥离任何客户端传入的 x-xid-auth(防伪造),再注入 middleware 可信认证态与 locale。
    const requestHeaders = new Headers(request.headers)
    requestHeaders.delete(XID_AUTH_HEADER)
    requestHeaders.set(XID_AUTH_HEADER, await serializeAuthHeader(authResult, secret))

    if (supportedLocales && supportedLocales.length > 0) {
      const locale = detectLocale(request, supportedLocales, defaultLocale)
      requestHeaders.set('x-xid-locale', locale)
    }

    // NextResponse.next({ request: { headers } }):修改后的 headers 只透传到下游服务端(RSC / route handler),
    // 绝不写回浏览器响应头 -- 这是防止 x-xid-auth(含完整 claims)泄露给客户端的关键。
    return NextResponse.next({ request: { headers: requestHeaders } })
  }
}
