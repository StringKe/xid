import type { SigningAlg } from '@xid-kit/types'
import { describe, it, expect } from 'vitest'

import { envelopeDecrypt } from '../envelope'
import { generateTenantSigningKey, loadSigningKey, planRotation } from '../signing-key'

function randomKek(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}

const ALGS: SigningAlg[] = ['ES256', 'RS256', 'PS256']

describe('generateTenantSigningKey', () => {
  it.each(ALGS)('generates a non-extractable signing key for %s', async (alg) => {
    const kek = randomKek()
    const { material, signingKey } = await generateTenantSigningKey({
      kid: 'kid-001',
      kekRaw: kek,
      kekVersion: 1,
      alg,
    })

    expect(material.kid).toBe('kid-001')
    expect(material.alg).toBe(alg)
    expect(material.status).toBe('next')
    expect(signingKey.extractable).toBe(false)
    expect(signingKey.usages).toEqual(['sign'])
    expect(material.encryptedPrivateKey.kekVersion).toBe(1)
  })

  it('material public JWK never contains private key fields (ES256 d / RSA d,p,q)', async () => {
    const { material } = await generateTenantSigningKey({
      kid: 'k',
      kekRaw: randomKek(),
      kekVersion: 1,
    })
    const jwk = material.publicKeyJwk
    expect(jwk.d).toBeUndefined()
    expect(jwk.p).toBeUndefined()
    expect(jwk.q).toBeUndefined()
    expect(jwk.crv).toBe('P-256')
  })

  it('private key only persists as ciphertext; decrypting yields valid PKCS8 reloadable as signer', async () => {
    const kek = randomKek()
    const { material } = await generateTenantSigningKey({ kid: 'k', kekRaw: kek, kekVersion: 1 })

    const enc = material.encryptedPrivateKey
    expect(enc.ciphertext.byteLength).toBeGreaterThan(0)
    expect(enc.iv.byteLength).toBe(12)
    expect(enc.tag.byteLength).toBe(16)

    // 密文可解密为可重载 PKCS8,证明落库的是信封密文而非明文私钥。
    const pkcs8 = await envelopeDecrypt(enc, kek)
    expect(pkcs8.byteLength).toBeGreaterThan(0)
    const reloaded = await loadSigningKey(enc, kek)
    expect(reloaded.extractable).toBe(false)
  })

  it('loadSigningKey produces a key usable for signing', async () => {
    const kek = randomKek()
    const { material } = await generateTenantSigningKey({ kid: 'k', kekRaw: kek, kekVersion: 1 })
    const key = await loadSigningKey(material.encryptedPrivateKey, kek)
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new TextEncoder().encode('payload'),
    )
    expect(sig.byteLength).toBe(64)
  })
})

describe('planRotation (four-step rotation pure logic)', () => {
  it('publish_next adds the new kid as next, keeps existing', () => {
    const plan = planRotation([{ kid: 'old', status: 'active' }], 'publish_next', 'new')
    expect(plan).toEqual([
      { kid: 'old', status: 'active' },
      { kid: 'new', status: 'next' },
    ])
  })

  it('promote_active flips target next->active and old active->retiring', () => {
    const plan = planRotation(
      [
        { kid: 'old', status: 'active' },
        { kid: 'new', status: 'next' },
      ],
      'promote_active',
      'new',
    )
    expect(plan).toEqual([
      { kid: 'old', status: 'retiring' },
      { kid: 'new', status: 'active' },
    ])
  })

  it('retire_old removes the retired kid', () => {
    const plan = planRotation(
      [
        { kid: 'old', status: 'retiring' },
        { kid: 'new', status: 'active' },
      ],
      'retire_old',
      'old',
    )
    expect(plan).toEqual([{ kid: 'new', status: 'active' }])
  })
})
