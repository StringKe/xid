// Bearer / 显式 JWT cookie / 可选同源 Core session exchange;Core 的 __Host-xid.rt.* 为 opaque refresh,禁止本地验签。

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
  // 无默认 cookie 名,避免把 Core opaque refresh 误当 JWT。
  jwtCookieName?: string
  // endpoint 必须解析到 request 的 exact origin。
  sessionTokenExchange?: SessionTokenExchangeOptions
}

export type SignedInState = {
  isSignedIn: true
  userId: string
  sessionId: string | undefined
  claims: AccessTokenClaims
}

export type SignedOutState = {
  isSignedIn: false
  reason: 'no_token' | SessionTokenExchangeError | VerifyTokenError
}

export type RequestState = SignedInState | SignedOutState

function tokenFromHeader(request: Request): string | undefined {
  const header = request.headers.get('authorization')
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    return undefined
  }
  const token = header.slice(BEARER_PREFIX.length).trim()
  return token.length > 0 ? token : undefined
}

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
