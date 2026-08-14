// AppError/XidError -> XidAPIError;message 用请求私有 i18n,内部细节不外泄。

import { errorMessages } from '@xid-kit/i18n'
import type { XidError, XidErrorCode } from '@xid-kit/types'
import type { ErrorHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import {
  AppError,
  isAppError,
  isResourceQuotaConstraintError,
  isSeatLimitConstraintError,
} from '../lib/errors'
import { logWorkerError, logWorkerWarning } from '../lib/safe-log'
import type { XidHonoEnv } from '../lib/types'

function isXidErrorShape(value: unknown): value is XidError {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.code === 'string' && typeof v.httpStatus === 'number'
}

type XidApiErrorBody = {
  code: XidErrorCode
  message: string
  longMessage?: string
  meta?: XidError['meta']
}

type MappedError = { status: ContentfulStatusCode; body: XidApiErrorBody }

function renderErrorMessage(
  c: Parameters<ErrorHandler<XidHonoEnv>>[1],
  code: XidErrorCode,
): string {
  try {
    return c.get('i18n')._(errorMessages[code])
  } catch (error) {
    // 错误响应必须可用；服务端记录渲染故障，但绝不将内部细节发给客户端。
    logWorkerError('error.localization.render_failed', error, {
      component: 'error-middleware',
    })
    return 'An unexpected server error occurred. Please try again.'
  }
}

function bodyFromAppError(c: Parameters<ErrorHandler<XidHonoEnv>>[1], err: AppError): MappedError {
  const body: XidApiErrorBody = { code: err.code, message: renderErrorMessage(c, err.code) }
  if (err.longMessage) body.longMessage = err.longMessage
  if (err.meta) body.meta = err.meta
  return { status: err.httpStatus as ContentfulStatusCode, body }
}

function bodyFromXidError(c: Parameters<ErrorHandler<XidHonoEnv>>[1], err: XidError): MappedError {
  const body: XidApiErrorBody = { code: err.code, message: renderErrorMessage(c, err.code) }
  if (err.longMessage) body.longMessage = err.longMessage
  if (err.meta) body.meta = err.meta
  return { status: err.httpStatus as ContentfulStatusCode, body }
}

// 未知错误统一 server_error,不暴露原始 message。
function bodyFromUnknown(c: Parameters<ErrorHandler<XidHonoEnv>>[1]): MappedError {
  const code: XidErrorCode = 'server_error'
  return { status: 500, body: { code, message: renderErrorMessage(c, code) } }
}

const ONE_TIME_LINK_OPERATIONS: Readonly<Record<string, string>> = {
  '/auth/magic-link/verify': 'magic_link',
  '/auth/verify-email': 'email_verification',
  '/auth/reset-password': 'password_reset',
  '/auth/invitation/claim/verify': 'invitation_email_claim',
}

const SAFE_LOG_REASON = /^[a-z][a-z0-9_]{0,63}$/u

function logOneTimeLinkRejection(
  c: Parameters<ErrorHandler<XidHonoEnv>>[1],
  error: AppError | XidError,
): void {
  const path = (c as unknown as { req?: { path?: string } }).req?.path
  const operation = path ? ONE_TIME_LINK_OPERATIONS[path] : undefined
  if (!operation) return
  logWorkerWarning('auth.one_time_link.rejected', {
    component: 'auth',
    operation,
    outcome: error.code,
    ...(error instanceof AppError &&
    error.logReason !== undefined &&
    SAFE_LOG_REASON.test(error.logReason)
      ? { reason: error.logReason }
      : {}),
    status: error.httpStatus,
  })
}

// 未知错误恒打日志;结构化预期失败不打;响应 no-store。
export const errorHandler: ErrorHandler<XidHonoEnv> = (err, c) => {
  const normalized = isSeatLimitConstraintError(err)
    ? new AppError('seat_limit_exceeded')
    : isResourceQuotaConstraintError(err)
      ? new AppError('resource_quota_exceeded')
      : err
  if (!isAppError(normalized) && !isXidErrorShape(normalized)) {
    logWorkerError('request.unhandled_exception', err, {
      component: 'error-middleware',
    })
  }
  if (isAppError(normalized) || isXidErrorShape(normalized)) {
    logOneTimeLinkRejection(c, normalized)
  }
  const mapped = isAppError(normalized)
    ? bodyFromAppError(c, normalized)
    : isXidErrorShape(normalized)
      ? bodyFromXidError(c, normalized)
      : bodyFromUnknown(c)

  return c.json(mapped.body, mapped.status, { 'cache-control': 'no-store' })
}

export function throwXidError(err: XidError): never {
  throw new AppError(err.code, {
    httpStatus: err.httpStatus,
    ...(err.longMessage ? { longMessage: err.longMessage } : {}),
    ...(err.meta ? { meta: err.meta } : {}),
  })
}
