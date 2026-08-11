// 注册：challenge/origin/rpIdHash + AT 提取公钥；attestation 按 policy 验链，none 直接接受。

import type { XidError, Result, VerifiedPasskey, WebAuthnVerificationInput } from '@xid-kit/types'

import {
  parseAttestationStatement,
  verifyEnterpriseAttestation,
  type AttestationConveyance,
} from './attestation'
import { deriveDeviceType, parseAuthData } from './authdata'
import { webauthnError } from './errors'
import { checkClientData, constantTimeEqual } from './parse'

const CRED_ID_LEN_MAX = 1023

export type RegistrationVerificationOptions = {
  attestationPolicy?: AttestationConveyance
  trustedRootsPem?: readonly string[]
}

function fail(error: XidError): Result<VerifiedPasskey, XidError> {
  return { ok: false, error }
}

function invalidCredentials(message: string): Result<VerifiedPasskey, XidError> {
  return fail(webauthnError('invalid_credentials', message))
}

export async function verifyRegistration(
  input: WebAuthnVerificationInput,
  options: RegistrationVerificationOptions = {},
): Promise<Result<VerifiedPasskey, XidError>> {
  if (!input.attestationObject) {
    return fail(webauthnError('invalid_credentials', 'missing attestationObject'))
  }

  const clientCheck = checkClientData({
    clientDataJson: input.clientDataJson,
    ceremony: 'registration',
    expectedChallenge: input.expectedChallenge,
    expectedOrigins: input.expectedOrigins,
  })
  if (!clientCheck.ok) {
    if (clientCheck.reason === 'origin_mismatch') return fail(webauthnError('origin_mismatch'))
    if (clientCheck.reason === 'type_mismatch') return fail(webauthnError('invalid_credentials'))
    return fail(webauthnError('challenge_invalid'))
  }

  let fmt: string
  let authData: Uint8Array
  let parsed: Awaited<ReturnType<typeof parseAuthData>>
  let enterpriseAttestationVerified = false
  try {
    const attestation = parseAttestationStatement(input.attestationObject)
    fmt = attestation.fmt
    authData = attestation.authData
    parsed = await parseAuthData(authData)
    const policy = options.attestationPolicy ?? 'none'
    if (policy !== 'none' && fmt !== 'none') {
      const attestationResult = await verifyEnterpriseAttestation({
        fmt,
        attStmt: attestation.attStmt,
        authData,
        clientDataJson: input.clientDataJson,
        policy,
        trustedRootsPem: options.trustedRootsPem,
      })
      if (!attestationResult.ok) return attestationResult
      enterpriseAttestationVerified = attestationResult.value.verified
    }
  } catch {
    return invalidCredentials('malformed attestationObject')
  }

  const expectedRpIdHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.expectedRpId)),
  )
  if (!constantTimeEqual(parsed.rpIdHash, expectedRpIdHash)) {
    return fail(webauthnError('rpid_mismatch'))
  }

  if (!parsed.flags.userPresent) return fail(webauthnError('invalid_credentials', 'UP not set'))
  if (!parsed.flags.userVerified) return fail(webauthnError('user_verification_required'))
  if (!parsed.flags.attestedCredentialData || !parsed.attestedCredentialData) {
    return fail(webauthnError('invalid_credentials', 'AT flag not set'))
  }

  const attested = parsed.attestedCredentialData
  if (attested.credentialId.length > CRED_ID_LEN_MAX) {
    return fail(webauthnError('invalid_credentials', 'credentialId too long'))
  }

  return {
    ok: true,
    value: {
      credentialId: attested.credentialId,
      publicKey: attested.coseKeyBytes,
      coseAlg: attested.coseKey.alg,
      aaguid: attested.aaguid,
      signCount: parsed.signCount,
      userVerified: parsed.flags.userVerified,
      transports: [],
      credentialDeviceType: deriveDeviceType(parsed.flags),
      credentialBackedUp: parsed.flags.backupState,
      signCountAnomaly: false,
      attestationFmt: fmt,
      enterpriseAttestationVerified,
    },
  }
}
