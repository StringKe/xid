import { describe, expect, it } from 'vitest'

import { importJwkForVerify } from '@xid-kit/crypto'

import { AppError } from '../errors'
import { verifyToken } from '../verify-token'
import { makeEs256Key, mintToken, type TestKey } from './test-keys'

const NOW = 1_700_000_000
const ISSUER = 'https://acme.xid.dev'

function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    sub: 'user_123',
    aud: 'client_abc',
    azp: 'client_abc',
    sid: 'sess_xyz',
    exp: NOW + 60,
    iat: NOW - 5,
    nbf: NOW - 5,
    jti: 'jti_1',
    scope: 'openid',
    client_id: 'client_abc',
    ...overrides,
  }
}

async function setup(): Promise<TestKey> {
  return makeEs256Key('kid_1')
}

describe('verifyToken', () => {
  it('verifies a valid ES256 token networkless and returns claims', async () => {
    const key = await setup()
    const token = await mintToken(key, basePayload())

    const result = await verifyToken(token, { jwtKey: key.publicJwk, issuer: ISSUER, now: NOW })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.sub).toBe('user_123')
      expect(result.value.sid).toBe('sess_xyz')
    }
  })

  it('rejects an expired token', async () => {
    const key = await setup()
    const token = await mintToken(key, basePayload({ exp: NOW - 120 }))

    const result = await verifyToken(token, { jwtKey: key.publicJwk, now: NOW })

    expect(result).toEqual({ ok: false, error: 'expired' })
  })

  it('rejects a not-yet-valid token', async () => {
    const key = await setup()
    const token = await mintToken(key, basePayload({ nbf: NOW + 600 }))

    const result = await verifyToken(token, { jwtKey: key.publicJwk, now: NOW })

    expect(result).toEqual({ ok: false, error: 'not_yet_valid' })
  })

  it('rejects a token signed by a different key (bad signature)', async () => {
    const key = await setup()
    const attacker = await makeEs256Key('kid_1')
    const token = await mintToken(attacker, basePayload())

    const result = await verifyToken(token, { jwtKey: key.publicJwk, now: NOW })

    expect(result).toEqual({ ok: false, error: 'bad_signature' })
  })

  it('rejects on issuer mismatch when issuer is expected', async () => {
    const key = await setup()
    const token = await mintToken(key, basePayload({ iss: 'https://evil.xid.dev' }))

    const result = await verifyToken(token, { jwtKey: key.publicJwk, issuer: ISSUER, now: NOW })

    expect(result).toEqual({ ok: false, error: 'issuer_mismatch' })
  })

  it('rejects on audience mismatch when audience is expected', async () => {
    const key = await setup()
    const token = await mintToken(key, basePayload())

    const result = await verifyToken(token, {
      jwtKey: key.publicJwk,
      audience: 'other_client',
      now: NOW,
    })

    expect(result).toEqual({ ok: false, error: 'audience_mismatch' })
  })

  it('rejects when azp is not in authorizedParties', async () => {
    const key = await setup()
    const token = await mintToken(key, basePayload({ azp: 'rogue_client' }))

    const result = await verifyToken(token, {
      jwtKey: key.publicJwk,
      authorizedParties: ['client_abc'],
      now: NOW,
    })

    expect(result).toEqual({ ok: false, error: 'azp_mismatch' })
  })

  it('rejects a signed JWT with non access-token typ', async () => {
    const key = await setup()
    const token = await mintToken(key, basePayload(), 'JWT')

    const result = await verifyToken(token, { jwtKey: key.publicJwk, now: NOW })

    expect(result).toEqual({ ok: false, error: 'typ_mismatch' })
  })

  it('accepts the explicit application access-token typ', async () => {
    const key = await setup()
    const token = await mintToken(key, basePayload(), 'application/at+jwt')

    const result = await verifyToken(token, { jwtKey: key.publicJwk, now: NOW })

    expect(result.ok).toBe(true)
  })

  it('accepts when azp is in authorizedParties', async () => {
    const key = await setup()
    const token = await mintToken(key, basePayload({ azp: 'client_abc' }))

    const result = await verifyToken(token, {
      jwtKey: key.publicJwk,
      authorizedParties: ['client_abc', 'client_def'],
      now: NOW,
    })

    expect(result.ok).toBe(true)
  })

  it('rejects a signed access token with a Project role in org_role', async () => {
    const key = await setup()
    const token = await mintToken(key, basePayload({ org_role: 'viewer' }))

    const result = await verifyToken(token, { jwtKey: key.publicJwk, now: NOW })

    expect(result).toEqual({ ok: false, error: 'invalid_org_role' })
  })

  it('selects the correct public key by kid from a JWKS', async () => {
    const key1 = await makeEs256Key('kid_1')
    const key2 = await makeEs256Key('kid_2')
    const token = await mintToken(key2, basePayload())

    const result = await verifyToken(token, {
      jwtKey: { keys: [key1.publicJwk, key2.publicJwk] },
      now: NOW,
    })

    expect(result.ok).toBe(true)
  })

  it('rejects a malformed token', async () => {
    const key = await setup()

    const result = await verifyToken('not.a.jwt', { jwtKey: key.publicJwk, now: NOW })

    expect(result).toEqual({ ok: false, error: 'malformed' })
  })

  it('throws AppError when jwtKey is missing', async () => {
    const key = await setup()
    const token = await mintToken(key, basePayload())

    await expect(
      verifyToken(token, { jwtKey: undefined as unknown as never, now: NOW }),
    ).rejects.toBeInstanceOf(AppError)
  })

  // 单钥 CryptoKey 无 kid 时仍须能验签带真实 kid 的 token(单钥集忽略 kid)。
  it('verifies a token with a real kid against a single imported CryptoKey (kid ignored)', async () => {
    const key = await makeEs256Key('kid_real')
    const token = await mintToken(key, basePayload())
    const publicKey = await importJwkForVerify(key.publicJwk)

    const result = await verifyToken(token, {
      jwtKey: { alg: 'ES256', publicKey },
      issuer: ISSUER,
      now: NOW,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.sub).toBe('user_123')
    }
  })

  it('rejects a token signed by a different key even with single imported CryptoKey', async () => {
    const key = await makeEs256Key('kid_real')
    const attacker = await makeEs256Key('kid_real')
    const token = await mintToken(attacker, basePayload())
    const publicKey = await importJwkForVerify(key.publicJwk)

    const result = await verifyToken(token, { jwtKey: { alg: 'ES256', publicKey }, now: NOW })

    expect(result).toEqual({ ok: false, error: 'bad_signature' })
  })
})
