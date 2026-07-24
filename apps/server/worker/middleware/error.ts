// error 中间件:Hono app.onError 统一把 AppError/XidError 映射为 XidAPIError JSON 响应。
// message 从 c.get('i18n') 的请求私有实例渲染，绝不读取 isolate 全局当前 locale。
// 铁律:内部细节(栈/底层错误/SQL)绝不外泄(枚举防护);未知错误统一 server_error 500。

import { errorMessages } from '@xid-kit/i18n'
import type { XidError, XidErrorCode } from '@xid-kit/types'
import type { ErrorHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { AppError, isAppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'

// 判别一个 throw 值是否为结构化 XidError 形状(可预期失败被 throw 出来时)。
function isXidErrorShape(value: unknown): value is XidError {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.code === 'string' && typeof v.httpStatus === 'number'
}

// 渲染后的对外错误体(api-sdk-conventions rule:code/message/longMessage/meta)。
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
    console.error('failed to render localized error message', error)
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

// 未知错误:不暴露原始 message,统一渲染为 server_error 500。
function bodyFromUnknown(c: Parameters<ErrorHandler<XidHonoEnv>>[1]): MappedError {
  const code: XidErrorCode = 'server_error'
  return { status: 500, body: { code, message: renderErrorMessage(c, code) } }
}

// Hono onError:三类来源映射;响应 Cache-Control: no-store(协议端 token/错误不缓存)。
// 未知错误恒打日志:生产同样必须有迹可循(此前条件取反导致生产静默),结构化错误不打是预期失败。
export const errorHandler: ErrorHandler<XidHonoEnv> = (err, c) => {
  if (!isAppError(err) && !isXidErrorShape(err)) {
    console.error(err)
  }
  const mapped = isAppError(err)
    ? bodyFromAppError(c, err)
    : isXidErrorShape(err)
      ? bodyFromXidError(c, err)
      : bodyFromUnknown(c)

  return c.json(mapped.body, mapped.status, { 'cache-control': 'no-store' })
}

// 便捷:把 XidError(Result 的 error 分支)抛为 AppError,交给 onError 统一映射。
export function throwXidError(err: XidError): never {
  throw new AppError(err.code, {
    httpStatus: err.httpStatus,
    ...(err.longMessage ? { longMessage: err.longMessage } : {}),
    ...(err.meta ? { meta: err.meta } : {}),
  })
}
