// callback.ts: OAuth callback action helper.
// handleCallback(request, options): processes /auth/callback,
// validates state (CSRF) and PKCE code_verifier, exchanges the authorization code,
// writes tokens to the session cookie, then redirects to return_to.
//
// Security model:
//   - state param is ALWAYS required; missing state in the callback is rejected.
//   - PKCE code_verifier is ALWAYS required; missing verifier rejects the exchange.
//   - return_to is validated to be a same-origin relative path (no open redirect).
//   - Public client: no client_secret is included in the token request.

import { XID_SESSION_RETURN_TO_KEY } from './types'
import type { XidSessionStorage } from './types'
import { setTokensInSession } from './session'

// @remix-run/node redirect minimal interface contract (peer dep).
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

// OAuth 2.0 token response shape.
type TokenEndpointResponse = {
  access_token: string
  token_type: string
  expires_in?: number
  refresh_token?: string
  id_token?: string
  scope?: string
}

// handleCallback configuration.
export type HandleCallbackOptions = {
  // XID token endpoint URL, default https://api.xid.dev/oauth/token.
  tokenEndpoint?: string
  // Client ID (publishable key, pk_live_xxx / pk_test_xxx).
  clientId: string
  // redirect_uri exact match (OIDC requirement, no wildcard).
  redirectUri: string
  // Session storage for persisting access_token / refresh_token.
  sessionStorage: XidSessionStorage
  // Default redirect path when return_to is absent.
  defaultReturnTo?: string
}

// handleCallback result: success returns Response (redirect + Set-Cookie), failure returns { error }.
export type HandleCallbackResult = { ok: true; response: Response } | { ok: false; error: string }

// isRelativePath: returns true when the path is a relative URL (no scheme, no external host).
// Prevents open-redirect attacks via the return_to parameter.
function isRelativePath(value: string): boolean {
  if (!value.startsWith('/')) return false
  // Reject protocol-relative URLs like //evil.com
  if (value.startsWith('//')) return false
  return true
}

// handleCallback: processes the OAuth authorization code exchange and session write.
//
// Usage (routes/auth.callback.ts):
//   import { handleCallback } from '@xid-kit/remix'
//   import { sessionStorage } from '~/sessions.server'
//
//   export async function action({ request }: ActionFunctionArgs) {
//     const result = await handleCallback(request, {
//       clientId: process.env.XID_CLIENT_ID!,
//       redirectUri: process.env.XID_REDIRECT_URI!,
//       sessionStorage,
//     })
//     if (!result.ok) throw new Response(result.error, { status: 400 })
//     return result.response
//   }
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

  // state is always required -- absence is a CSRF violation.
  if (!stateParam) {
    return { ok: false, error: 'State mismatch: possible CSRF' }
  }

  const cookieHeader = request.headers.get('cookie')
  const session = await options.sessionStorage.getSession(cookieHeader)

  // Validate state against the session-stored value.
  const storedState = session.get('xid:oauth_state')
  if (!storedState || storedState !== stateParam) {
    return { ok: false, error: 'State mismatch: possible CSRF' }
  }
  session.unset('xid:oauth_state')

  // PKCE code_verifier is always required (public client, no client_secret).
  const codeVerifier = session.get('xid:code_verifier')
  if (!codeVerifier) {
    return { ok: false, error: 'Missing PKCE code verifier' }
  }

  // Exchange the authorization code for tokens.
  const tokenEndpoint = options.tokenEndpoint ?? 'https://api.xid.dev/oauth/token'
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

  // Clean up PKCE verifier (single-use, delete immediately after exchange).
  session.unset('xid:code_verifier')

  // Write tokens to session.
  setTokensInSession(session, {
    accessToken: tokenResult.value.access_token,
    ...(tokenResult.value.refresh_token ? { refreshToken: tokenResult.value.refresh_token } : {}),
  })

  // Determine redirect target: return_to param -> session-stored return_to -> defaultReturnTo -> /.
  // return_to from query params must be a relative path to prevent open redirect.
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

// exchangeCode: fetches tokens from the XID token endpoint.
// No client_secret (public client + PKCE S256).
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
