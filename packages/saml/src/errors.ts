// SAML 处理层内部错误码 + Result 工具(对照 04 章 8.8 内部 error code 列)。
// 本层用自有 union(覆盖验签/解密/语义全部分支),worker/sso/saml.ts 把它映射到 SsoErrorCode + HTTP 状态。
// 预期失败一律走 Result,不 throw(见全局错误处理铁律)。

import type { SamlAssertionResult } from '@xid-kit/types'

// 04 章 8.8 表内部 error code 全集(验签 8.1-8.5、解密 8.6、语义 8.7)。
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
  // IdP StatusCode(idp_status_error 时透传到日志,见 8.8 idp_status_<status>)。
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

// verifySamlResponse / parseAndVerifyResponse 的成功产出别名(语义校验在 worker 侧或 assertion.ts 完成)。
export type SamlVerifiedAssertion = SamlAssertionResult
