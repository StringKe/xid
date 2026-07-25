// xidMiddleware:Astro SSR middleware,调用 @xid-kit/backend authenticateRequest,
// 把认证结果注入 locals.xidAuth,支持路由保护重定向。
//
// 安全模型:locals 是 Astro 服务端私有作用域,不暴露给客户端。
// session token 存 HttpOnly cookie,middleware 只验签并把只读视图写 locals。

import { authenticateRequest } from '@xid-kit/backend'
import type { AccessTokenClaims } from '@xid-kit/types'

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
  orgRole: string | undefined
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
    cookieName,
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
      ...(cookieName ? { cookieName } : {}),
    })

    let authResult: AuthResult
    if (requestState.isSignedIn) {
      const { claims } = requestState
      // active_org_id / org_role / org_permissions are typed optional fields on AccessTokenClaims.
      const orgId = typeof claims.active_org_id === 'string' ? claims.active_org_id : undefined
      const orgRole = typeof claims.org_role === 'string' ? claims.org_role : undefined
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

// onRequest: Astro-required named export for middleware entrypoints.
// This no-op pass-through satisfies the addMiddleware entrypoint contract when consumers
// rely on xidIntegration but have not configured jwtKey (authentication is skipped).
// Consumers who need JWT verification should use createXidMiddleware in their own
// src/middleware.ts and not depend on this default export.
export const onRequest: AstroMiddlewareHandler = (_context, next) => next()
