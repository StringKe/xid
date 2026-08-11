import type { Result, SessionTokenResponse } from '@xid-kit/types'

import { AppError } from './errors'

const CORE_REFRESH_COOKIE_PREFIX = '__Host-xid.rt.'
const DEFAULT_SESSION_TOKEN_ENDPOINT = '/v1/sessions/token'

export type SessionTokenExchangeError = 'no_core_session' | 'session_rejected'

export type SessionTokenExchangeOptions = {
  // 相对路径按 request 解析,解析后必须仍在 exact same origin。
  endpoint?: string
  // 须服务端 fetch:会转发入站 Request 的 HttpOnly Cookie,禁止浏览器 fetch。
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

// opaque refresh 不本地解析;整段 Cookie 仅转发 exact same-origin,因多会话选择依赖 HttpOnly active-session 指针。
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
