// exchangeCode 的 token 响应校验:provider 在 200 里返回 error 或缺 access_token 时按 invalid_grant 处理。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { exchangeCode } from '../social-providers'
import type { ProviderConfig } from '../social-providers'

const config: ProviderConfig = {
  authorizationEndpoint: 'https://github.com/login/oauth/authorize',
  tokenEndpoint: 'https://github.com/login/oauth/access_token',
  clientId: 'github-client',
  clientSecret: 'github-secret',
  scopes: ['read:user', 'user:email'],
  usesPkce: true,
}

function exchangeWithResponse(response: Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response),
  )
  return exchangeCode({
    provider: 'github',
    config,
    redirectUri: 'https://test.xid.dev/auth/github/callback',
    codeVerifier: 'verifier',
    code: 'code',
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('exchangeCode token 响应校验', () => {
  it('returns tokens when the provider responds with access_token', async () => {
    const response = Response.json({
      access_token: 'gho_access',
      refresh_token: 'refresh',
      id_token: null,
    })

    const tokens = await exchangeWithResponse(response)

    expect(tokens).toEqual({ accessToken: 'gho_access', refreshToken: 'refresh', idToken: null })
  })

  it('rejects a 200 response carrying a GitHub error as invalid_grant', async () => {
    const response = Response.json({
      error: 'bad_verification_code',
      error_description: 'The code passed is incorrect or expired.',
    })

    await expect(exchangeWithResponse(response)).rejects.toMatchObject({ code: 'invalid_grant' })
  })

  it('rejects a response that has an access_token and an error field as invalid_grant', async () => {
    const response = Response.json({ access_token: 'x', error: 'invalid_request' })

    await expect(exchangeWithResponse(response)).rejects.toMatchObject({ code: 'invalid_grant' })
  })

  it('rejects a response without access_token as invalid_grant', async () => {
    const response = Response.json({ token_type: 'bearer' })

    await expect(exchangeWithResponse(response)).rejects.toMatchObject({ code: 'invalid_grant' })
  })

  it('rejects an empty access_token as invalid_grant', async () => {
    const response = Response.json({ access_token: '' })

    await expect(exchangeWithResponse(response)).rejects.toMatchObject({ code: 'invalid_grant' })
  })

  it('rejects a non-JSON body as invalid_grant', async () => {
    const response = new Response('access_token=x&scope=user', { status: 200 })

    await expect(exchangeWithResponse(response)).rejects.toMatchObject({ code: 'invalid_grant' })
  })

  it('rejects a non-2xx response as invalid_grant', async () => {
    const response = Response.json({ error: 'invalid_grant' }, { status: 400 })

    await expect(exchangeWithResponse(response)).rejects.toMatchObject({ code: 'invalid_grant' })
  })
})
