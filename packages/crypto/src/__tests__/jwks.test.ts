// JWKS:多 kid 公钥并存输出 + 公钥 JWK 导出/导入互验(见 signing-keys rule)。
import { describe, it, expect } from 'vitest'

import { generateTenantSigningKey } from '../signing-key'
import { buildJwks, exportPublicJwk, importJwkForVerify } from '../jwks'
import { signJwt, verifyJwt } from '../jwt'

function randomKek(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}

describe('buildJwks', () => {
  it('outputs all kids (active/next/retiring) with use=sig', async () => {
    const kek = randomKek()
    const a = await generateTenantSigningKey({
      kid: 'kid-a',
      kekRaw: kek,
      kekVersion: 1,
      status: 'active',
    })
    const n = await generateTenantSigningKey({
      kid: 'kid-n',
      kekRaw: kek,
      kekVersion: 1,
      status: 'next',
    })
    const r = await generateTenantSigningKey({
      kid: 'kid-r',
      kekRaw: kek,
      kekVersion: 1,
      status: 'retiring',
    })

    const jwks = buildJwks([a.material, n.material, r.material])
    expect(jwks.keys.map((k) => k.kid)).toEqual(['kid-a', 'kid-n', 'kid-r'])
    expect(jwks.keys.every((k) => k.use === 'sig')).toBe(true)
    expect(jwks.keys.every((k) => k.d === undefined)).toBe(true) // 无私钥字段
  })
})

describe('exportPublicJwk / importJwkForVerify', () => {
  it('exported JWK re-imports and verifies a token signed by its private key', async () => {
    const kek = randomKek()
    const { material, signingKey } = await generateTenantSigningKey({
      kid: 'kid-1',
      kekRaw: kek,
      kekVersion: 1,
    })

    const jwks = buildJwks([material])
    const jwk = jwks.keys[0]
    expect(jwk).toBeDefined()
    if (!jwk) return
    const publicKey = await importJwkForVerify(jwk)

    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt(
      { header: { alg: 'ES256', kid: 'kid-1' }, payload: { exp: now + 60, iat: now } },
      signingKey,
    )
    const result = await verifyJwt(token, { alg: 'ES256', publicKey })
    expect(result.ok).toBe(true)
  })

  it('exportPublicJwk attaches kid/use/alg', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    const jwk = await exportPublicJwk(pair.publicKey, 'kid-x', 'ES256')
    expect(jwk.kid).toBe('kid-x')
    expect(jwk.use).toBe('sig')
    expect(jwk.alg).toBe('ES256')
  })
})
