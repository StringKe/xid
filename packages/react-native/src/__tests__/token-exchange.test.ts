import { describe, expect, it, vi, beforeEach } from 'vitest'

import {
  clearTokenSet,
  exchangeCodeForTokens,
  readTokenSet,
  saveTokenSet,
  TOKEN_KEYS,
} from '../token-exchange'
import type { TokenCache } from '../token-cache'

vi.mock('../id-token', () => ({
  verifyNativeIdToken: vi.fn(
    async (
      _idToken: string,
      input: { issuer: string; clientId: string; expectedNonce?: string },
    ) => ({
      iss: input.issuer,
      sub: 'user_test',
      aud: input.clientId,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      nonce: input.expectedNonce,
    }),
  ),
}))

function makeMockCache(): TokenCache & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    getToken: async (key) => store.get(key) ?? null,
    saveToken: async (key, value) => {
      store.set(key, value)
    },
    deleteToken: async (key) => {
      store.delete(key)
    },
  }
}

describe('saveTokenSet', () => {
  it('stores the complete session in one envelope', async () => {
    const cache = makeMockCache()
    await saveTokenSet(cache, {
      accessToken: 'at_test',
      idToken: null,
      expiresIn: 3600,
    })
    expect(await cache.getToken(TOKEN_KEYS.session)).toContain('at_test')
    await expect(readTokenSet(cache)).resolves.toMatchObject({
      accessToken: 'at_test',
    })
  })

  it('stores id token when present', async () => {
    const cache = makeMockCache()
    await saveTokenSet(cache, {
      accessToken: 'at',
      idToken: 'idt_test',
      expiresIn: 3600,
    })
    await expect(readTokenSet(cache)).resolves.toMatchObject({ idToken: 'idt_test' })
  })

  it('stores a nullable ID token without adding refresh credentials', async () => {
    const cache = makeMockCache()
    await saveTokenSet(cache, {
      accessToken: 'at',
      idToken: null,
      expiresIn: 3600,
    })
    const stored = await readTokenSet(cache)
    expect(stored).toMatchObject({ idToken: null })
    expect(stored).not.toHaveProperty('refreshToken')
  })

  it('keeps a pending marker when envelope save and cleanup both fail', async () => {
    const cache = makeMockCache()
    cache.store.set(TOKEN_KEYS.session, 'stale-session')
    cache.saveToken = async (key, value) => {
      if (key === TOKEN_KEYS.session) {
        throw new Error('storage unavailable')
      }
      cache.store.set(key, value)
    }
    cache.deleteToken = async () => {
      throw new Error('storage unavailable')
    }

    await expect(
      saveTokenSet(cache, {
        accessToken: 'at',
        idToken: null,
        expiresIn: 3600,
      }),
    ).rejects.toThrow('storage unavailable')
    expect(await cache.getToken(TOKEN_KEYS.sessionPending)).toBe('1')
    await expect(readTokenSet(cache)).resolves.toBeNull()
  })

  it('removes legacy token keys after persisting an envelope', async () => {
    const cache = makeMockCache()
    cache.store.set(TOKEN_KEYS.accessToken, 'legacy_access')
    cache.store.set(TOKEN_KEYS.legacyRefreshToken, 'legacy_refresh')
    cache.store.set(TOKEN_KEYS.idToken, 'legacy_id')
    cache.store.set(TOKEN_KEYS.expiresAt, 'legacy_expiry')

    await saveTokenSet(cache, {
      accessToken: 'at',
      idToken: null,
      expiresIn: 3600,
    })

    expect(await cache.getToken(TOKEN_KEYS.accessToken)).toBeNull()
    expect(await cache.getToken(TOKEN_KEYS.legacyRefreshToken)).toBeNull()
    expect(await cache.getToken(TOKEN_KEYS.idToken)).toBeNull()
    expect(await cache.getToken(TOKEN_KEYS.expiresAt)).toBeNull()
  })

  it('does not restore legacy token keys when no envelope exists', async () => {
    const cache = makeMockCache()
    cache.store.set(TOKEN_KEYS.accessToken, 'legacy_access')
    cache.store.set(TOKEN_KEYS.expiresAt, 'legacy_expiry')

    await expect(readTokenSet(cache)).resolves.toBeNull()
    expect(await cache.getToken(TOKEN_KEYS.accessToken)).toBeNull()
    expect(await cache.getToken(TOKEN_KEYS.expiresAt)).toBeNull()
  })

  it('fails closed and deletes an old envelope containing a refresh credential', async () => {
    const cache = makeMockCache()
    cache.store.set(
      TOKEN_KEYS.session,
      JSON.stringify({
        accessToken: 'at.legacy',
        refreshToken: 'rt.legacy',
        idToken: null,
        expiresIn: 3600,
        expiresAt: Date.now() + 3_600_000,
        claims: null,
      }),
    )

    await expect(readTokenSet(cache)).resolves.toBeNull()
    expect(cache.store.size).toBe(0)
  })
})

describe('clearTokenSet', () => {
  it('removes all token keys', async () => {
    const cache = makeMockCache()
    cache.store.set(TOKEN_KEYS.accessToken, 'at')
    cache.store.set(TOKEN_KEYS.session, 'session')
    cache.store.set(TOKEN_KEYS.sessionPending, '1')
    cache.store.set(TOKEN_KEYS.legacyRefreshToken, 'rt')
    cache.store.set(TOKEN_KEYS.idToken, 'idt')
    cache.store.set(TOKEN_KEYS.pkceVerifier, 'v')
    cache.store.set(TOKEN_KEYS.oauthState, 's')

    await clearTokenSet(cache)

    expect(await cache.getToken(TOKEN_KEYS.accessToken)).toBeNull()
    expect(await cache.getToken(TOKEN_KEYS.session)).toBeNull()
    expect(await cache.getToken(TOKEN_KEYS.sessionPending)).toBeNull()
    expect(await cache.getToken(TOKEN_KEYS.legacyRefreshToken)).toBeNull()
    expect(await cache.getToken(TOKEN_KEYS.idToken)).toBeNull()
    expect(await cache.getToken(TOKEN_KEYS.pkceVerifier)).toBeNull()
    expect(await cache.getToken(TOKEN_KEYS.oauthState)).toBeNull()
  })
})

describe('exchangeCodeForTokens', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('sends POST to /token with correct parameters', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'at_live',
        refresh_token: 'rt_live',
        id_token: 'idt_live',
        expires_in: 3600,
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await exchangeCodeForTokens({
      issuer: 'https://xid.dev',
      clientId: 'client_123',
      redirectUri: 'myapp://auth/callback',
      code: 'auth_code_abc',
      verifier: 'pkce_verifier_xyz',
      nonce: 'nonce_xyz',
    })

    expect(result.accessToken).toBe('at_live')
    expect(result).not.toHaveProperty('refreshToken')
    expect(result.idToken).toBe('idt_live')
    expect(result.expiresIn).toBe(3600)

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://xid.dev/token')
    expect(init.method).toBe('POST')
    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('client_id')).toBe('client_123')
    expect(body.get('code')).toBe('auth_code_abc')
    expect(body.get('code_verifier')).toBe('pkce_verifier_xyz')
  })

  it('throws on non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'invalid_grant',
      }),
    )

    await expect(
      exchangeCodeForTokens({
        issuer: 'https://xid.dev',
        clientId: 'c',
        redirectUri: 'myapp://cb',
        code: 'bad_code',
        verifier: 'v',
        nonce: 'n',
      }),
    ).rejects.toThrow('Token exchange failed')
  })

  it('requires an ID token so the authorization nonce can be verified', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'at_live',
          refresh_token: 'rt_live',
          expires_in: 3600,
        }),
      }),
    )

    await expect(
      exchangeCodeForTokens({
        issuer: 'https://xid.dev',
        clientId: 'client_123',
        redirectUri: 'myapp://auth/callback',
        code: 'auth_code_abc',
        verifier: 'pkce_verifier_xyz',
        nonce: 'nonce_xyz',
      }),
    ).rejects.toThrow('missing id_token')
  })
})
