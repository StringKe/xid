// JWT 签发/校验正反例:合法验证通过;过期/篡改/错 kid/iss/aud 不匹配拒绝(见 oidc-oauth / signing-keys rule)。
import type { SigningAlg } from '@xid-kit/types'
import { describe, it, expect } from 'vitest'

import { generateTenantSigningKey } from '../signing-key'
import { importJwkForVerify } from '../jwks'
import { signJwt, verifyJwt } from '../jwt'
import type { VerifyKey, VerifyKeySet } from '../jwt'

function randomKek(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}

async function setup(alg: SigningAlg, kid = 'kid-001') {
  const { material, signingKey } = await generateTenantSigningKey({
    kid,
    kekRaw: randomKek(),
    kekVersion: 1,
    alg,
  })
  const publicKey = await importJwkForVerify({
    ...material.publicKeyJwk,
    kid,
    use: 'sig',
    alg,
  })
  return { signingKey, publicKey, kid }
}

const ALGS: SigningAlg[] = ['ES256', 'RS256', 'PS256']

describe('signJwt / verifyJwt round-trip', () => {
  it.each(ALGS)('verifies a freshly signed %s token', async (alg) => {
    const { signingKey, publicKey, kid } = await setup(alg)
    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt(
      {
        header: { alg, kid },
        payload: {
          iss: 'https://t.xid.dev',
          sub: 'user_1',
          aud: 'client_1',
          exp: now + 3600,
          iat: now,
        },
      },
      signingKey,
    )
    const key: VerifyKey = { alg, publicKey }
    const result = await verifyJwt(token, key, {
      expectedIssuer: 'https://t.xid.dev',
      expectedAudience: 'client_1',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.header.kid).toBe(kid)
      expect(result.value.payload.sub).toBe('user_1')
    }
  })

  it('header carries typ=JWT and kid', async () => {
    const { signingKey, publicKey, kid } = await setup('ES256')
    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt(
      { header: { alg: 'ES256', kid }, payload: { exp: now + 60, iat: now } },
      signingKey,
    )
    const result = await verifyJwt(token, { alg: 'ES256', publicKey })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.header.typ).toBe('JWT')
  })
})

describe('verifyJwt rejection cases', () => {
  it('rejects an expired token', async () => {
    const { signingKey, publicKey, kid } = await setup('ES256')
    const past = 1700000000
    const token = await signJwt(
      { header: { alg: 'ES256', kid }, payload: { exp: past, iat: past - 3600 } },
      signingKey,
    )
    const result = await verifyJwt(token, { alg: 'ES256', publicKey })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.reason).toBe('expired')
  })

  it('rejects a token issued in the future', async () => {
    const { signingKey, publicKey, kid } = await setup('ES256')
    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt(
      { header: { alg: 'ES256', kid }, payload: { iat: now + 100000, exp: now + 200000 } },
      signingKey,
    )
    const result = await verifyJwt(token, { alg: 'ES256', publicKey })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.reason).toBe('issued_in_future')
  })

  it('rejects a tampered payload (bad signature)', async () => {
    const { signingKey, publicKey, kid } = await setup('ES256')
    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt(
      { header: { alg: 'ES256', kid }, payload: { sub: 'user_1', exp: now + 60, iat: now } },
      signingKey,
    )
    const [h, , s] = token.split('.')
    const forgedPayload = btoa(JSON.stringify({ sub: 'attacker', exp: now + 60, iat: now }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '')
    const result = await verifyJwt(`${h}.${forgedPayload}.${s}`, { alg: 'ES256', publicKey })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.reason).toBe('bad_signature')
  })

  it('rejects an unknown kid against a JWKS key set', async () => {
    const { signingKey, kid } = await setup('ES256', 'real-kid')
    const other = await setup('ES256', 'other-kid')
    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt(
      { header: { alg: 'ES256', kid }, payload: { exp: now + 60, iat: now } },
      signingKey,
    )
    const keySet: VerifyKeySet = {
      keys: [{ kid: 'other-kid', alg: 'ES256', publicKey: other.publicKey }],
    }
    const result = await verifyJwt(token, keySet)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.reason).toBe('unknown_kid')
  })

  it('selects the right public key by kid from a multi-kid JWKS', async () => {
    const a = await setup('ES256', 'kid-a')
    const b = await setup('ES256', 'kid-b')
    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt(
      { header: { alg: 'ES256', kid: 'kid-b' }, payload: { exp: now + 60, iat: now } },
      b.signingKey,
    )
    const keySet: VerifyKeySet = {
      keys: [
        { kid: 'kid-a', alg: 'ES256', publicKey: a.publicKey },
        { kid: 'kid-b', alg: 'ES256', publicKey: b.publicKey },
      ],
    }
    const result = await verifyJwt(token, keySet)
    expect(result.ok).toBe(true)
  })

  it('rejects issuer mismatch', async () => {
    const { signingKey, publicKey, kid } = await setup('ES256')
    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt(
      {
        header: { alg: 'ES256', kid },
        payload: { iss: 'https://evil.dev', exp: now + 60, iat: now },
      },
      signingKey,
    )
    const result = await verifyJwt(
      token,
      { alg: 'ES256', publicKey },
      { expectedIssuer: 'https://t.xid.dev' },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.reason).toBe('issuer_mismatch')
  })

  it('rejects audience mismatch', async () => {
    const { signingKey, publicKey, kid } = await setup('ES256')
    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt(
      { header: { alg: 'ES256', kid }, payload: { aud: 'client_x', exp: now + 60, iat: now } },
      signingKey,
    )
    const result = await verifyJwt(
      token,
      { alg: 'ES256', publicKey },
      { expectedAudience: 'client_y' },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.reason).toBe('audience_mismatch')
  })

  it('rejects an alg that does not match the resolved key alg', async () => {
    const { signingKey, publicKey, kid } = await setup('ES256')
    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt(
      { header: { alg: 'ES256', kid }, payload: { exp: now + 60, iat: now } },
      signingKey,
    )
    const result = await verifyJwt(token, { alg: 'RS256', publicKey })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.reason).toBe('unsupported_alg')
  })

  it('rejects a malformed token', async () => {
    const { publicKey } = await setup('ES256')
    const result = await verifyJwt('not.a.jwt.token', { alg: 'ES256', publicKey })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.reason).toBe('malformed')
  })
})
