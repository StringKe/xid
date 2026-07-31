import type { Result, SessionTokenResponse } from '@xid-kit/types'

import { AppError } from './errors'

const CORE_REFRESH_COOKIE_PREFIX = '__Host-xid.rt.'
const DEFAULT_SESSION_TOKEN_ENDPOINT = '/v1/sessions/token'

export type SessionTokenExchangeError = 'no_core_session' | 'session_rejected'

export type SessionTokenExchangeOptions = {
  /**
   * Core's cookie-to-JWT endpoint. Relative paths are resolved against the
   * incoming request and the resolved URL must stay on that exact origin.
   */
  endpoint?: string
  /**
   * Optional server-side fetch implementation. Browser fetch must not be used:
   * this helper forwards HttpOnly cookies from the incoming server request.
   */
  fetcher?: typeof fetch
  signal?: AbortSignal
}

function cookieNames(request: Request): string[] {
  const header = request.headers.get('cookie')
  if (!header) return []

  return header.split(';').flatMap((part) => {
    const separator = part.indexOf('=')
    if (separator === -1) return []
    const name = part.slice(0, separator).trim()
    return name ? [name] : []
  })
}

export function hasCoreSessionCookie(request: Request): boolean {
  return cookieNames(request).some((name) => name.startsWith(CORE_REFRESH_COOKIE_PREFIX))
}

function resolveSameOriginEndpoint(request: Request, endpoint?: string): URL {
  const requestUrl = new URL(request.url)
  const resolved = new URL(endpoint ?? DEFAULT_SESSION_TOKEN_ENDPOINT, requestUrl)

  if (
    resolved.origin !== requestUrl.origin ||
    resolved.username ||
    resolved.password ||
    resolved.pathname !== DEFAULT_SESSION_TOKEN_ENDPOINT ||
    resolved.search ||
    resolved.hash
  ) {
    throw new AppError(
      'invalid_options',
      'sessionTokenExchange.endpoint must be exact same-origin /v1/sessions/token',
    )
  }

  return resolved
}

function parseSessionTokenResponse(value: unknown): SessionTokenResponse | null {
  if (value === null || typeof value !== 'object') return null
  if (Array.isArray(value) || Object.keys(value).length !== 1) return null
  const token = (value as { token?: unknown }).token
  if (typeof token !== 'string' || token.trim().length === 0) return null
  return { token }
}

/**
 * Exchange Core's opaque refresh cookie for a short-lived signed JWT.
 *
 * The opaque value is never inspected locally. The complete Cookie header is
 * forwarded only to an exact same-origin Core endpoint because multi-session
 * selection also depends on the HttpOnly active-session pointer. Separate
 * origins must use an explicit Bearer/JWT handoff instead.
 */
export async function exchangeSessionToken(
  request: Request,
  options: SessionTokenExchangeOptions = {},
): Promise<Result<SessionTokenResponse, SessionTokenExchangeError>> {
  if (!hasCoreSessionCookie(request)) {
    return { ok: false, error: 'no_core_session' }
  }

  const cookie = request.headers.get('cookie')
  if (!cookie) {
    return { ok: false, error: 'no_core_session' }
  }

  const endpoint = resolveSameOriginEndpoint(request, options.endpoint)
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis)

  let response: Response
  try {
    response = await fetcher(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        cookie,
      },
      redirect: 'manual',
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch (cause) {
    throw new AppError(
      'session_token_exchange_failed',
      'Core session-token exchange request failed',
      { cause },
    )
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: 'session_rejected' }
  }
  if (!response.ok) {
    throw new AppError(
      'session_token_exchange_failed',
      `Core session-token exchange returned HTTP ${response.status}`,
    )
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (cause) {
    throw new AppError(
      'session_token_exchange_failed',
      'Core session-token exchange returned invalid JSON',
      { cause },
    )
  }

  const parsed = parseSessionTokenResponse(body)
  if (!parsed) {
    throw new AppError(
      'session_token_exchange_failed',
      'Core session-token exchange returned an invalid response',
    )
  }
  return { ok: true, value: parsed }
}
