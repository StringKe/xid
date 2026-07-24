// SAML 验签层 SamlErrorCode -> SsoErrorCode + HTTP 状态(对照 04 章 8.8 错误分支表)。
// 约定:signature_* 用 401(认证失败);语义校验 issuer/audience/expired/recipient/replay 用 403;
// 请求/密文格式用 400(见 8.8 末尾约定)。@xid-kit/saml 的 weak_algorithm 归并到 signature_invalid。

import type { SamlErrorCode } from '@xid-kit/saml'
import type { SsoErrorCode } from '@xid-kit/types'
import { AppError } from '../lib/errors'

type Mapped = { code: SsoErrorCode; httpStatus: number }

// 8.8 表逐行映射。weak_algorithm 不在 SsoErrorCode union,归 signature_invalid(401)。
const SAML_TO_SSO: Record<SamlErrorCode, Mapped> = {
  malformed_request: { code: 'malformed_request', httpStatus: 400 },
  malformed_xml: { code: 'malformed_xml', httpStatus: 400 },
  schema_invalid: { code: 'schema_invalid', httpStatus: 400 },
  signature_required: { code: 'signature_required', httpStatus: 401 },
  signature_invalid: { code: 'signature_invalid', httpStatus: 401 },
  weak_algorithm: { code: 'signature_invalid', httpStatus: 401 },
  decryption_failed: { code: 'decryption_failed', httpStatus: 400 },
  issuer_mismatch: { code: 'issuer_mismatch', httpStatus: 403 },
  audience_mismatch: { code: 'audience_mismatch', httpStatus: 403 },
  assertion_expired: { code: 'assertion_expired', httpStatus: 403 },
  recipient_mismatch: { code: 'recipient_mismatch', httpStatus: 403 },
  replay_detected: { code: 'replay_detected', httpStatus: 403 },
  idp_status_error: { code: 'idp_status_error', httpStatus: 403 },
}

// 把 @xid-kit/saml 的内部错误码转 AppError(onError 统一渲染 XidAPIError;内部 reason 只进日志)。
export function samlErrorToApp(code: SamlErrorCode, reason: string): AppError {
  const mapped = SAML_TO_SSO[code]
  return new AppError(mapped.code, {
    httpStatus: mapped.httpStatus,
    longMessage: `saml:${code}`,
    cause: reason,
  })
}
