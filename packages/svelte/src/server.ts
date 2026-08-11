// SvelteKit handle/load 认证桥接，对标 @xid-kit/nextjs xidMiddleware。
// 安全：剥离客户端传入的 x-xid-auth，仅允许 handle 内注入后写入 locals。

import { isOrganizationMembershipRole, type AccessTokenClaims } from '@xid-kit/types'

import type { AuthResult } from './types'

export { XID_AUTH_HEADER } from './types'

// 不直接 import @sveltejs/kit，保持 peer 可选。
type MinimalEvent = {
  request: Request
  url: URL
  locals: Record<string, unknown>
}
type ResolveFn = (event: MinimalEvent) => Promise<Response> | Response

// 结构镜像，避免静态 import @xid-kit/backend。
type BackendRequestState =
  | {
      isSignedIn: true
      userId: string
      sessionId?: string
      claims: AccessTokenClaims
    }
  | {
      isSignedIn: false
      reason?: string
    }

type AuthenticateRequestFn = (
  req: Request,
  opts: {
    jwtKey: unknown
    issuer?: string
    authorizedParties?: readonly string[]
    jwtCookieName?: string
    sessionTokenExchange?: {
      endpoint?: string
      fetcher?: typeof fetch
      signal?: AbortSignal
    }
  },
) => Promise<BackendRequestState>

export type HandleXidOptions = {
  // 同 @xid-kit/backend JwtKey；通常 JSON.parse(process.env.XID_JWT_KEY)
  jwtKey: unknown
  issuer?: string
  authorizedParties?: readonly string[]
  // 应用侧 short-lived JWT cookie，无库内默认名
  jwtCookieName?: string
  // 同源 Core opaque cookie 换 short-lived JWT
  sessionTokenExchange?: {
    endpoint?: string
    fetcher?: typeof fetch
    signal?: AbortSignal
  }
  // pathname 前缀命中且未登录则 302
  protectedRoutes?: readonly string[]
  signInUrl?: string
  // protected 命中时仍放行
  publicRoutes?: readonly string[]
  localsKey?: string
}

function buildAuthResult(rs: BackendRequestState): AuthResult {
  if (!rs.isSignedIn) {
    return {
      userId: null,
      sessionId: null,
      orgId: null,
      orgRole: null,
      orgPermissions: null,
      claims: null,
    }
  }
  const c = rs.claims
  return {
    userId: rs.userId,
    sessionId: rs.sessionId ?? null,
    orgId: typeof c['active_org_id'] === 'string' ? c['active_org_id'] : null,
    orgRole: isOrganizationMembershipRole(c.org_role) ? c.org_role : null,
    orgPermissions: Array.isArray(c['org_permissions']) ? (c['org_permissions'] as string[]) : null,
    claims: c,
  }
}

const XID_AUTH_HEADER_NAME = 'x-xid-auth'

export function handleXid(options: HandleXidOptions) {
  const {
    jwtKey,
    issuer,
    authorizedParties,
    jwtCookieName,
    sessionTokenExchange,
    protectedRoutes = [],
    signInUrl = '/sign-in',
    publicRoutes = [],
    localsKey = 'xidAuth',
  } = options

  return async function handle(input: {
    event: MinimalEvent
    resolve: ResolveFn
  }): Promise<Response> {
    const { event, resolve } = input

    // 动态 import，避免库 bundle 静态拉入 @xid-kit/backend
    const backendMod = (await import('@xid-kit/backend')) as {
      authenticateRequest: AuthenticateRequestFn
    }
    const { authenticateRequest } = backendMod

    // 剥离客户端可能伪造的 x-xid-auth
    const cleanHeaders = new Headers(event.request.headers)
    cleanHeaders.delete(XID_AUTH_HEADER_NAME)
    const cleanRequest = new Request(event.request, { headers: cleanHeaders })

    const requestState = await authenticateRequest(cleanRequest, {
      jwtKey,
      ...(issuer ? { issuer } : {}),
      ...(authorizedParties ? { authorizedParties } : {}),
      ...(jwtCookieName ? { jwtCookieName } : {}),
      ...(sessionTokenExchange ? { sessionTokenExchange } : {}),
    })

    const authResult = buildAuthResult(requestState)

    event.locals[localsKey] = authResult

    const { pathname } = event.url
    const isProtected =
      protectedRoutes.length > 0 &&
      protectedRoutes.some((prefix) => pathname.startsWith(prefix)) &&
      !publicRoutes.some((prefix) => pathname.startsWith(prefix))

    if (isProtected && !requestState.isSignedIn) {
      const target = new URL(signInUrl, event.url)
      target.searchParams.set('redirect_url', event.url.toString())
      return Response.redirect(target.toString(), 302)
    }

    return resolve(event)
  }
}

// 未注入时返回未认证对象，不 throw
export function getXidAuth(locals: Record<string, unknown>, localsKey = 'xidAuth'): AuthResult {
  const auth = locals[localsKey]
  if (isAuthResult(auth)) return auth
  return {
    userId: null,
    sessionId: null,
    orgId: null,
    orgRole: null,
    orgPermissions: null,
    claims: null,
  }
}

function isAuthResult(v: unknown): v is AuthResult {
  return typeof v === 'object' && v !== null && 'userId' in v
}
