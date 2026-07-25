// authenticateRequest:从 Request 提取 token(Authorization header 或 session cookie)并验证(见 06 章 6、api-sdk-conventions rule)。
// 检查 Authorization: Bearer 优先,其次 cookie;验 JWT 签名/exp/azp(委托 verifyToken,networkless)。
// 返回判别联合 RequestState:isSignedIn=true 携带 userId/sessionId/claims;false 携带未认证原因。

import type { AccessTokenClaims } from '@xid-kit/types'

import type { JwtKey } from './jwks'
import type { VerifyTokenError } from './verify-token'
import { verifyToken } from './verify-token'

const DEFAULT_COOKIE_NAME = '__session'
const BEARER_PREFIX = 'Bearer '

export type AuthenticateRequestOptions = {
  jwtKey: JwtKey
  issuer?: string
  audience?: string
  authorizedParties?: readonly string[]
  clockToleranceSec?: number
  now?: number
  // session cookie 名,默认 __session(对齐 Clerk 约定)。
  cookieName?: string
}

// 已认证态:携带从 claims 提取的 userId(sub)/sessionId(sid)与完整 claims。
export type SignedInState = {
  isSignedIn: true
  userId: string
  sessionId: string | undefined
  claims: AccessTokenClaims
}

// 未认证态:reason=no_token(无凭证)或具体验证失败原因(签名/过期/azp 等)。
export type SignedOutState = {
  isSignedIn: false
  reason: 'no_token' | VerifyTokenError
}

export type RequestState = SignedInState | SignedOutState

// 从 Authorization header 取 Bearer token(大小写不敏感 header,值前缀精确匹配)。
function tokenFromHeader(request: Request): string | undefined {
  const header = request.headers.get('authorization')
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    return undefined
  }
  const token = header.slice(BEARER_PREFIX.length).trim()
  return token.length > 0 ? token : undefined
}

// 从 Cookie header 取指定 session cookie(不依赖运行时 cookie API,手解析 Web 标准 Cookie header)。
function tokenFromCookie(request: Request, cookieName: string): string | undefined {
  const cookieHeader = request.headers.get('cookie')
  if (!cookieHeader) {
    return undefined
  }
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) {
      continue
    }
    if (part.slice(0, eq).trim() === cookieName) {
      const value = part.slice(eq + 1).trim()
      return value.length > 0 ? decodeURIComponent(value) : undefined
    }
  }
  return undefined
}

// 检查 Request 认证态:header 优先,cookie 兜底;无 token 返回 no_token,有则 networkless 验证。
export async function authenticateRequest(
  request: Request,
  options: AuthenticateRequestOptions,
): Promise<RequestState> {
  const cookieName = options.cookieName ?? DEFAULT_COOKIE_NAME
  const token = tokenFromHeader(request) ?? tokenFromCookie(request, cookieName)
  if (!token) {
    return { isSignedIn: false, reason: 'no_token' }
  }

  const result = await verifyToken(token, {
    jwtKey: options.jwtKey,
    issuer: options.issuer,
    audience: options.audience,
    authorizedParties: options.authorizedParties,
    clockToleranceSec: options.clockToleranceSec,
    now: options.now,
  })
  if (!result.ok) {
    return { isSignedIn: false, reason: result.error }
  }

  const claims = result.value
  return {
    isSignedIn: true,
    userId: claims.sub,
    sessionId: typeof claims.sid === 'string' ? claims.sid : undefined,
    claims,
  }
}
