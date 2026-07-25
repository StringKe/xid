import { describe, expect, it } from 'vitest'
import {
  ACR_AAL2,
  ACR_AAL3,
  EMAIL_OTP_AUTH_CONTEXT,
  MAGIC_LINK_AUTH_CONTEXT,
  PASSKEY_AUTH_CONTEXT,
  PASSWORD_AUTH_CONTEXT,
  SMS_OTP_AUTH_CONTEXT,
  SOCIAL_AUTH_CONTEXT,
  SSO_AUTH_CONTEXT,
  addMfaToAuthContext,
  buildPasskeyMfaAuthContext,
  qualifiesForAal3,
} from '../auth-context'

describe('auth context assurance levels', () => {
  it('does not issue AAL3 from primary auth contexts', () => {
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
      expect(ctx.acr).not.toBe(ACR_AAL3)
      expect(ctx.aal).toBeLessThan(3)
    }
  })

  it('upgrades password + TOTP to AAL2 only', () => {
    for (const method of ['totp', 'backup', 'sms'] as const) {
      const upgraded = addMfaToAuthContext(PASSWORD_AUTH_CONTEXT, method)
      expect(upgraded.acr).toBe(ACR_AAL2)
      expect(upgraded.aal).toBe(2)
      expect(upgraded.acr).not.toBe(ACR_AAL3)
    }
  })

  it('issues AAL3 when passkey MFA meets hardware assurance', () => {
    expect(
      qualifiesForAal3({
        userVerified: true,
        credentialBackedUp: false,
        credentialDeviceType: 'singleDevice',
      }),
    ).toBe(true)

    const upgraded = buildPasskeyMfaAuthContext(PASSWORD_AUTH_CONTEXT, {
      userVerified: true,
      credentialBackedUp: false,
      credentialDeviceType: 'singleDevice',
    })
    expect(upgraded.acr).toBe(ACR_AAL3)
    expect(upgraded.aal).toBe(3)
    expect(upgraded.amr).toContain('phr')
    expect(upgraded.amr).toContain('mfa')
  })

  it('rejects AAL3 for syncable passkeys and missing enterprise attestation', () => {
    expect(
      qualifiesForAal3({
        userVerified: true,
        credentialBackedUp: true,
        credentialDeviceType: 'multiDevice',
      }),
    ).toBe(false)

    expect(
      qualifiesForAal3({
        userVerified: true,
        credentialBackedUp: false,
        credentialDeviceType: 'singleDevice',
        requireEnterpriseAttestation: true,
        enterpriseAttestationVerified: false,
      }),
    ).toBe(false)

    const fallback = buildPasskeyMfaAuthContext(PASSWORD_AUTH_CONTEXT, {
      userVerified: true,
      credentialBackedUp: true,
      credentialDeviceType: 'multiDevice',
    })
    expect(fallback.acr).toBe(ACR_AAL2)
    expect(fallback.aal).toBe(2)
  })
})
