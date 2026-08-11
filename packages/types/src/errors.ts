// 统一错误模型与全量错误码；错误码 union 冻结后不得单边改字段。

export const OAUTH_ERROR_CODES = [
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  'invalid_target',
  'invalid_authorization_details',
  'invalid_dpop_proof',
  'use_dpop_nonce',
  'authorization_pending',
  'slow_down',
  'expired_token',
  'access_denied',
  'unsupported_response_type',
  'login_required',
  'consent_required',
  'interaction_required',
  'server_error',
  'temporarily_unavailable',
] as const

export const AUTH_ERROR_CODES = [
  'invalid_credentials',
  'account_locked',
  'account_suspended',
  'account_banned',
  'mfa_required',
  'mfa_invalid',
  'mfa_setup_required',
  'step_up_required',
  'email_verification_required',
  'password_breached',
  'password_reused',
  'password_too_weak',
  'otp_invalid',
  'otp_expired',
  'magic_link_invalid',
  'magic_link_expired',
  'token_invalid',
  'token_expired',
  'rate_limited',
  'captcha_required',
  'captcha_failed',
  'challenge_invalid',
  'origin_mismatch',
  'rpid_mismatch',
  'signature_invalid',
  'user_verification_required',
  'credential_cloned',
  'invitation_invalid',
  'invitation_expired',
  'invitation_email_mismatch',
  'invitation_already_accepted',
] as const

export const TENANCY_ERROR_CODES = [
  'tenant_not_found',
  'tenant_suspended',
  'org_not_found',
  'org_suspended',
  'membership_not_found',
  'insufficient_permission',
  'role_not_found',
  'permission_not_found',
  'cross_tenant_access_denied',
  'seat_limit_exceeded',
  'resource_quota_exceeded',
  'project_not_found',
  'grant_already_exists',
  'request_already_decided',
  'no_available_approver',
] as const

export const SSO_ERROR_CODES = [
  'malformed_request',
  'malformed_xml',
  'schema_invalid',
  'signature_required',
  'signature_invalid',
  'decryption_failed',
  'issuer_mismatch',
  'audience_mismatch',
  'assertion_expired',
  'recipient_mismatch',
  'replay_detected',
  'idp_status_error',
  'provisioning_disabled',
  'connection_not_found',
  'scim_token_invalid',
] as const

export const SESSION_ERROR_CODES = [
  'session_not_found',
  'session_revoked',
  'session_expired',
  'refresh_token_invalid',
  'refresh_token_reused',
] as const

export const ADMIN_ERROR_CODES = [
  'not_found',
  'already_exists',
  'validation_failed',
  'unauthorized',
  'forbidden',
  'conflict',
  'unprocessable_entity',
  'internal_error',
  'not_implemented',
  'service_unavailable',
] as const

export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number]
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number]
export type TenancyErrorCode = (typeof TENANCY_ERROR_CODES)[number]
export type SsoErrorCode = (typeof SSO_ERROR_CODES)[number]
export type SessionErrorCode = (typeof SESSION_ERROR_CODES)[number]
export type AdminErrorCode = (typeof ADMIN_ERROR_CODES)[number]

export type XidErrorCode =
  | OAuthErrorCode
  | AuthErrorCode
  | TenancyErrorCode
  | SsoErrorCode
  | SessionErrorCode
  | AdminErrorCode

export type XidErrorMeta = {
  paramName?: string
}

// message 由请求侧 lingui 渲染后填入，契约只持渲染后的字符串
export type XidError = {
  code: XidErrorCode
  message: string
  longMessage?: string
  httpStatus: number
  meta?: XidErrorMeta
}

// 可预期失败用 Result；意外/不可恢复仍 throw typed AppError
export type Result<T, E = XidError> = { ok: true; value: T } | { ok: false; error: E }
