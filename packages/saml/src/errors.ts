// 内部 SamlErrorCode;worker 映射到 SsoErrorCode。预期失败走 Result,不 throw。

import type { SamlAssertionResult } from '@xid-kit/types'

export const SAML_ERROR_CODES = [
  'malformed_request',
  'malformed_xml',
  'schema_invalid',
  'signature_required',
  'signature_invalid',
  'weak_algorithm',
  'decryption_failed',
  'issuer_mismatch',
  'audience_mismatch',
  'assertion_expired',
  'recipient_mismatch',
  'replay_detected',
  'idp_status_error',
] as const
export type SamlErrorCode = (typeof SAML_ERROR_CODES)[number]

export type SamlError = {
  code: SamlErrorCode
  reason: string
  // idp_status_error 时透传日志,不回客户端。
  idpStatus?: string
}

export type SamlResult<T> = { ok: true; value: T } | { ok: false; error: SamlError }

export function samlFail(code: SamlErrorCode, reason: string, idpStatus?: string): SamlError {
  return idpStatus === undefined ? { code, reason } : { code, reason, idpStatus }
}

export function failResult<T>(
  code: SamlErrorCode,
  reason: string,
  idpStatus?: string,
): SamlResult<T> {
  return { ok: false, error: samlFail(code, reason, idpStatus) }
}

export function okResult<T>(value: T): SamlResult<T> {
  return { ok: true, value }
}

export type SamlVerifiedAssertion = SamlAssertionResult
