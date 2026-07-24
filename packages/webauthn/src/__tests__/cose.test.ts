import { describe, it, expect } from 'vitest'

import { parseCoseKey, parseCoseKeyAt } from '../cose'
import { generateAssertionKeyPair } from './fixtures/assertion-vectors'

function coseEncodeEs256(rawPublicKey: Uint8Array): Uint8Array {
  const x = rawPublicKey.subarray(1, 33)
  const y = rawPublicKey.subarray(33, 65)
  const out: number[] = []
  out.push(0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01)
  out.push(0x21, 0x58, 0x20, ...x)
  out.push(0x22, 0x58, 0x20, ...y)
  return new Uint8Array(out)
}

describe('parseCoseKey', () => {
  it('imports ES256 EC2 COSE key', async () => {
    const pair = await generateAssertionKeyPair()
    const raw = new Uint8Array(
      (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer,
    )
    const parsed = await parseCoseKey(coseEncodeEs256(raw))
    expect(parsed.alg).toBe(-7)
    expect(parsed.key.type).toBe('public')
  })

  it('rejects unsupported kty', async () => {
    const bad = new Uint8Array([0xa2, 0x01, 0x04, 0x03, 0x26])
    await expect(parseCoseKey(bad)).rejects.toThrow(/unsupported kty/)
  })

  it('imports EdDSA OKP COSE key', async () => {
    const x = new Uint8Array(32).fill(7)
    const out: number[] = []
    out.push(0xa4, 0x01, 0x01, 0x03, 0x27, 0x20, 0x06)
    out.push(0x21, 0x58, 0x20, ...x)
    const parsed = await parseCoseKey(new Uint8Array(out))
    expect(parsed.alg).toBe(-8)
    expect(parsed.key.type).toBe('public')
  })
})

describe('parseCoseKeyAt', () => {
  it('parses COSE key embedded in larger buffer', async () => {
    const pair = await generateAssertionKeyPair()
    const raw = new Uint8Array(
      (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer,
    )
    const cose = coseEncodeEs256(raw)
    const buffer = new Uint8Array(cose.length + 2)
    buffer.set(cose, 0)
    buffer.set([0xff, 0xff], cose.length)

    const { parsed, bytesUsed, coseBytes } = await parseCoseKeyAt(buffer, 0)
    expect(parsed.alg).toBe(-7)
    expect(bytesUsed).toBe(cose.length)
    expect(coseBytes).toEqual(cose)
  })
})
