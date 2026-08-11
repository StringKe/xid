import { describe, expect, it } from 'vitest'

import { deriveS256Challenge, generateBase64UrlRandom, generatePkce } from '../pkce'

// 无 crypto.subtle 时跳过依赖 Web Crypto 的用例（真机 WebView 始终有）。
function ensureWebCrypto() {
  return typeof globalThis.crypto?.subtle !== 'undefined'
}

describe('generateBase64UrlRandom', () => {
  it('returns a string of correct approximate length for 32 bytes', () => {
    const result = generateBase64UrlRandom(32)

    expect(result).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(result.length).toBeGreaterThanOrEqual(42)
    expect(result.length).toBeLessThanOrEqual(44)
  })

  it('contains no base64 padding characters', () => {
    const result = generateBase64UrlRandom(64)

    expect(result).not.toContain('=')
    expect(result).not.toContain('+')
    expect(result).not.toContain('/')
  })

  it('produces distinct values on each call', () => {
    const a = generateBase64UrlRandom(32)
    const b = generateBase64UrlRandom(32)

    expect(a).not.toBe(b)
  })
})

describe('deriveS256Challenge', () => {
  it('derives a known S256 challenge from a fixed verifier', async () => {
    if (!ensureWebCrypto()) return

    // RFC 7636 Appendix B 向量。
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const challenge = await deriveS256Challenge(verifier)

    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('returns a base64url string without padding', async () => {
    if (!ensureWebCrypto()) return

    const challenge = await deriveS256Challenge('some-test-verifier')

    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(challenge).not.toContain('=')
  })
})

describe('generatePkce', () => {
  it('returns method S256', async () => {
    if (!ensureWebCrypto()) return

    const pkce = await generatePkce()

    expect(pkce.method).toBe('S256')
  })

  it('verifier and challenge are consistent (challenge == S256(verifier))', async () => {
    if (!ensureWebCrypto()) return

    const pkce = await generatePkce()
    const expected = await deriveS256Challenge(pkce.verifier)

    expect(pkce.challenge).toBe(expected)
  })

  it('verifier is at least 43 chars (PKCE spec minimum entropy)', async () => {
    if (!ensureWebCrypto()) return

    const pkce = await generatePkce()

    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43)
  })
})
