// WebAuthn assertion 向量自检测试(见 webauthn rule 四验证 + testing rule)。
// 验证 assertion-vectors.ts 中的辅助函数与向量本身正确。
// 业务实现未落地时可独立运行。

import { describe, it, expect } from 'vitest'
import {
  buildValidAssertionVector,
  buildOriginTamperedVector,
  buildRpIdHashTamperedVector,
  SIGN_COUNT_CLONE_VECTORS,
  detectSignCountAnomaly,
  buildAuthenticatorData,
} from './fixtures/assertion-vectors'

const TEST_RP_ID = 'test.xid.dev'
const TEST_ORIGIN = 'https://test.xid.dev'

describe('valid assertion vector', () => {
  it('builds assertion with correct structure', async () => {
    const {
      input,
      storedCredential,
      keyPair: _,
    } = await buildValidAssertionVector(TEST_RP_ID, TEST_ORIGIN, 1)

    expect(input.ceremony).toBe('authentication')
    expect(input.expectedRpId).toBe(TEST_RP_ID)
    expect(input.expectedOrigins).toContain(TEST_ORIGIN)
    expect(input.expectedChallenge).toHaveLength(32)
    expect(input.signature).toBeDefined()
    expect(input.storedCredential).toBeDefined()
    expect(storedCredential.coseAlg).toBe(-7) // ES256
  })

  it('clientDataJSON contains challenge and origin', async () => {
    const { input } = await buildValidAssertionVector(TEST_RP_ID, TEST_ORIGIN, 1)

    const clientDataStr = new TextDecoder().decode(input.clientDataJson)
    const clientData = JSON.parse(clientDataStr) as {
      type: string
      challenge: string
      origin: string
    }

    expect(clientData.type).toBe('webauthn.get')
    expect(clientData.origin).toBe(TEST_ORIGIN)
    expect(clientData.challenge).toBeTruthy()
  })

  it('authenticatorData has correct length (37 bytes minimum)', async () => {
    const { input } = await buildValidAssertionVector(TEST_RP_ID, TEST_ORIGIN, 1)
    // rpIdHash(32) + flags(1) + signCount(4) = 37
    expect(input.authenticatorData.length).toBeGreaterThanOrEqual(37)
  })

  it('authenticatorData rpIdHash matches SHA-256(rpId)', async () => {
    const { input } = await buildValidAssertionVector(TEST_RP_ID, TEST_ORIGIN, 1)
    const expectedHash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(TEST_RP_ID)),
    )
    const actualHash = input.authenticatorData.slice(0, 32)
    expect(actualHash).toEqual(expectedHash)
  })

  it('UV flag is set when userVerified=true', async () => {
    const authData = await buildAuthenticatorData({
      rpId: TEST_RP_ID,
      userVerified: true,
      signCount: 1,
    })
    const flags = authData[32]!
    // UV bit = 0x04
    expect(flags & 0x04).toBe(0x04)
  })

  it('UV flag is NOT set when userVerified=false', async () => {
    const authData = await buildAuthenticatorData({
      rpId: TEST_RP_ID,
      userVerified: false,
      signCount: 1,
    })
    const flags = authData[32]!
    expect(flags & 0x04).toBe(0)
  })

  it('signCount encoded correctly in authData big-endian', async () => {
    const expectedCount = 42
    const authData = await buildAuthenticatorData({
      rpId: TEST_RP_ID,
      userVerified: true,
      signCount: expectedCount,
    })
    const view = new DataView(authData.buffer)
    expect(view.getUint32(33, false)).toBe(expectedCount)
  })
})

describe('origin tampered vector (verification 2)', () => {
  it('builds origin-tampered vector with expected error code', async () => {
    const vector = await buildOriginTamperedVector(
      TEST_RP_ID,
      TEST_ORIGIN,
      'https://evil.attacker.com',
    )

    expect(vector.expectedErrorCode).toBe('origin_mismatch')
    expect(vector.input.expectedOrigins).toContain(TEST_ORIGIN)
    expect(vector.input.expectedOrigins).not.toContain('https://evil.attacker.com')
  })

  it('tampered clientDataJSON contains evil origin', async () => {
    const evilOrigin = 'https://evil.attacker.com'
    const vector = await buildOriginTamperedVector(TEST_RP_ID, TEST_ORIGIN, evilOrigin)

    const clientDataStr = new TextDecoder().decode(vector.input.clientDataJson)
    const clientData = JSON.parse(clientDataStr) as { origin: string }
    expect(clientData.origin).toBe(evilOrigin)
  })
})

describe('rpIdHash tampered vector (verification 3)', () => {
  it('builds rpIdHash-tampered vector with expected error code', async () => {
    const vector = await buildRpIdHashTamperedVector(TEST_RP_ID, 'evil.attacker.com', TEST_ORIGIN)

    expect(vector.expectedErrorCode).toBe('rpid_mismatch')
    expect(vector.input.expectedRpId).toBe(TEST_RP_ID)
  })

  it('tampered authData contains evil rpIdHash', async () => {
    const evilRpId = 'evil.attacker.com'
    const vector = await buildRpIdHashTamperedVector(TEST_RP_ID, evilRpId, TEST_ORIGIN)

    const actualHash = vector.input.authenticatorData.slice(0, 32)
    const evilHash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(evilRpId)),
    )
    const legitimateHash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(TEST_RP_ID)),
    )

    expect(actualHash).toEqual(evilHash)
    expect(actualHash).not.toEqual(legitimateHash)
  })
})

describe('sign_count clone detection (verification anti-clone)', () => {
  it('all SIGN_COUNT_CLONE_VECTORS are defined', () => {
    expect(SIGN_COUNT_CLONE_VECTORS.length).toBeGreaterThan(0)
  })

  it('detectSignCountAnomaly matches expected behavior for each vector', () => {
    for (const v of SIGN_COUNT_CLONE_VECTORS) {
      const result = detectSignCountAnomaly(v.newSignCount, v.storedSignCount)
      expect(result).toBe(v.shouldFlagAnomaly)
    }
  })

  it('both zero: no anomaly (platform sync passkey)', () => {
    expect(detectSignCountAnomaly(0, 0)).toBe(false)
  })

  it('new > stored: no anomaly (normal progression)', () => {
    expect(detectSignCountAnomaly(10, 5)).toBe(false)
  })

  it('new <= stored non-zero: anomaly (clone)', () => {
    expect(detectSignCountAnomaly(3, 5)).toBe(true)
    expect(detectSignCountAnomaly(5, 5)).toBe(true)
  })

  it('new zero, stored non-zero: anomaly', () => {
    expect(detectSignCountAnomaly(0, 1)).toBe(true)
  })
})
