import { describe, expect, it } from 'vitest'
import { normalizePublicJwks } from '../client-jwks'

const PUBLIC_EC_KEY = {
  kid: 'ec-1',
  kty: 'EC',
  alg: 'ES256',
  crv: 'P-256',
  x: 'AQID',
  y: 'BAUG',
}

describe('normalizePublicJwks', () => {
  it('normalizes a public signing key to the strict verification shape', () => {
    const result = normalizePublicJwks({
      keys: [{ ...PUBLIC_EC_KEY, ext: true, x5u: 'https://ignored.example/jwk.pem' }],
    })

    expect(result).toEqual({
      ok: true,
      value: {
        keys: [
          {
            kid: 'ec-1',
            kty: 'EC',
            alg: 'ES256',
            use: 'sig',
            key_ops: ['verify'],
            crv: 'P-256',
            x: 'AQID',
            y: 'BAUG',
          },
        ],
      },
    })
  })

  it('requires a non-empty key set and unique non-empty kid values', () => {
    expect(normalizePublicJwks({ keys: [] }).ok).toBe(false)
    expect(normalizePublicJwks({ keys: [{ ...PUBLIC_EC_KEY, kid: '' }] }).ok).toBe(false)
    expect(normalizePublicJwks({ keys: [PUBLIC_EC_KEY, PUBLIC_EC_KEY] }).ok).toBe(false)
  })

  it.each(['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'])(
    'rejects private or symmetric key member %s',
    (member) => {
      expect(normalizePublicJwks({ keys: [{ ...PUBLIC_EC_KEY, [member]: 'secret' }] }).ok).toBe(
        false,
      )
    },
  )

  it('rejects symmetric, mismatched algorithm, non-signing use, and signing key_ops', () => {
    expect(
      normalizePublicJwks({
        keys: [{ kid: 'oct-1', kty: 'oct', alg: 'ES256', k: 'secret' }],
      }).ok,
    ).toBe(false)
    expect(normalizePublicJwks({ keys: [{ ...PUBLIC_EC_KEY, alg: 'RS256' }] }).ok).toBe(false)
    expect(normalizePublicJwks({ keys: [{ ...PUBLIC_EC_KEY, use: 'enc' }] }).ok).toBe(false)
    expect(
      normalizePublicJwks({ keys: [{ ...PUBLIC_EC_KEY, key_ops: ['sign', 'verify'] }] }).ok,
    ).toBe(false)
  })

  it('accepts RSA public keys only for RS256 and PS256', () => {
    for (const alg of ['RS256', 'PS256']) {
      const result = normalizePublicJwks({
        keys: [{ kid: `rsa-${alg}`, kty: 'RSA', alg, n: 'AQID', e: 'AQAB' }],
      })
      expect(result.ok).toBe(true)
    }
  })
})
