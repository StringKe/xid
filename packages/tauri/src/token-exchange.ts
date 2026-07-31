// Authorization code -> token exchange.
// Uses a plain fetch against /token (form-encoded, no cookies).
// Tauri runs outside the HttpOnly cookie context, so tokens are held in OS keychain.

import { trimTrailingSlashes } from '@xid-kit/core'

export type TokenSet = {
  accessToken: string
  // epoch seconds
  expiresAt: number
  idToken: string | null
}

type TokenEndpointSuccessBody = {
  access_token: string
  token_type: string
  expires_in?: number
  id_token?: string
}

type TokenEndpointErrorBody = {
  error: string
  error_description?: string
}

// Exchange an authorization code for tokens.
export async function exchangeCodeForTokens(input: {
  issuer: string
  clientId: string
  redirectUri: string
  code: string
  codeVerifier: string
  fetcher?: typeof fetch
  now?: () => number
}): Promise<TokenSet> {
  const now = input.now ?? (() => Math.floor(Date.now() / 1000))
  const fetcher = input.fetcher ?? globalThis.fetch.bind(globalThis)

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code: input.code,
    code_verifier: input.codeVerifier,
  })

  const tokenEndpoint = buildTokenEndpoint(input.issuer)
  const response = await fetcher(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  })

  return parseTokenResponse(response, now)
}

function buildTokenEndpoint(issuer: string): string {
  // The XID server registers the token endpoint at /token (not /oauth/token).
  return `${trimTrailingSlashes(issuer)}/token`
}

async function parseTokenResponse(response: Response, now: () => number): Promise<TokenSet> {
  const text = await response.text()
  const parsed: unknown = text ? JSON.parse(text) : null

  if (!response.ok) {
    const err = parsed as Partial<TokenEndpointErrorBody>
    const code = err?.error ?? 'token_exchange_failed'
    const description = err?.error_description ?? `HTTP ${response.status}`
    throw new TauriTokenError(`Token endpoint error: ${code} - ${description}`, code)
  }

  const body = parsed as TokenEndpointSuccessBody
  if (!body.access_token)
    throw new TauriTokenError('Token response missing access_token', 'invalid_response')

  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600
  return {
    accessToken: body.access_token,
    expiresAt: now() + expiresIn,
    idToken: body.id_token ?? null,
  }
}

// Typed error for authorization and token-exchange failures.
export class TauriTokenError extends Error {
  override readonly name = 'TauriTokenError'
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}
