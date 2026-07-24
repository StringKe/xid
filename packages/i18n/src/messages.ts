// 惰性消息定义:用 msg macro 覆盖全量 XidErrorCode 对应的用户可见文案。
// msg 不触发立即翻译,i18n._(theMsg) 在有实例上下文时渲染。
// 见 i18n-lingui rule:非组件上下文用 msg 定义,i18n._() 渲染。
import { msg } from '@lingui/core/macro'
import type { XidErrorCode } from '@xid-kit/types'

// MessageDescriptor union,保证每个 XidErrorCode 都有对应条目。
export type ErrorMessages = Record<XidErrorCode, ReturnType<typeof msg>>

export const errorMessages: ErrorMessages = {
  // OAuth / OIDC 标准错误
  invalid_request: msg`The request is missing a required parameter or is malformed.`,
  invalid_client: msg`Client authentication failed.`,
  invalid_grant: msg`The authorization grant or refresh token is invalid or expired.`,
  unauthorized_client: msg`The client is not authorized to use this grant type.`,
  unsupported_grant_type: msg`The authorization server does not support this grant type.`,
  invalid_scope: msg`The requested scope is invalid or not permitted.`,
  invalid_target: msg`The resource indicator is not permitted for this client.`,
  invalid_authorization_details: msg`The requested authorization details are invalid or not permitted.`,
  invalid_dpop_proof: msg`The DPoP proof is invalid or malformed.`,
  use_dpop_nonce: msg`The server requires a DPoP nonce. Retry with the provided nonce.`,
  authorization_pending: msg`The authorization request is still pending.`,
  slow_down: msg`Please wait before polling again.`,
  expired_token: msg`The device code or token has expired.`,
  access_denied: msg`Access was denied.`,
  unsupported_response_type: msg`The response type is not supported.`,
  login_required: msg`Login is required to complete this request.`,
  consent_required: msg`User consent is required.`,
  interaction_required: msg`User interaction is required.`,
  server_error: msg`An unexpected server error occurred. Please try again.`,
  temporarily_unavailable: msg`The service is temporarily unavailable. Please try again later.`,

  // 认证错误(密码 / MFA / passwordless / WebAuthn)
  invalid_credentials: msg`The email or password is incorrect.`,
  account_locked: msg`Your account has been temporarily locked. Please try again later.`,
  account_suspended: msg`Your account has been suspended. Contact support for assistance.`,
  account_banned: msg`Your account has been banned.`,
  mfa_required: msg`Multi-factor authentication is required.`,
  mfa_invalid: msg`The MFA code is incorrect.`,
  mfa_setup_required: msg`You must set up multi-factor authentication before continuing.`,
  step_up_required: msg`Additional verification is required to perform this action.`,
  password_breached: msg`This password has appeared in a data breach. Please choose a different password.`,
  password_reused: msg`This password has been used recently. Please choose a different password.`,
  password_too_weak: msg`The password does not meet the minimum strength requirements.`,
  otp_invalid: msg`The one-time code is incorrect.`,
  otp_expired: msg`The one-time code has expired. Please request a new one.`,
  magic_link_invalid: msg`This magic link is invalid.`,
  magic_link_expired: msg`This magic link has expired. Please request a new one.`,
  token_invalid: msg`This link is invalid. Please request a new one.`,
  token_expired: msg`This link has expired. Please request a new one.`,
  rate_limited: msg`Too many requests. Please wait and try again.`,
  captcha_required: msg`Please complete the CAPTCHA verification.`,
  captcha_failed: msg`CAPTCHA verification failed. Please try again.`,
  challenge_invalid: msg`The authentication challenge is invalid or has expired.`,
  origin_mismatch: msg`The request origin does not match the expected value.`,
  rpid_mismatch: msg`The relying party identifier does not match.`,
  signature_invalid: msg`The cryptographic signature could not be verified.`,
  user_verification_required: msg`User verification is required for this authenticator.`,
  credential_cloned: msg`A possible authenticator clone was detected. Please contact support.`,
  invitation_invalid: msg`This invitation link is invalid or has already been used.`,
  invitation_expired: msg`This invitation has expired. Ask your organization admin to send a new one.`,
  invitation_email_mismatch: msg`Sign in with the email address that received this invitation.`,
  invitation_already_accepted: msg`This invitation has already been accepted.`,

  // 组织 RBAC / 隔离
  tenant_not_found: msg`The requested organization context could not be found.`,
  tenant_suspended: msg`This organization context has been suspended.`,
  org_not_found: msg`The organization could not be found.`,
  org_suspended: msg`This organization has been suspended.`,
  membership_not_found: msg`No membership record was found.`,
  insufficient_permission: msg`You do not have permission to perform this action.`,
  role_not_found: msg`The specified role could not be found.`,
  permission_not_found: msg`The specified permission could not be found.`,
  cross_tenant_access_denied: msg`Cross-organization access is not permitted.`,
  seat_limit_exceeded: msg`The organization has reached its seat limit.`,

  // 企业 SSO (SAML / SCIM)
  malformed_request: msg`The request is malformed.`,
  malformed_xml: msg`The SAML XML document is malformed.`,
  schema_invalid: msg`The document schema is invalid.`,
  signature_required: msg`A digital signature is required.`,
  decryption_failed: msg`Failed to decrypt the assertion.`,
  issuer_mismatch: msg`The SAML issuer does not match the expected identity provider.`,
  audience_mismatch: msg`The SAML audience does not match this service provider.`,
  assertion_expired: msg`The SAML assertion has expired.`,
  recipient_mismatch: msg`The assertion recipient does not match.`,
  replay_detected: msg`A replayed assertion was detected.`,
  idp_status_error: msg`The identity provider returned an error status.`,
  provisioning_disabled: msg`Automatic provisioning is disabled for this connection.`,
  connection_not_found: msg`The SSO connection could not be found.`,
  scim_token_invalid: msg`The SCIM bearer token is invalid.`,

  // 会话
  session_not_found: msg`The session could not be found.`,
  session_revoked: msg`This session has been revoked.`,
  session_expired: msg`Your session has expired. Please sign in again.`,
  refresh_token_invalid: msg`The refresh token is invalid.`,
  refresh_token_reused: msg`The refresh token has already been used.`,

  // 管理 API
  not_found: msg`The requested resource could not be found.`,
  already_exists: msg`A resource with this identifier already exists.`,
  validation_failed: msg`Validation failed. Please check your input.`,
  unauthorized: msg`Authentication is required.`,
  forbidden: msg`You are not permitted to access this resource.`,
  conflict: msg`The request conflicts with the current state of the resource.`,
  unprocessable_entity: msg`The request could not be processed due to semantic errors.`,
  internal_error: msg`An internal error occurred. Please try again.`,
  not_implemented: msg`This operation is not supported.`,
  service_unavailable: msg`The service is currently unavailable.`,
}

// 协议错误页(worker/lib/error-page.ts:/authorize 本地渲染 + SAML ACS 浏览器错误)标题文案。
// 描述行复用 errorMessages;非 XidErrorCode 的协议错误码回落调用方原始 description。
export const protocolErrorPageMessages = {
  title: msg`Authorization error`,
} as const
