import { describe, expect, it } from 'vitest'

import {
  base64UrlEncode,
  createPkceChallenge,
  createPkceVerifier,
  createRandomString,
} from '../pkce'

describe('base64UrlEncode', () => {
  it('produces url-safe characters (no +, /, =)', () => {
    const bytes = new Uint8Array(64)
    for (let i = 0; i < 64; i++) bytes[i] = i
    const result = base64UrlEncode(bytes)
    expect(result).not.toContain('+')
    expect(result).not.toContain('/')
    expect(result).not.toContain('=')
  })

  it('encodes empty bytes to empty string', () => {
    expect(base64UrlEncode(new Uint8Array(0))).toBe('')
  })
})

describe('createRandomString', () => {
  it('returns a string of the requested length', () => {
    expect(createRandomString(64)).toHaveLength(64)
    expect(createRandomString(32)).toHaveLength(32)
  })

  it('returns distinct values on consecutive calls', () => {
    const a = createRandomString(32)
    const b = createRandomString(32)
    expect(a).not.toBe(b)
  })

  it('uses a SecureStore-safe base64url alphabet for state and nonce keys', () => {
    for (let index = 0; index < 100; index += 1) {
      expect(createRandomString(64)).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })
})

describe('createPkceVerifier', () => {
  it('returns a string of requested length (43-128 range)', () => {
    const verifier = createPkceVerifier(64)
    expect(verifier.length).toBe(64)
  })

  it('only uses RFC 7636 allowed characters [A-Za-z0-9._~-]', () => {
    const verifier = createPkceVerifier(64)
    expect(verifier).toMatch(/^[A-Za-z0-9._~-]+$/)
  })

  it('returns distinct values on consecutive calls', () => {
    const a = createPkceVerifier(64)
    const b = createPkceVerifier(64)
    expect(a).not.toBe(b)
  })
})

describe('createPkceChallenge', () => {
  it('returns a non-empty base64url string for a given verifier', async () => {
    const verifier = createPkceVerifier(64)
    const challenge = await createPkceChallenge(verifier)
    expect(challenge.length).toBeGreaterThan(0)
    expect(challenge).not.toContain('+')
    expect(challenge).not.toContain('/')
    expect(challenge).not.toContain('=')
  })

  it('is deterministic: same verifier -> same challenge', async () => {
    const verifier = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.-'
    const c1 = await createPkceChallenge(verifier)
    const c2 = await createPkceChallenge(verifier)
    expect(c1).toBe(c2)
  })

  it('different verifiers produce different challenges', async () => {
    const c1 = await createPkceChallenge(createPkceVerifier(64))
    const c2 = await createPkceChallenge(createPkceVerifier(64))
    expect(c1).not.toBe(c2)
  })

  // RFC 7636 Appendix B 已知 S256 向量（verifier / challenge 字面量不可改）。
  it('matches RFC 7636 known S256 vector', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const challenge = await createPkceChallenge(verifier)
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })
})
