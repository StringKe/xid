import { describe, expect, it } from 'vitest'
import {
  ACR_AAL2,
  EMAIL_OTP_AUTH_CONTEXT,
  MAGIC_LINK_AUTH_CONTEXT,
  PASSKEY_AUTH_CONTEXT,
  PASSWORD_AUTH_CONTEXT,
  SMS_OTP_AUTH_CONTEXT,
  SOCIAL_AUTH_CONTEXT,
  SSO_AUTH_CONTEXT,
  UNSUPPORTED_ACR_AAL3,
  addMfaToAuthContext,
  normalizeAuthAssuranceLevel,
  normalizeIssuedAcr,
} from '../auth-context'

describe('auth context assurance levels', () => {
  it('caps every primary auth context at AAL2', () => {
    const primaryContexts = [
      PASSWORD_AUTH_CONTEXT,
      PASSKEY_AUTH_CONTEXT,
      EMAIL_OTP_AUTH_CONTEXT,
      SMS_OTP_AUTH_CONTEXT,
      MAGIC_LINK_AUTH_CONTEXT,
      SOCIAL_AUTH_CONTEXT,
      SSO_AUTH_CONTEXT,
    ]

    for (const ctx of primaryContexts) {
      expect(ctx.acr).not.toBe(UNSUPPORTED_ACR_AAL3)
      expect(ctx.aal).toBeLessThanOrEqual(2)
    }
  })

  it('caps every MFA method, including a device-bound passkey, at AAL2', () => {
    for (const method of ['totp', 'backup', 'sms', 'passkey'] as const) {
      const upgraded = addMfaToAuthContext(PASSWORD_AUTH_CONTEXT, method)
      expect(upgraded.acr).toBe(ACR_AAL2)
      expect(upgraded.aal).toBe(2)
      expect(upgraded.acr).not.toBe(UNSUPPORTED_ACR_AAL3)
    }
  })

  it('downgrades legacy AAL3 state before it can be re-issued', () => {
    expect(normalizeIssuedAcr(UNSUPPORTED_ACR_AAL3)).toBe(ACR_AAL2)
    expect(normalizeAuthAssuranceLevel(3)).toBe(2)
  })

  it('preserves supported and unrelated private ACR values', () => {
    expect(normalizeIssuedAcr('urn:xid:aal1')).toBe('urn:xid:aal1')
    expect(normalizeIssuedAcr(ACR_AAL2)).toBe(ACR_AAL2)
    expect(normalizeIssuedAcr('urn:example:loa')).toBe('urn:example:loa')
    expect(normalizeIssuedAcr(null)).toBeNull()
    expect(normalizeAuthAssuranceLevel(1)).toBe(1)
    expect(normalizeAuthAssuranceLevel(2)).toBe(2)
    expect(normalizeAuthAssuranceLevel(null)).toBeNull()
  })
})
