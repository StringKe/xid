// PKCE 向量自检测试(见 oidc-oauth rule:PKCE S256 强制,拒 plain;testing rule)。
// 验证 pkce-vectors.ts 中的 helper 函数与向量本身正确。
// 业务实现未落地时这些测试可独立运行。

import { describe, it, expect, beforeAll } from 'vitest'
import {
  buildValidS256Vectors,
  PLAIN_CHALLENGE_REJECT_VECTORS,
  verifyS256Challenge,
  computeS256Challenge,
  type ValidPkceVector,
} from './fixtures/pkce-vectors'

describe('PKCE S256 vectors self-check', () => {
  let validVectors: ValidPkceVector[]

  beforeAll(async () => {
    validVectors = await buildValidS256Vectors()
  })

  it('builds 3 valid S256 vectors', () => {
    expect(validVectors).toHaveLength(3)
  })

  it('each vector has S256 method', () => {
    for (const v of validVectors) {
      expect(v.method).toBe('S256')
    }
  })

  it('each vector verifier length is within RFC7636 bounds (43-128)', () => {
    for (const v of validVectors) {
      expect(v.verifier.length).toBeGreaterThanOrEqual(43)
      expect(v.verifier.length).toBeLessThanOrEqual(128)
    }
  })

  it('each vector challenge matches S256(verifier)', async () => {
    for (const v of validVectors) {
      const isMatch = await verifyS256Challenge(v.verifier, v.challenge)
      expect(isMatch).toBe(true)
    }
  })

  it('challenge is base64url without padding', () => {
    for (const v of validVectors) {
      // base64url: no +, no /, no = padding
      expect(v.challenge).not.toContain('+')
      expect(v.challenge).not.toContain('/')
      expect(v.challenge).not.toContain('=')
    }
  })

  it('S256 challenge is 43 chars (SHA-256 = 32 bytes -> base64url = 43 chars)', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const challenge = await computeS256Challenge(verifier)
    // SHA-256 -> 32 bytes -> 43 base64url chars (32*8/6 = 42.67 -> ceil = 43)
    expect(challenge.length).toBe(43)
  })

  it('different verifiers produce different challenges', async () => {
    const challenges = new Set(validVectors.map((v) => v.challenge))
    expect(challenges.size).toBe(validVectors.length)
  })
})

describe('PKCE plain challenge reject vectors', () => {
  it('has reject vectors defined', () => {
    expect(PLAIN_CHALLENGE_REJECT_VECTORS.length).toBeGreaterThan(0)
  })

  it('all reject vectors have method=plain', () => {
    for (const v of PLAIN_CHALLENGE_REJECT_VECTORS) {
      expect(v.method).toBe('plain')
    }
  })

  it('all reject vectors carry expectedErrorCode=invalid_request', () => {
    for (const v of PLAIN_CHALLENGE_REJECT_VECTORS) {
      expect(v.expectedErrorCode).toBe('invalid_request')
    }
  })

  it('plain challenge equals verifier (downgrade: no real hash)', () => {
    for (const v of PLAIN_CHALLENGE_REJECT_VECTORS) {
      // plain method: challenge == verifier (no transform)
      expect(v.challenge).toBe(v.verifier)
    }
  })

  it('plain challenge does not equal S256(verifier)', async () => {
    for (const v of PLAIN_CHALLENGE_REJECT_VECTORS) {
      const s256Challenge = await computeS256Challenge(v.verifier)
      expect(v.challenge).not.toBe(s256Challenge)
    }
  })
})
