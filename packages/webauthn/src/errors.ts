// WebAuthn 验证可预期失败 -> XidError(Result error 分支)。
// 四验证负路径均返回模糊响应,不向前端泄露具体失败项(枚举防护,见 anti-abuse / webauthn rule)。
// 错误码复用 @xid-kit/types AUTH_ERROR_CODES,不另造(见契约复用铁律)。

import type { AuthErrorCode, XidError } from '@xid-kit/types'

type WebAuthnErrorCode = Extract<
  AuthErrorCode,
  | 'challenge_invalid'
  | 'origin_mismatch'
  | 'rpid_mismatch'
  | 'signature_invalid'
  | 'user_verification_required'
  | 'invalid_credentials'
>

// 对前端统一返回 401 模糊响应;具体 code 供审计区分,不据此改变前端可见行为。
export function webauthnError(code: WebAuthnErrorCode, longMessage?: string): XidError {
  const error: XidError = {
    code,
    message: 'WebAuthn verification failed',
    httpStatus: 401,
  }
  if (longMessage) error.longMessage = longMessage
  return error
}
