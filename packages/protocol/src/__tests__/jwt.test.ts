// JWT 向量自检测试(见 oidc-oauth rule 3.2 Token + testing rule)。
// 验证 jwt-vectors.ts 中的 helper 与向量正确:合法 JWT 结构/过期样本/jti 重放样本。
// 业务实现未落地时可独立运行。

import { describe, it, expect, beforeAll } from 'vitest'
import {
  buildValidJwtVectors,
  EXPIRED_JWT_SAMPLES,
  JTI_REPLAY_SAMPLES,
  decodeJwtHeader,
  decodeJwtPayload,
  generateEs256KeyPair,
  signJwt,
  type ValidJwtVector,
} from './fixtures/jwt-vectors'

describe('valid JWT vectors self-check', () => {
  let vectors: ValidJwtVector[]

  beforeAll(async () => {
    vectors = await buildValidJwtVectors()
  })

  it('builds 2 valid JWT vectors', () => {
    expect(vectors).toHaveLength(2)
  })

  it('each token has 3 parts (header.payload.signature)', () => {
    for (const v of vectors) {
      const parts = v.token.split('.')
      expect(parts).toHaveLength(3)
    }
  })

  it('header alg is ES256', () => {
    for (const v of vectors) {
      const header = decodeJwtHeader(v.token)
      expect(header.alg).toBe('ES256')
    }
  })

  it('header kid matches expected', () => {
    for (const v of vectors) {
      const header = decodeJwtHeader(v.token)
      expect(header.kid).toBe(v.kid)
    }
  })

  it('payload iss/sub/aud/exp/iat/jti present', () => {
    for (const v of vectors) {
      const payload = decodeJwtPayload(v.token)
      expect(payload.iss).toBeTruthy()
      expect(payload.sub).toBeTruthy()
      expect(payload.aud).toBeTruthy()
      expect(typeof payload.exp).toBe('number')
      expect(typeof payload.iat).toBe('number')
      expect(payload.jti).toBeTruthy()
    }
  })

  it('exp > iat (not yet expired)', () => {
    const now = Math.floor(Date.now() / 1000)
    for (const v of vectors) {
      const payload = decodeJwtPayload(v.token)
      expect(payload.exp).toBeGreaterThan(payload.iat)
      expect(payload.exp).toBeGreaterThan(now)
    }
  })

  it('ES256 signature verifies against public key', async () => {
    for (const v of vectors) {
      const parts = v.token.split('.')
      if (!parts[0] || !parts[1] || !parts[2]) throw new Error('malformed token')
      const signingInput = `${parts[0]}.${parts[1]}`
      // decode base64url signature
      const sigB64 = parts[2]
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(parts[2].length + ((4 - (parts[2].length % 4)) % 4), '=')
      const sigBytes = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0))

      const valid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        v.publicKey,
        sigBytes,
        new TextEncoder().encode(signingInput),
      )
      expect(valid).toBe(true)
    }
  })

  it('signature verification fails with wrong key', async () => {
    const vector = vectors[0]!
    const wrongKeyPair = await generateEs256KeyPair()
    const parts = vector.token.split('.')
    if (!parts[0] || !parts[1] || !parts[2]) throw new Error('malformed token')
    const signingInput = `${parts[0]}.${parts[1]}`
    const sigB64 = parts[2]
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(parts[2].length + ((4 - (parts[2].length % 4)) % 4), '=')
    const sigBytes = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0))

    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      wrongKeyPair.publicKey,
      sigBytes,
      new TextEncoder().encode(signingInput),
    )
    expect(valid).toBe(false)
  })
})

describe('expired JWT samples', () => {
  it('has expired samples defined', () => {
    expect(EXPIRED_JWT_SAMPLES.length).toBeGreaterThan(0)
  })

  it('all expired sample payloads have exp in the past', () => {
    const now = Math.floor(Date.now() / 1000)
    for (const s of EXPIRED_JWT_SAMPLES) {
      expect(s.expiredPayload.exp).toBeLessThan(now)
    }
  })

  it('expired samples carry expected error codes', () => {
    const validCodes = new Set(['invalid_grant', 'session_expired'])
    for (const s of EXPIRED_JWT_SAMPLES) {
      expect(validCodes.has(s.expectedErrorCode)).toBe(true)
    }
  })
})

describe('jti replay samples', () => {
  it('has replay samples defined', () => {
    expect(JTI_REPLAY_SAMPLES.length).toBeGreaterThan(0)
  })

  it('all replay samples have unique jti strings', () => {
    const jtis = new Set(JTI_REPLAY_SAMPLES.map((s) => s.jti))
    expect(jtis.size).toBe(JTI_REPLAY_SAMPLES.length)
  })

  it('replay samples carry expected error codes', () => {
    const validCodes = new Set(['refresh_token_reused', 'invalid_grant'])
    for (const s of JTI_REPLAY_SAMPLES) {
      expect(validCodes.has(s.expectedErrorCode)).toBe(true)
    }
  })
})

describe('sign + decode round-trip', () => {
  it('signed JWT payload survives base64url round-trip', async () => {
    const { privateKey } = await generateEs256KeyPair()
    const now = Math.floor(Date.now() / 1000)
    const payload = {
      iss: 'https://roundtrip.xid.dev',
      sub: 'user_rt_001',
      aud: 'client_rt',
      exp: now + 60,
      iat: now,
      jti: 'jti-rt-001',
      scope: 'openid',
    }

    const token = await signJwt(payload, privateKey, 'kid-rt-001')
    const decoded = decodeJwtPayload(token)

    expect(decoded.iss).toBe(payload.iss)
    expect(decoded.sub).toBe(payload.sub)
    expect(decoded.jti).toBe(payload.jti)
    expect(decoded.exp).toBe(payload.exp)
  })
})
