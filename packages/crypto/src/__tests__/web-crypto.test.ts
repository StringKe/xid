// Web Crypto 可用性自检(见 crypto-boundary rule:密码学原语只用 Web Crypto,禁止自研)。
// 验证测试环境中 crypto.subtle 全部必要操作可用。

import { describe, it, expect } from 'vitest'

describe('Web Crypto availability (crypto-boundary rule)', () => {
  it('crypto.subtle is available', () => {
    expect(typeof crypto).toBe('object')
    expect(typeof crypto.subtle).toBe('object')
  })

  it('crypto.getRandomValues generates distinct values', () => {
    const a = crypto.getRandomValues(new Uint8Array(32))
    const b = crypto.getRandomValues(new Uint8Array(32))
    // 密码学安全随机数:两次调用结果应不同
    expect(a).not.toEqual(b)
  })

  it('AES-256-GCM key generation succeeds (envelope encryption KEK material)', async () => {
    const key = (await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false, // 不可导出,符合 signing-keys rule 私钥不入库
      ['encrypt', 'decrypt'],
    )) as CryptoKey
    expect(key.type).toBe('secret')
    expect(key.algorithm.name).toBe('AES-GCM')
  })

  it('ECDSA P-256 key generation succeeds (ES256 per-tenant signing key)', async () => {
    const { privateKey, publicKey } = (await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair
    expect(privateKey.type).toBe('private')
    expect(publicKey.type).toBe('public')
  })

  it('SHA-256 digest produces 32-byte output', async () => {
    const input = new TextEncoder().encode('test input for sha256')
    const digest = await crypto.subtle.digest('SHA-256', input)
    expect(digest.byteLength).toBe(32)
  })

  it('AES-GCM encrypt/decrypt round-trip succeeds', async () => {
    const key = (await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])) as CryptoKey
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const plaintext = new TextEncoder().encode('envelope-encrypted private key material')

    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
    const decryptedText = new TextDecoder().decode(decrypted)

    expect(decryptedText).toBe('envelope-encrypted private key material')
  })
})
