// 可预期失败走 Result：对外统一 401 模糊文案，code 仅供审计，不改变前端可见行为。

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

export function webauthnError(code: WebAuthnErrorCode, longMessage?: string): XidError {
  const error: XidError = {
    code,
    message: 'WebAuthn verification failed',
    httpStatus: 401,
  }
  if (longMessage) error.longMessage = longMessage
  return error
}
