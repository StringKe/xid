// xidMiddleware:Astro SSR middleware,调用 @xid-kit/backend authenticateRequest,
// 把认证结果注入 locals.xidAuth,支持路由保护重定向。
//
// 安全模型:locals 是 Astro 服务端私有作用域,不暴露给客户端。
// short-lived JWT 来自 Bearer、应用自有 JWT cookie,或显式同源 Core cookie-to-JWT exchange。
// Core __Host-xid.rt.* 是 opaque refresh token,本 middleware 永不本地验证它。

import { authenticateRequest } from '@xid-kit/backend'
import {
  isOrganizationMembershipRole,
  type AccessTokenClaims,
  type OrganizationMembershipRole,
} from '@xid-kit/types'

import type { AuthResult, XidMiddlewareOptions } from './types'

// Astro middleware 类型契约(peer dep,运行时由 astro:middleware 提供)。
// 用局部类型声明避免在 library bundle 强依赖 astro 包全量。
type AstroLocals = Record<string, unknown>

type AstroAPIContext = {
  request: Request
  url: URL
  locals: AstroLocals
}

type MiddlewareNext = () => Promise<Response>

export type AstroMiddlewareHandler = (
  context: AstroAPIContext,
  next: MiddlewareNext,
) => Promise<Response>

const UNAUTHENTICATED: AuthResult = {
  userId: null,
  sessionId: null,
  orgId: null,
  orgRole: null,
  orgPermissions: null,
  claims: null,
}

type SignedInFields = {
  userId: string
  sessionId: string | undefined
  claims: AccessTokenClaims
  orgId: string | undefined
  orgRole: OrganizationMembershipRole | undefined
  orgPermissions: string[] | undefined
}

// 把 SignedInFields 映射为 AuthResult(Astro 版,直接注入 locals)。
function toAuthResult(fields: SignedInFields): AuthResult {
  return {
    userId: fields.userId,
    sessionId: fields.sessionId,
    orgId: fields.orgId,
    orgRole: fields.orgRole,
    orgPermissions: fields.orgPermissions,
    claims: fields.claims,
  }
}

// createXidMiddleware: returns an Astro onRequest middleware handler.
// Usage in src/middleware.ts:
//   import { sequence } from 'astro:middleware'
//   import { createXidMiddleware } from '@xid-kit/astro'
//   export const onRequest = sequence(createXidMiddleware({ jwtKey: ... }))
export function createXidMiddleware(options: XidMiddlewareOptions): AstroMiddlewareHandler {
  const {
    jwtKey,
    issuer,
    authorizedParties,
    jwtCookieName,
    sessionTokenExchange,
    protectedRoutes = [],
    signInUrl = '/sign-in',
    publicRoutes = [],
  } = options

  return async function xidMiddleware(
    context: AstroAPIContext,
    next: MiddlewareNext,
  ): Promise<Response> {
    const requestState = await authenticateRequest(context.request, {
      jwtKey,
      ...(issuer ? { issuer } : {}),
      ...(authorizedParties ? { authorizedParties } : {}),
      ...(jwtCookieName ? { jwtCookieName } : {}),
      ...(sessionTokenExchange ? { sessionTokenExchange } : {}),
    })

    let authResult: AuthResult
    if (requestState.isSignedIn) {
      const { claims } = requestState
      // active_org_id / org_role / org_permissions are typed optional fields on AccessTokenClaims.
      const orgId = typeof claims.active_org_id === 'string' ? claims.active_org_id : undefined
      const orgRole = isOrganizationMembershipRole(claims.org_role) ? claims.org_role : undefined
      const orgPermissions = Array.isArray(claims.org_permissions)
        ? (claims.org_permissions as string[])
        : undefined

      authResult = toAuthResult({
        userId: requestState.userId,
        sessionId: requestState.sessionId,
        claims,
        orgId,
        orgRole,
        orgPermissions,
      })
    } else {
      authResult = UNAUTHENTICATED
    }

    // 注入 locals.xidAuth。
    context.locals['xidAuth'] = authResult

    const pathname = context.url.pathname

    // 路由保护:受保护路径 + 未认证 + 非公开路径 -> 302 到 signInUrl。
    const isProtected =
      protectedRoutes.length > 0 &&
      protectedRoutes.some((prefix) => pathname.startsWith(prefix)) &&
      !publicRoutes.some((prefix) => pathname.startsWith(prefix))

    if (isProtected && !requestState.isSignedIn) {
      const redirectUrl = new URL(signInUrl, context.request.url)
      redirectUrl.searchParams.set('redirect_url', context.request.url)
      return Response.redirect(redirectUrl.toString(), 302)
    }

    return next()
  }
}
