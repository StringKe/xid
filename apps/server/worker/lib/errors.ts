// AppError:worker 内意外/不可恢复失败的 typed throw 类型(见错误处理铁律)。
// Hono onError 统一把 AppError 映射为 XidAPIError JSON;message 走 @xid-kit/i18n 按 locale 渲染。
// 预期失败用 Result 不用 throw;AppError 仅承载 XidErrorCode + 可选 meta/longMessage,不外泄内部细节。

import type { XidErrorCode, XidErrorMeta } from '@xid-kit/types'

// XidErrorCode -> 默认 HTTP status。未列出的认证/会话/租户错误统一模糊到 400/401/403/404,
// 不按"存在性"区分(枚举防护,见 anti-abuse rule)。
const STATUS_BY_CODE: Partial<Record<XidErrorCode, number>> = {
  // OAuth/OIDC(03 章 9.7)
  invalid_request: 400,
  invalid_client: 401,
  invalid_grant: 400,
  unauthorized_client: 400,
  unsupported_grant_type: 400,
  invalid_scope: 400,
  invalid_target: 400,
  invalid_authorization_details: 400,
  invalid_dpop_proof: 400,
  use_dpop_nonce: 400,
  authorization_pending: 400,
  slow_down: 400,
  expired_token: 400,
  access_denied: 403,
  unsupported_response_type: 400,
  login_required: 401,
  consent_required: 401,
  interaction_required: 401,
  server_error: 500,
  temporarily_unavailable: 503,
  // 认证(模糊到 401/429,不区分存在性)
  invalid_credentials: 401,
  account_locked: 403,
  account_suspended: 403,
  account_banned: 403,
  mfa_required: 401,
  mfa_invalid: 401,
  mfa_setup_required: 403,
  step_up_required: 401,
  email_verification_required: 403,
  rate_limited: 429,
  captcha_required: 401,
  captcha_failed: 401,
  invitation_invalid: 400,
  invitation_expired: 400,
  invitation_email_mismatch: 403,
  invitation_already_accepted: 409,
  // 租户 / RBAC
  tenant_not_found: 404,
  tenant_suspended: 403,
  org_not_found: 404,
  org_suspended: 403,
  insufficient_permission: 403,
  cross_tenant_access_denied: 404,
  seat_limit_exceeded: 403,
  // 会话
  session_not_found: 404,
  session_revoked: 401,
  session_expired: 401,
  refresh_token_invalid: 400,
  refresh_token_reused: 400,
  // 管理 API
  not_found: 404,
  already_exists: 409,
  validation_failed: 422,
  unauthorized: 401,
  forbidden: 403,
  conflict: 409,
  unprocessable_entity: 422,
  internal_error: 500,
  not_implemented: 501,
  service_unavailable: 503,
}

const DEFAULT_STATUS = 400

export function httpStatusForCode(code: XidErrorCode): number {
  return STATUS_BY_CODE[code] ?? DEFAULT_STATUS
}

export type AppErrorOptions = {
  // 可选覆盖默认 status(否则按 code 映射)。
  httpStatus?: number
  // 表单字段精确映射(api-sdk-conventions rule:meta.paramName)。
  meta?: XidErrorMeta
  // 开发者向详细说明(可暴露给客户端,但不含内部栈/敏感细节)。
  longMessage?: string
  // 原始底层错误,仅用于服务端日志,绝不外泄(见错误处理铁律不吞错)。
  cause?: unknown
}

// 业务/协议失败的 typed 错误。message 在 onError 阶段由 i18n 渲染,此处只持 code。
export class AppError extends Error {
  readonly code: XidErrorCode
  readonly httpStatus: number
  readonly meta?: XidErrorMeta
  readonly longMessage?: string

  constructor(code: XidErrorCode, options: AppErrorOptions = {}) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AppError'
    this.code = code
    this.httpStatus = options.httpStatus ?? httpStatusForCode(code)
    if (options.meta) this.meta = options.meta
    if (options.longMessage) this.longMessage = options.longMessage
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError
}
