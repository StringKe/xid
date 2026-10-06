// XidAPIError 分类(不含文案):凭证端点只放行与账户存在性无关的错误码,其余统一为凭证错误(枚举防护)。
// 渲染见 ./api-error-message。

import type { XidError, XidErrorCode } from '@xid-kit/types'

export type ApiErrorSurface = 'credential' | 'general'

export type ApiErrorOptions = {
  surface: ApiErrorSurface
}

export type ApiErrorInput = Pick<XidError, 'code' | 'meta'>

export type ApiErrorClassification = {
  code: XidErrorCode
  paramName?: string
}

// 只在凭证已通过后出现,或与账户是否存在无关。
const CREDENTIAL_DISCLOSABLE_CODES: ReadonlySet<XidErrorCode> = new Set<XidErrorCode>([
  'rate_limited',
  'account_locked',
  'captcha_required',
  'captcha_failed',
  'password_breached',
  'password_reused',
  'password_too_weak',
  'validation_failed',
  'email_verification_required',
  'otp_expired',
  'magic_link_expired',
  'token_expired',
  'organization_selection_required',
  'server_error',
  'service_unavailable',
  'temporarily_unavailable',
])

// locked / suspended / banned 统一为一个响应,不泄露账户状态。
const CREDENTIAL_ACCOUNT_STATE_CODES: ReadonlySet<XidErrorCode> = new Set<XidErrorCode>([
  'account_locked',
  'account_suspended',
  'account_banned',
])

function credentialCode(code: XidErrorCode): XidErrorCode {
  if (CREDENTIAL_ACCOUNT_STATE_CODES.has(code)) return 'account_locked'
  return CREDENTIAL_DISCLOSABLE_CODES.has(code) ? code : 'invalid_credentials'
}

export function classifyApiError(
  error: ApiErrorInput,
  options: ApiErrorOptions,
): ApiErrorClassification {
  const code = options.surface === 'credential' ? credentialCode(error.code) : error.code
  const paramName = code === error.code ? error.meta?.paramName : undefined
  return paramName ? { code, paramName } : { code }
}
