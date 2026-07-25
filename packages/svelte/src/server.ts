// server.ts:SvelteKit server hooks helper(对标 @xid-kit/nextjs xidMiddleware / auth 语义)。
// handleXid:SvelteKit handle 钩子,在 +hooks.server.ts 中使用。
// getXidAuth:在 +page.server.ts / +layout.server.ts 的 load 函数中读取认证态。
//
// 安全模型:
//   1) 部署边界必须剥离客户端传入的 x-xid-auth,只允许 handleXid 内部注入。
//   2) 认证态存入 event.locals[localsKey],在 load 函数中通过 getXidAuth(event.locals) 读取。
//
// peerDep:@sveltejs/kit >= 2.0.0(可选);@xid-kit/backend(动态 import)。

import type { AccessTokenClaims } from '@xid-kit/types'

import type { AuthResult } from './types'

export { XID_AUTH_HEADER } from './types'

// SvelteKit event / resolve 最小契约(不直接 import @sveltejs/kit)。
type MinimalEvent = {
  request: Request
  url: URL
  locals: Record<string, unknown>
}
type ResolveFn = (event: MinimalEvent) => Promise<Response> | Response

// @xid-kit/backend RequestState 的结构最小镜像(避免静态 import)。
// SignedInState: { isSignedIn: true, userId, sessionId?, claims: AccessTokenClaims }
// SignedOutState: { isSignedIn: false, reason }
type BackendRequestState =
  | {
      isSignedIn: true
      userId: string
      sessionId?: string
      claims: Record<string, unknown>
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
    cookieName?: string
  },
) => Promise<BackendRequestState>

export type HandleXidOptions = {
  // JWKS 公钥(必填) -- 格式同 @xid-kit/backend JwtKey。
  // 通常从 process.env.XID_JWT_KEY 读取后 JSON.parse。
  jwtKey: unknown
  issuer?: string
  authorizedParties?: readonly string[]
  cookieName?: string
  // 受保护路由 pathname 前缀;匹配且未登录则 302 到 signInUrl。
  protectedRoutes?: readonly string[]
  signInUrl?: string
  // 公开路由:matcher 也覆盖时排除。
  publicRoutes?: readonly string[]
  // event.locals 注入 key;默认 'xidAuth'。
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
    orgRole: typeof c['org_role'] === 'string' ? c['org_role'] : null,
    orgPermissions: Array.isArray(c['org_permissions']) ? (c['org_permissions'] as string[]) : null,
    // BackendRequestState.claims is Record<string,unknown>; the actual runtime shape is AccessTokenClaims.
    // Cast via unknown to satisfy the discriminated union branch for AuthObject.
    claims: c as unknown as AccessTokenClaims,
  }
}

const XID_AUTH_HEADER_NAME = 'x-xid-auth'

// handleXid:SvelteKit handle 工厂。
// 用法(src/hooks.server.ts):
//   import { handleXid } from '@xid-kit/svelte/server'
//   export const handle = handleXid({ jwtKey: JSON.parse(process.env.XID_JWT_KEY!) })
export function handleXid(options: HandleXidOptions) {
  const {
    jwtKey,
    issuer,
    authorizedParties,
    cookieName,
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

    // 动态 import 避免库 bundle 静态引入 @xid-kit/backend。
    const backendMod = (await import('@xid-kit/backend')) as {
      authenticateRequest: AuthenticateRequestFn
    }
    const { authenticateRequest } = backendMod

    // 剥离客户端可能伪造的 x-xid-auth header。
    const cleanHeaders = new Headers(event.request.headers)
    cleanHeaders.delete(XID_AUTH_HEADER_NAME)
    const cleanRequest = new Request(event.request, { headers: cleanHeaders })

    const requestState = await authenticateRequest(cleanRequest, {
      jwtKey,
      ...(issuer ? { issuer } : {}),
      ...(authorizedParties ? { authorizedParties } : {}),
      ...(cookieName ? { cookieName } : {}),
    })

    const authResult = buildAuthResult(requestState)

    // 存入 event.locals,下游 load 函数通过 getXidAuth 读取。
    event.locals[localsKey] = authResult

    // 路由保护。
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

// getXidAuth:从 event.locals 读取 handleXid 注入的认证态。
// 未找到(例如未在 handleXid 子树内)时返回未认证对象,不 throw。
// 用法(+page.server.ts):
//   import { getXidAuth } from '@xid-kit/svelte/server'
//   export const load = async ({ locals }) => {
//     const auth = getXidAuth(locals)
//     if (!auth.userId) throw redirect(303, '/sign-in')
//   }
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
