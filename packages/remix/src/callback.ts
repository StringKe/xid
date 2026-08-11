// OAuth callback：强制 state（CSRF）与 PKCE code_verifier；return_to 仅允许相对路径防开放重定向；公开客户端 token 请求不含 client_secret。

import { XID_SESSION_RETURN_TO_KEY } from './types'
import type { XidSessionStorage } from './types'
import { setTokensInSession } from './session'

// @remix-run/node redirect 最小接口（peer dep，运行时由消费者提供）。
type RemixRedirectFn = (
  url: string,
  init?: { headers: Headers | Record<string, string> },
) => Response

type RemixNodeCallbackModule = {
  redirect: RemixRedirectFn
}

async function getRemixRedirect(): Promise<RemixRedirectFn> {
  const mod = (await import('@remix-run/node')) as unknown as RemixNodeCallbackModule
  return mod.redirect
}

type TokenEndpointResponse = {
  access_token: string
  token_type: string
  expires_in?: number
  refresh_token?: string
  id_token?: string
  scope?: string
}

export type HandleCallbackOptions = {
  // 默认 https://xid.dev/token；自托管时改为 issuer 的 /token。
  tokenEndpoint?: string
  // 已注册的公开 OAuth client_id，不是 Management API key。
  clientId: string
  // OIDC 要求 exact match，禁止通配。
  redirectUri: string
  sessionStorage: XidSessionStorage
  defaultReturnTo?: string
}

export type HandleCallbackResult = { ok: true; response: Response } | { ok: false; error: string }

// return_to 必须是同源相对路径，拒绝 //evil.com 等协议相对 URL。
function isRelativePath(value: string): boolean {
  if (!value.startsWith('/')) return false
  if (value.startsWith('//')) return false
  return true
}

export async function handleCallback(
  request: Request,
  options: HandleCallbackOptions,
): Promise<HandleCallbackResult> {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const stateParam = url.searchParams.get('state')

  if (!code) {
    return { ok: false, error: 'Missing authorization code' }
  }

  // 缺 state 即 CSRF 风险，一律拒绝。
  if (!stateParam) {
    return { ok: false, error: 'State mismatch: possible CSRF' }
  }

  const cookieHeader = request.headers.get('cookie')
  const session = await options.sessionStorage.getSession(cookieHeader)

  const storedState = session.get('xid:oauth_state')
  if (!storedState || storedState !== stateParam) {
    return { ok: false, error: 'State mismatch: possible CSRF' }
  }
  session.unset('xid:oauth_state')

  // 公开客户端无 client_secret，PKCE verifier 必填。
  const codeVerifier = session.get('xid:code_verifier')
  if (!codeVerifier) {
    return { ok: false, error: 'Missing PKCE code verifier' }
  }

  const tokenEndpoint = options.tokenEndpoint ?? 'https://xid.dev/token'
  const tokenResult = await exchangeCode({
    tokenEndpoint,
    clientId: options.clientId,
    redirectUri: options.redirectUri,
    code,
    codeVerifier,
  })

  if (!tokenResult.ok) {
    return { ok: false, error: tokenResult.error }
  }

  // PKCE 单次使用，交换后立即清除。
  session.unset('xid:code_verifier')

  setTokensInSession(session, {
    accessToken: tokenResult.value.access_token,
    ...(tokenResult.value.refresh_token ? { refreshToken: tokenResult.value.refresh_token } : {}),
  })

  // 优先级：query return_to -> session return_to -> defaultReturnTo -> /；query 侧必须经相对路径校验。
  const rawReturnTo = url.searchParams.get('return_to')
  const sessionReturnTo = session.get(XID_SESSION_RETURN_TO_KEY) ?? undefined

  let returnTo: string
  if (rawReturnTo && isRelativePath(rawReturnTo)) {
    returnTo = rawReturnTo
  } else if (sessionReturnTo && isRelativePath(sessionReturnTo)) {
    returnTo = sessionReturnTo
  } else {
    returnTo = options.defaultReturnTo ?? '/'
  }

  session.unset(XID_SESSION_RETURN_TO_KEY)

  const setCookieValue = await options.sessionStorage.commitSession(session)
  const redirectFn = await getRemixRedirect()
  const response = redirectFn(returnTo, {
    headers: { 'Set-Cookie': setCookieValue },
  })

  return { ok: true, response }
}

// 公开客户端 + PKCE S256，请求体不含 client_secret。
async function exchangeCode(params: {
  tokenEndpoint: string
  clientId: string
  redirectUri: string
  code: string
  codeVerifier: string
}): Promise<{ ok: true; value: TokenEndpointResponse } | { ok: false; error: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    code: params.code,
    code_verifier: params.codeVerifier,
  })

  let response: Response
  try {
    response = await fetch(params.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    })
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause)
    return { ok: false, error: `Token endpoint network error: ${msg}` }
  }

  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: `Token endpoint returned non-JSON response` }
  }

  if (!response.ok) {
    const errMsg =
      (parsed as { error_description?: string; error?: string } | null)?.error_description ??
      (parsed as { error?: string } | null)?.error ??
      `HTTP ${response.status}`
    return { ok: false, error: errMsg }
  }

  const tokenResponse = parsed as TokenEndpointResponse
  if (!tokenResponse.access_token) {
    return { ok: false, error: 'Token response missing access_token' }
  }

  return { ok: true, value: tokenResponse }
}
