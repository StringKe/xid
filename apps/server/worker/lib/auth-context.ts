import type { AmrValue } from '@xid-kit/types'

export type AuthAssuranceLevel = 1 | 2

export type AuthContextData = {
  acr: string
  amr: readonly AmrValue[]
  aal: AuthAssuranceLevel
}

export const ACR_AAL1 = 'urn:xid:aal1'
export const ACR_AAL2 = 'urn:xid:aal2'
export const UNSUPPORTED_ACR_AAL3 = 'urn:xid:aal3'

export const PASSWORD_AUTH_CONTEXT: AuthContextData = {
  acr: ACR_AAL1,
  amr: ['pwd'],
  aal: 1,
}

export const PASSKEY_AUTH_CONTEXT: AuthContextData = {
  acr: ACR_AAL2,
  amr: ['phr'],
  aal: 2,
}

export const EMAIL_OTP_AUTH_CONTEXT: AuthContextData = {
  acr: ACR_AAL1,
  amr: ['email'],
  aal: 1,
}

export const SMS_OTP_AUTH_CONTEXT: AuthContextData = {
  acr: ACR_AAL1,
  amr: ['sms'],
  aal: 1,
}

export const MAGIC_LINK_AUTH_CONTEXT: AuthContextData = EMAIL_OTP_AUTH_CONTEXT

// guest(匿名访客)session:amr 含 'guest',AAL1(无任何凭证校验,见 01 章 guest 模式)。
export const GUEST_AUTH_CONTEXT: AuthContextData = {
  acr: ACR_AAL1,
  amr: ['guest'],
  aal: 1,
}

export const SOCIAL_AUTH_CONTEXT: AuthContextData = {
  acr: ACR_AAL1,
  amr: ['pwd'],
  aal: 1,
}

export const SSO_AUTH_CONTEXT: AuthContextData = {
  acr: ACR_AAL1,
  amr: ['pwd'],
  aal: 1,
}

export type MfaMethod = 'totp' | 'backup' | 'sms' | 'passkey'

export function normalizeIssuedAcr(acr: string | null | undefined): string | null {
  if (acr === null || acr === undefined || acr === '') return null
  // WebAuthn BE/BS flags do not prove the non-exportable hardware key required by NIST AAL3.
  return acr === UNSUPPORTED_ACR_AAL3 ? ACR_AAL2 : acr
}

export function normalizeAuthAssuranceLevel(
  aal: number | null | undefined,
): AuthAssuranceLevel | null {
  if (aal === 1) return 1
  if (aal !== null && aal !== undefined && aal >= 2) return 2
  return null
}

export function sessionSatisfiesAal2(session: { acr: string | null; aal: number | null }): boolean {
  return (
    normalizeIssuedAcr(session.acr) === ACR_AAL2 || normalizeAuthAssuranceLevel(session.aal) === 2
  )
}

export function addMfaToAuthContext(base: AuthContextData, method: MfaMethod): AuthContextData {
  const methodAmr: AmrValue = method === 'sms' ? 'sms' : method === 'passkey' ? 'phr' : 'otp'
  const amr = Array.from(new Set([...base.amr, methodAmr, 'mfa'])) as AmrValue[]
  return { acr: ACR_AAL2, amr, aal: 2 }
}
