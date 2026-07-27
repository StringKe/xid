// 第 2 组契约:统一错误模型 + Result 判别联合 + 全量错误码。
// 对照 docs/design/03-oidc-oauth.md 9.7 OAuth error 表、api-sdk-conventions rule(XidAPIError)。
// 契约冻结:错误码 union 为全局约束,后续不得单边改字段。

// OAuth/OIDC 标准错误码(RFC6749 5.2 + RFC8628/RFC8693/RFC9449 扩展,见 03 章 9.7)
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
  // /authorize 重定向错误(OIDC Core 3.1.2.6,见 03 章 10.7)
  'unsupported_response_type',
  'login_required',
  'consent_required',
  'interaction_required',
  'server_error',
  'temporarily_unavailable',
] as const

// 认证(密码/MFA/passwordless/WebAuthn,见 01 章、password-auth/webauthn/anti-abuse rule)
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
  // 密码重置 / 邮箱验证一次性 token(15min,只存哈希,见 password-auth rule)
  'token_invalid',
  'token_expired',
  'rate_limited',
  'captcha_required',
  'captcha_failed',
  // WebAuthn 四验证(见 webauthn rule;无跳过路径)
  'challenge_invalid',
  'origin_mismatch',
  'rpid_mismatch',
  'signature_invalid',
  'user_verification_required',
  'credential_cloned',
  // 组织邀请(见 02 章 2、05 章 2)
  'invitation_invalid',
  'invitation_expired',
  'invitation_email_mismatch',
  'invitation_already_accepted',
] as const

// 多租户 RBAC / 隔离(见 02 章、tenant-isolation/tenant-context rule)
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
] as const

// 企业 SSO(SAML/SCIM,见 04 章 8.8 错误分支)
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

// 会话(见 05 章 8)
export const SESSION_ERROR_CODES = [
  'session_not_found',
  'session_revoked',
  'session_expired',
  'refresh_token_invalid',
  'refresh_token_reused',
] as const

// 管理 API(见 06 章、api-sdk-conventions rule)
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

// 结构化错误(对照 api-sdk-conventions rule:code / message / longMessage / meta.paramName)。
// message 由 lingui i18n._() 渲染后填入(见 i18n-lingui rule),契约只持渲染后的字符串。
export type XidErrorMeta = {
  paramName?: string
}

export type XidError = {
  code: XidErrorCode
  message: string
  longMessage?: string
  httpStatus: number
  meta?: XidErrorMeta
}

// 可预期失败用 Result 判别联合(见全局错误处理铁律);意外/不可恢复仍走 throw typed AppError。
export type Result<T, E = XidError> = { ok: true; value: T } | { ok: false; error: E }
