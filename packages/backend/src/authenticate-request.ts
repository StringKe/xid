// authenticateRequest:从 Request 提取短期 JWT 并验证(见 06 章 6、api-sdk-conventions rule)。
// 检查 Authorization: Bearer 优先,其次调用方显式声明的 JWT cookie,最后可选同源 Core
// session-token exchange。Core 的 __Host-xid.rt.* 是 opaque refresh token,永不在本地验签。
// 返回判别联合 RequestState:isSignedIn=true 携带 userId/sessionId/claims;false 携带未认证原因。

import type { AccessTokenClaims } from '@xid-kit/types'

import type { JwtKey } from './jwks'
import type {
  SessionTokenExchangeError,
  SessionTokenExchangeOptions,
} from './session-token-exchange'
import { exchangeSessionToken } from './session-token-exchange'
import type { VerifyTokenError } from './verify-token'
import { verifyToken } from './verify-token'

const BEARER_PREFIX = 'Bearer '

export type AuthenticateRequestOptions = {
  jwtKey: JwtKey
  issuer?: string
  audience?: string
  authorizedParties?: readonly string[]
  clockToleranceSec?: number
  now?: number
  // 应用自己持有的 short-lived JWT cookie。无默认值,避免把 Core opaque refresh cookie 当 JWT。
  jwtCookieName?: string
  // 可选同源 cookie -> JWT exchange。endpoint 必须解析到 request 的 exact origin。
  sessionTokenExchange?: SessionTokenExchangeOptions
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
  reason: 'no_token' | SessionTokenExchangeError | VerifyTokenError
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
  let token = tokenFromHeader(request)
  if (!token && options.jwtCookieName) {
    token = tokenFromCookie(request, options.jwtCookieName)
  }
  if (!token && options.sessionTokenExchange) {
    const exchanged = await exchangeSessionToken(request, options.sessionTokenExchange)
    if (!exchanged.ok) {
      return {
        isSignedIn: false,
        reason: exchanged.error === 'no_core_session' ? 'no_token' : exchanged.error,
      }
    }
    token = exchanged.value.token
  }
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
