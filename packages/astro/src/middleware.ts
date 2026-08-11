// Astro SSR middleware:认证结果写入 locals.xidAuth。
// locals 仅服务端可见;JWT 来自 Bearer / 应用 JWT cookie / 显式同源 exchange。
// 永不本地验证 Core __Host-xid.rt.* opaque refresh token。

import { authenticateRequest } from '@xid-kit/backend'
import {
  isOrganizationMembershipRole,
  type AccessTokenClaims,
  type OrganizationMembershipRole,
} from '@xid-kit/types'

import type { AuthResult, XidMiddlewareOptions } from './types'

// 局部类型契约,避免 library bundle 强依赖 astro 全量。
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

    context.locals['xidAuth'] = authResult

    const pathname = context.url.pathname

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
