// Apple client_secret 签发:ES256 JWT 的 header/claims、短有效期缓存、部分配置 fail closed。

import { verifyJwt } from '@xid-kit/crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appleClientSecret, appleSigningState } from '../apple-client-secret'
import {
  APPLE_CLIENT_SECRET_LIFETIME_SEC,
  APPLE_CLIENT_SECRET_REFRESH_MARGIN_SEC,
} from '../../lib/ttl'
import { exchangeCode, getProviderConfig, hasProviderSecret } from '../social-providers'
import type { SocialProviderPolicy, TenantContext } from '@xid-kit/types'

const APPLE_MAX_LIFETIME_SEC = 15_777_000

async function appleKeyPair(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  const base64 = Buffer.from(pkcs8).toString('base64')
  const pem = `-----BEGIN PRIVATE KEY-----\n${base64.match(/.{1,64}/g)?.join('\n')}\n-----END PRIVATE KEY-----`
  return { pem, publicKey: pair.publicKey }
}

function decodeSegment(token: string, index: number): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[index] ?? '', 'base64url').toString()) as Record<
    string,
    unknown
  >
}

const applePolicy: SocialProviderPolicy = {
  enabled: true,
  clientId: 'com.example.service',
  authorizationEndpoint: 'https://appleid.apple.com/auth/authorize',
  tokenEndpoint: 'https://appleid.apple.com/auth/token',
  issuer: 'https://appleid.apple.com',
  jwksUri: 'https://appleid.apple.com/auth/keys',
  scopes: ['openid', 'email', 'name'],
  usesPkce: true,
  allowLogin: true,
  allowUserCreation: true,
  requireVerifiedEmail: true,
  allowedEmailDomains: [],
  blockedEmailDomains: [],
} as unknown as SocialProviderPolicy

function appleTenant(): TenantContext {
  return {
    tenantId: 'tenant-1',
    issuer: 'https://test.xid.dev',
    rpId: 'test.xid.dev',
    signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
    policy: { socialProviders: { apple: applePolicy } },
  } as unknown as TenantContext
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('appleClientSecret', () => {
  it('signs an ES256 JWT with Apple header and claims that verifies with the public key', async () => {
    const { pem, publicKey } = await appleKeyPair()
    const now = 1_800_000_000

    const token = await appleClientSecret(
      { teamId: 'TEAM123456', keyId: 'KEY1234567', privateKeyPem: pem },
      'com.example.service',
      now,
    )

    expect(decodeSegment(token, 0)).toMatchObject({ alg: 'ES256', kid: 'KEY1234567' })
    expect(decodeSegment(token, 1)).toEqual({
      iss: 'TEAM123456',
      sub: 'com.example.service',
      aud: 'https://appleid.apple.com',
      iat: now,
      exp: now + APPLE_CLIENT_SECRET_LIFETIME_SEC,
    })
    const verified = await verifyJwt(token, { alg: 'ES256', publicKey }, { now })
    expect(verified.ok).toBe(true)
    expect(APPLE_CLIENT_SECRET_LIFETIME_SEC).toBeLessThanOrEqual(APPLE_MAX_LIFETIME_SEC)
  })

  it('accepts a PEM stored with literal \\n escapes', async () => {
    const { pem, publicKey } = await appleKeyPair()
    const escaped = pem.replaceAll('\n', '\\n')

    const token = await appleClientSecret(
      { teamId: 'TEAM-ESC', keyId: 'KEY-ESC', privateKeyPem: escaped },
      'com.example.escaped',
      1_800_000_000,
    )

    expect((await verifyJwt(token, { alg: 'ES256', publicKey }, { now: 1_800_000_000 })).ok).toBe(
      true,
    )
  })

  it('reuses the cached token until the refresh margin and re-signs after it', async () => {
    const { pem } = await appleKeyPair()
    const config = { teamId: 'TEAM-CACHE', keyId: 'KEY-CACHE', privateKeyPem: pem }
    const now = 1_800_000_000

    const first = await appleClientSecret(config, 'com.example.cache', now)
    const reused = await appleClientSecret(config, 'com.example.cache', now + 60)
    const refreshAt =
      now + APPLE_CLIENT_SECRET_LIFETIME_SEC - APPLE_CLIENT_SECRET_REFRESH_MARGIN_SEC
    const renewed = await appleClientSecret(config, 'com.example.cache', refreshAt)

    expect(reused).toBe(first)
    expect(renewed).not.toBe(first)
    expect(decodeSegment(renewed, 1)['iat']).toBe(refreshAt)
  })

  it('throws server_error for an unreadable private key', async () => {
    const config = { teamId: 'TEAM-BAD', keyId: 'KEY-BAD', privateKeyPem: 'not a key' }

    await expect(appleClientSecret(config, 'com.example.bad', 1)).rejects.toMatchObject({
      code: 'server_error',
    })
  })
})

describe('appleSigningState', () => {
  it.each([
    [{}, 'absent'],
    [{ APPLE_TEAM_ID: 'T', APPLE_KEY_ID: 'K', APPLE_PRIVATE_KEY: 'P' }, 'complete'],
    [{ APPLE_TEAM_ID: 'T', APPLE_KEY_ID: 'K' }, 'partial'],
    [{ APPLE_PRIVATE_KEY: 'P', APPLE_TEAM_ID: '  ' }, 'partial'],
  ])('classifies %o as %s', (env, kind) => {
    expect(appleSigningState(env as unknown as Env).kind).toBe(kind)
  })
})

describe('Apple provider credentials', () => {
  it('signs the client_secret at code exchange when the signing key is configured', async () => {
    const { pem, publicKey } = await appleKeyPair()
    const env = {
      APPLE_TEAM_ID: 'TEAM-EXCH',
      APPLE_KEY_ID: 'KEY-EXCH',
      APPLE_PRIVATE_KEY: pem,
    } as unknown as Env
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = init.body as URLSearchParams
      const secret = body.get('client_secret') ?? ''
      const verified = await verifyJwt(secret, { alg: 'ES256', publicKey })
      return Response.json({ access_token: verified.ok ? 'ok' : 'bad', id_token: 'id' })
    })
    vi.stubGlobal('fetch', fetchMock)
    const config = getProviderConfig(env, appleTenant(), 'apple')

    const tokens = await exchangeCode({
      provider: 'apple',
      config: config!,
      redirectUri: 'https://test.xid.dev/auth/apple/callback',
      codeVerifier: 'verifier',
      code: 'code',
    })

    expect(hasProviderSecret(env, applePolicy, 'apple')).toBe(true)
    expect(config?.clientSecret).toBeUndefined()
    expect(tokens.accessToken).toBe('ok')
  })

  it('falls back to the static APPLE_CLIENT_SECRET when no signing variable is set', () => {
    const env = { APPLE_CLIENT_SECRET: 'static-jwt' } as unknown as Env

    const config = getProviderConfig(env, appleTenant(), 'apple')

    expect(config?.clientSecret).toBe('static-jwt')
    expect(config?.appleSigning).toBeUndefined()
    expect(hasProviderSecret(env, applePolicy, 'apple')).toBe(true)
  })

  it('fails closed on a partial signing configuration even with a static secret', () => {
    const env = { APPLE_CLIENT_SECRET: 'static-jwt', APPLE_TEAM_ID: 'TEAM' } as unknown as Env

    expect(hasProviderSecret(env, applePolicy, 'apple')).toBe(false)
    expect(() => getProviderConfig(env, appleTenant(), 'apple')).toThrow(
      expect.objectContaining({ code: 'server_error' }),
    )
  })

  it('reports no credential when neither signing variables nor a static secret exist', () => {
    const env = {} as unknown as Env

    expect(hasProviderSecret(env, applePolicy, 'apple')).toBe(false)
    expect(() => getProviderConfig(env, appleTenant(), 'apple')).toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    )
  })
})
