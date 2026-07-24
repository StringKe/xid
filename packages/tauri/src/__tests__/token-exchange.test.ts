import { describe, expect, it } from 'vitest'

import { TauriTokenError, exchangeCodeForTokens, refreshAccessToken } from '../token-exchange'

// Build a minimal fake fetch that returns a fixed JSON response.
function makeFakeFetch(status: number, body: unknown): typeof fetch {
  return async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    return new Response(JSON.stringify(body), { status })
  }
}

const BASE_EXCHANGE_OPTIONS = {
  issuer: 'https://xid.dev',
  clientId: 'client_123',
  redirectUri: 'myapp://auth/callback',
  code: 'auth-code-abc',
  codeVerifier: 'verifier-abc',
  now: () => 1_000_000,
}

const VALID_TOKEN_RESPONSE = {
  access_token: 'at.jwt',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: 'rt.xyz',
  id_token: 'it.jwt',
}

describe('exchangeCodeForTokens', () => {
  it('returns a TokenSet with correct fields on success', async () => {
    const fetcher = makeFakeFetch(200, VALID_TOKEN_RESPONSE)

    const result = await exchangeCodeForTokens({ ...BASE_EXCHANGE_OPTIONS, fetcher })

    expect(result.accessToken).toBe('at.jwt')
    expect(result.refreshToken).toBe('rt.xyz')
    expect(result.idToken).toBe('it.jwt')
    // expiresAt = now() + expires_in = 1_000_000 + 3600
    expect(result.expiresAt).toBe(1_003_600)
  })

  it('sets refreshToken to null when response omits refresh_token', async () => {
    const body = { ...VALID_TOKEN_RESPONSE, refresh_token: undefined }
    const fetcher = makeFakeFetch(200, body)

    const result = await exchangeCodeForTokens({ ...BASE_EXCHANGE_OPTIONS, fetcher })

    expect(result.refreshToken).toBeNull()
  })

  it('throws TauriTokenError on server error response', async () => {
    const fetcher = makeFakeFetch(400, {
      error: 'invalid_grant',
      error_description: 'Code expired',
    })

    await expect(exchangeCodeForTokens({ ...BASE_EXCHANGE_OPTIONS, fetcher })).rejects.toThrow(
      TauriTokenError,
    )
  })

  it('TauriTokenError.code matches the server error field', async () => {
    const fetcher = makeFakeFetch(400, { error: 'invalid_grant' })

    try {
      await exchangeCodeForTokens({ ...BASE_EXCHANGE_OPTIONS, fetcher })
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(TauriTokenError)
      expect((err as TauriTokenError).code).toBe('invalid_grant')
    }
  })

  it('throws TauriTokenError when response body missing access_token', async () => {
    const fetcher = makeFakeFetch(200, { token_type: 'Bearer' })

    await expect(exchangeCodeForTokens({ ...BASE_EXCHANGE_OPTIONS, fetcher })).rejects.toThrow(
      TauriTokenError,
    )
  })

  it('posts to the correct token endpoint URL', async () => {
    let capturedUrl = ''
    const fetcher = async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      capturedUrl = typeof input === 'string' ? input : input.toString()
      return new Response(JSON.stringify(VALID_TOKEN_RESPONSE), { status: 200 })
    }

    await exchangeCodeForTokens({ ...BASE_EXCHANGE_OPTIONS, fetcher })

    expect(capturedUrl).toBe('https://xid.dev/token')
  })

  it('sends code_verifier in the form body', async () => {
    let capturedBody = ''
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedBody = init?.body?.toString() ?? ''
      return new Response(JSON.stringify(VALID_TOKEN_RESPONSE), { status: 200 })
    }

    await exchangeCodeForTokens({ ...BASE_EXCHANGE_OPTIONS, fetcher })

    expect(capturedBody).toContain('code_verifier=verifier-abc')
  })
})

describe('refreshAccessToken', () => {
  const BASE_REFRESH_OPTIONS = {
    issuer: 'https://xid.dev',
    clientId: 'client_123',
    refreshToken: 'rt.old',
    now: () => 1_000_000,
  }

  it('returns a new TokenSet with rotated tokens', async () => {
    const fetcher = makeFakeFetch(200, {
      access_token: 'at.new',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'rt.new',
    })

    const result = await refreshAccessToken({ ...BASE_REFRESH_OPTIONS, fetcher })

    expect(result.accessToken).toBe('at.new')
    expect(result.refreshToken).toBe('rt.new')
  })

  it('throws TauriTokenError when refresh token is invalid', async () => {
    const fetcher = makeFakeFetch(400, { error: 'invalid_grant' })

    await expect(refreshAccessToken({ ...BASE_REFRESH_OPTIONS, fetcher })).rejects.toThrow(
      TauriTokenError,
    )
  })
})
