// Tests for signIn, handleRedirect, and state / PKCE security constraints.
import { describe, expect, it, vi } from 'vitest'

import { createMemoryKeychainAdapter } from '../keychain'
import { createXidTauriClient } from '../client'
import { TauriTokenError } from '../token-exchange'

const BASE_OPTIONS = {
  issuer: 'https://xid.dev',
  clientId: 'client_test',
  redirectUri: 'myapp://auth/callback',
  keychain: createMemoryKeychainAdapter(),
  now: () => 1_000_000,
}

function makeTokenFetcher(
  accessToken = 'at.jwt',
  unexpectedRefreshToken: string | null = null,
  expiresIn = 3600,
) {
  return async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
    new Response(
      JSON.stringify({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: expiresIn,
        ...(unexpectedRefreshToken ? { refresh_token: unexpectedRefreshToken } : {}),
      }),
      { status: 200 },
    )
}

function makeCallbackUrl(code: string, state: string): string {
  return `myapp://auth/callback?code=${code}&state=${encodeURIComponent(state)}`
}

describe('createXidTauriClient.signIn', () => {
  it('returns an authorize URL with PKCE S256 parameters', async () => {
    const client = createXidTauriClient({ ...BASE_OPTIONS })

    const url = await client.signIn()

    expect(url.origin).toBe('https://xid.dev')
    expect(url.pathname).toBe('/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('client_test')
    expect(url.searchParams.get('redirect_uri')).toBe('myapp://auth/callback')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).not.toBeNull()
    expect(url.searchParams.get('state')).not.toBeNull()
  })

  it('uses default scopes when none provided', async () => {
    const client = createXidTauriClient({ ...BASE_OPTIONS })

    const url = await client.signIn()

    expect(url.searchParams.get('scope')).toBe('openid profile email')
  })

  it('accepts custom scopes at call time', async () => {
    const client = createXidTauriClient({ ...BASE_OPTIONS })

    const url = await client.signIn({ scopes: ['openid', 'organization'] })

    expect(url.searchParams.get('scope')).toBe('openid organization')
  })

  it('rejects offline_access until DPoP sender binding is implemented', async () => {
    const client = createXidTauriClient({ ...BASE_OPTIONS })

    await expect(client.signIn({ scopes: ['openid', 'offline_access'] })).rejects.toThrow(
      'offline_access requires DPoP',
    )
  })

  it('calls openUrl callback with the authorize URL string', async () => {
    const client = createXidTauriClient({ ...BASE_OPTIONS })
    const openUrl = vi.fn().mockResolvedValue(undefined)

    const url = await client.signIn({ openUrl })

    expect(openUrl).toHaveBeenCalledWith(url.toString())
  })

  it('produces a different state on each call', async () => {
    const client = createXidTauriClient({
      ...BASE_OPTIONS,
      keychain: createMemoryKeychainAdapter(),
    })

    const url1 = await client.signIn()
    const url2 = await client.signIn()

    expect(url1.searchParams.get('state')).not.toBe(url2.searchParams.get('state'))
  })
})

describe('createXidTauriClient.handleRedirect', () => {
  async function signInAndGetState(client: ReturnType<typeof createXidTauriClient>) {
    const url = await client.signIn()
    return url.searchParams.get('state') ?? ''
  }

  it('completes token exchange and stores access token', async () => {
    const keychain = createMemoryKeychainAdapter()
    const client = createXidTauriClient({
      ...BASE_OPTIONS,
      keychain,
      fetcher: makeTokenFetcher('at.success'),
    })

    const state = await signInAndGetState(client)
    await client.handleRedirect(makeCallbackUrl('auth-code-1', state))

    expect(await client.getAccessToken()).toBe('at.success')
  })

  it('discards an unexpected refresh token from the code exchange response', async () => {
    const keychain = createMemoryKeychainAdapter()
    const client = createXidTauriClient({
      ...BASE_OPTIONS,
      keychain,
      fetcher: makeTokenFetcher('at.success', 'rt.unexpected'),
    })

    const state = await signInAndGetState(client)
    await client.handleRedirect(makeCallbackUrl('auth-code-with-refresh', state))

    expect(await keychain.getItem('xid.refresh_token')).toBeNull()
  })

  it('requires reauthorization after an authorization-code-only token expires', async () => {
    const client = createXidTauriClient({
      ...BASE_OPTIONS,
      keychain: createMemoryKeychainAdapter(),
      fetcher: makeTokenFetcher('at.expired', null, 0),
    })

    const state = await signInAndGetState(client)
    await client.handleRedirect(makeCallbackUrl('auth-code-expired', state))

    await expect(client.getAccessToken()).resolves.toBeNull()
  })

  it('throws TauriTokenError when state is mismatched', async () => {
    const client = createXidTauriClient({ ...BASE_OPTIONS })

    await client.signIn()

    await expect(client.handleRedirect(makeCallbackUrl('code', 'wrong-state'))).rejects.toThrow(
      TauriTokenError,
    )
  })

  it('TauriTokenError.code is state_mismatch on state mismatch', async () => {
    const client = createXidTauriClient({ ...BASE_OPTIONS })

    await client.signIn()

    try {
      await client.handleRedirect(makeCallbackUrl('code', 'tampered'))
      expect.fail('should have thrown')
    } catch (err) {
      expect((err as TauriTokenError).code).toBe('state_mismatch')
    }
  })

  it('throws TauriTokenError when callback contains an error param', async () => {
    const client = createXidTauriClient({ ...BASE_OPTIONS })

    await expect(
      client.handleRedirect(
        'myapp://auth/callback?error=access_denied&error_description=User+denied',
      ),
    ).rejects.toThrow(TauriTokenError)
  })

  it('throws TauriTokenError when code is missing from callback URL', async () => {
    const client = createXidTauriClient({ ...BASE_OPTIONS })

    await client.signIn()

    await expect(client.handleRedirect('myapp://auth/callback?state=some-state')).rejects.toThrow(
      TauriTokenError,
    )
  })
})
