// core 错误模型:可预期失败用 Result<_, XidError>(见 error-handling rule);
// 传输层不可恢复错误(网络断、非 JSON 响应、5xx 无结构体)throw typed XidNetworkError。
// XidError 结构契约来自 @xid-kit/types,SDK 不重新发明错误字段。

import type { XidError, XidErrorCode } from '@xid-kit/types'

// 传输/意外失败(对照 error-handling rule:意外不可恢复 throw typed AppError)。
// 保留 cause 链,DX 友好(message 清晰指出失败环节)。
export class XidNetworkError extends Error {
  override readonly name = 'XidNetworkError'
  readonly status: number | null

  constructor(message: string, options: { status?: number | null; cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.status = options.status ?? null
  }
}

// 构造一个结构化 XidError(用于本地校验失败,不回源)。
export function makeXidError(
  code: XidErrorCode,
  message: string,
  options: { httpStatus?: number; longMessage?: string; paramName?: string } = {},
): XidError {
  return {
    code,
    message,
    httpStatus: options.httpStatus ?? 400,
    ...(options.longMessage ? { longMessage: options.longMessage } : {}),
    ...(options.paramName ? { meta: { paramName: options.paramName } } : {}),
  }
}

// 类型守卫:wire 上的错误体是否符合 XidError 形状(worker 按 XidAPIError 序列化)。
export function isXidErrorShape(value: unknown): value is XidError {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.code === 'string' && typeof candidate.message === 'string'
}
