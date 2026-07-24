// DPoP proof 校验正反例(RFC9449、03 章 9.8):合法通过;typ/alg/签名篡改/htm/htu/iat 全拒。
import { describe, it, expect } from 'vitest'

import { verifyDpopProof, verifyDpopForResource, computeJkt, normalizeHtu } from '../dpop'

const HTM = 'POST'
const HTU = 'https://test.xid.dev/token'

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function b64urlStr(s: string): string {
  return b64url(new TextEncoder().encode(s))
}

async function buildProof(input: {
  header?: Record<string, unknown>
  payload?: Record<string, unknown>
  tamperSignature?: boolean
  now: number
}): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
  const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: publicJwk, ...input.header }
  const payload = {
    jti: crypto.randomUUID(),
    htm: HTM,
    htu: HTU,
    iat: input.now,
    ...input.payload,
  }
  const signingInput = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(payload))}`
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.privateKey,
      new TextEncoder().encode(signingInput),
    ),
  )
  let sigStr = b64url(sig)
  if (input.tamperSignature) {
    const flipped = new Uint8Array(sig)
    flipped[0] = flipped[0]! ^ 0xff
    sigStr = b64url(flipped)
  }
  return `${signingInput}.${sigStr}`
}

// 返回 proof 字符串 + 公钥 jwk(供资源端 jkt/ath 断言)。
async function buildProofWithJwk(input: {
  header?: Record<string, unknown>
  payload?: Record<string, unknown>
  now: number
}): Promise<{ proof: string; jwk: JsonWebKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const exported = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
  const publicJwk = { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y }
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: publicJwk, ...input.header }
  const payload = {
    jti: crypto.randomUUID(),
    htm: HTM,
    htu: HTU,
    iat: input.now,
    ...input.payload,
  }
  const signingInput = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(payload))}`
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.privateKey,
      new TextEncoder().encode(signingInput),
    ),
  )
  return { proof: `${signingInput}.${b64url(sig)}`, jwk: publicJwk }
}

async function athFor(accessToken: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken)),
  )
  return b64url(digest)
}

const NOW = 1_900_000_000

describe('verifyDpopProof valid path', () => {
  it('accepts a well-formed proof and derives jkt', async () => {
    const proof = await buildProof({ now: NOW })
    const r = await verifyDpopProof({ proof, expectedHtm: HTM, expectedHtu: HTU, now: NOW })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.jkt).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(r.value.htu).toBe(HTU)
    }
  })

  it('normalizes htu by dropping query and fragment', async () => {
    const proof = await buildProof({ now: NOW, payload: { htu: `${HTU}?x=1#frag` } })
    const r = await verifyDpopProof({
      proof,
      expectedHtm: HTM,
      expectedHtu: `${HTU}?y=2`,
      now: NOW,
    })
    expect(r.ok).toBe(true)
  })
})

describe('verifyDpopProof rejects tampering', () => {
  it('rejects tampered signature', async () => {
    const proof = await buildProof({ now: NOW, tamperSignature: true })
    const r = await verifyDpopProof({ proof, expectedHtm: HTM, expectedHtu: HTU, now: NOW })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_dpop_proof')
  })

  it('rejects wrong typ', async () => {
    const proof = await buildProof({ now: NOW, header: { typ: 'jwt' } })
    const r = await verifyDpopProof({ proof, expectedHtm: HTM, expectedHtu: HTU, now: NOW })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_dpop_proof')
  })

  it('rejects alg=none', async () => {
    const proof = await buildProof({ now: NOW, header: { alg: 'none' } })
    const r = await verifyDpopProof({ proof, expectedHtm: HTM, expectedHtu: HTU, now: NOW })
    expect(r.ok).toBe(false)
  })

  it('rejects jwk carrying private parameter d', async () => {
    const proof = await buildProof({
      now: NOW,
      header: { jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'secret' } },
    })
    const r = await verifyDpopProof({ proof, expectedHtm: HTM, expectedHtu: HTU, now: NOW })
    expect(r.ok).toBe(false)
  })

  it('rejects htm mismatch', async () => {
    const proof = await buildProof({ now: NOW, payload: { htm: 'GET' } })
    const r = await verifyDpopProof({ proof, expectedHtm: HTM, expectedHtu: HTU, now: NOW })
    expect(r.ok).toBe(false)
  })

  it('rejects htu mismatch', async () => {
    const proof = await buildProof({ now: NOW, payload: { htu: 'https://evil.example.com/token' } })
    const r = await verifyDpopProof({ proof, expectedHtm: HTM, expectedHtu: HTU, now: NOW })
    expect(r.ok).toBe(false)
  })

  it('rejects iat outside window', async () => {
    const proof = await buildProof({ now: NOW - 600 })
    const r = await verifyDpopProof({ proof, expectedHtm: HTM, expectedHtu: HTU, now: NOW })
    expect(r.ok).toBe(false)
  })

  it('rejects missing jti', async () => {
    const proof = await buildProof({ now: NOW, payload: { jti: undefined } })
    const r = await verifyDpopProof({ proof, expectedHtm: HTM, expectedHtu: HTU, now: NOW })
    expect(r.ok).toBe(false)
  })

  it('rejects non-compact proof', async () => {
    const r = await verifyDpopProof({
      proof: 'not.a.valid',
      expectedHtm: HTM,
      expectedHtu: HTU,
      now: NOW,
    })
    expect(r.ok).toBe(false)
  })
})

const ACCESS_TOKEN = 'at_example_token_value'

describe('verifyDpopForResource sender-constrained', () => {
  it('accepts proof with correct ath and matching jkt', async () => {
    const ath = await athFor(ACCESS_TOKEN)
    const { proof, jwk } = await buildProofWithJwk({ now: NOW, payload: { ath } })
    const boundJkt = (await computeJkt(jwk))!
    const r = await verifyDpopForResource({
      proof,
      expectedHtm: HTM,
      expectedHtu: HTU,
      now: NOW,
      accessToken: ACCESS_TOKEN,
      boundJkt,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.jkt).toBe(boundJkt)
  })

  it('rejects missing ath', async () => {
    const { proof, jwk } = await buildProofWithJwk({ now: NOW })
    const boundJkt = (await computeJkt(jwk))!
    const r = await verifyDpopForResource({
      proof,
      expectedHtm: HTM,
      expectedHtu: HTU,
      now: NOW,
      accessToken: ACCESS_TOKEN,
      boundJkt,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_dpop_proof')
  })

  it('rejects ath bound to a different access token', async () => {
    const ath = await athFor('some_other_token')
    const { proof, jwk } = await buildProofWithJwk({ now: NOW, payload: { ath } })
    const boundJkt = (await computeJkt(jwk))!
    const r = await verifyDpopForResource({
      proof,
      expectedHtm: HTM,
      expectedHtu: HTU,
      now: NOW,
      accessToken: ACCESS_TOKEN,
      boundJkt,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_dpop_proof')
  })

  it('rejects jkt that does not match the bound token', async () => {
    const ath = await athFor(ACCESS_TOKEN)
    const { proof } = await buildProofWithJwk({ now: NOW, payload: { ath } })
    const r = await verifyDpopForResource({
      proof,
      expectedHtm: HTM,
      expectedHtu: HTU,
      now: NOW,
      accessToken: ACCESS_TOKEN,
      boundJkt: 'a-different-thumbprint',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_dpop_proof')
  })
})

describe('verifyDpopProof nonce requirement', () => {
  it('returns use_dpop_nonce when nonce required but absent', async () => {
    const proof = await buildProof({ now: NOW })
    const r = await verifyDpopProof({
      proof,
      expectedHtm: HTM,
      expectedHtu: HTU,
      now: NOW,
      requireNonce: true,
      validNonce: 'expected-nonce',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('use_dpop_nonce')
  })

  it('returns use_dpop_nonce when nonce mismatches', async () => {
    const proof = await buildProof({ now: NOW, payload: { nonce: 'stale-nonce' } })
    const r = await verifyDpopProof({
      proof,
      expectedHtm: HTM,
      expectedHtu: HTU,
      now: NOW,
      requireNonce: true,
      validNonce: 'expected-nonce',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('use_dpop_nonce')
  })

  it('accepts proof when nonce matches required value', async () => {
    const proof = await buildProof({ now: NOW, payload: { nonce: 'expected-nonce' } })
    const r = await verifyDpopProof({
      proof,
      expectedHtm: HTM,
      expectedHtu: HTU,
      now: NOW,
      requireNonce: true,
      validNonce: 'expected-nonce',
    })
    expect(r.ok).toBe(true)
  })
})

describe('computeJkt / normalizeHtu', () => {
  it('computeJkt returns null for unsupported jwk', async () => {
    const jkt = await computeJkt({ kty: 'oct' })
    expect(jkt).toBeNull()
  })

  it('normalizeHtu strips query and fragment', () => {
    expect(normalizeHtu('https://h/token?a=1#x')).toBe('https://h/token')
  })
})
