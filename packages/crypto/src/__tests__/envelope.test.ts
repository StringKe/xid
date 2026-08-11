import { describe, it, expect } from 'vitest'

import { envelopeEncrypt, envelopeDecrypt } from '../envelope'

function randomKek(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}

describe('envelope encryption (AES-256-GCM)', () => {
  it('round-trips plaintext through encrypt/decrypt', async () => {
    const kek = randomKek()
    const plaintext = new TextEncoder().encode('per-tenant signing private key material')
    const blob = await envelopeEncrypt(plaintext, kek, 1)

    expect(blob.iv.byteLength).toBe(12)
    expect(blob.tag.byteLength).toBe(16)
    expect(blob.kekVersion).toBe(1)

    const decrypted = await envelopeDecrypt(blob, kek)
    expect(new TextDecoder().decode(decrypted)).toBe('per-tenant signing private key material')
  })

  it('produces a fresh random iv each call (no GCM iv reuse)', async () => {
    const kek = randomKek()
    const pt = new TextEncoder().encode('x')
    const a = await envelopeEncrypt(pt, kek, 1)
    const b = await envelopeEncrypt(pt, kek, 1)
    expect(a.iv).not.toEqual(b.iv)
  })

  it('rejects decryption with a wrong KEK (GCM tag mismatch)', async () => {
    const blob = await envelopeEncrypt(new TextEncoder().encode('secret'), randomKek(), 1)
    await expect(envelopeDecrypt(blob, randomKek())).rejects.toThrow()
  })

  it('rejects decryption when ciphertext is tampered', async () => {
    const kek = randomKek()
    const blob = await envelopeEncrypt(new TextEncoder().encode('secret'), kek, 1)
    blob.ciphertext.set([(blob.ciphertext[0] ?? 0) ^ 0xff], 0)
    await expect(envelopeDecrypt(blob, kek)).rejects.toThrow()
  })

  it('rejects decryption when tag is tampered', async () => {
    const kek = randomKek()
    const blob = await envelopeEncrypt(new TextEncoder().encode('secret'), kek, 1)
    blob.tag.set([(blob.tag[0] ?? 0) ^ 0xff], 0)
    await expect(envelopeDecrypt(blob, kek)).rejects.toThrow()
  })

  it('rejects a KEK that is not 32 bytes', async () => {
    await expect(
      envelopeEncrypt(new TextEncoder().encode('x'), new Uint8Array(16), 1),
    ).rejects.toThrow(/32 bytes/)
  })
})
