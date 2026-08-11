// 可预期失败走 Result/XidError(契约来自 @xid-kit/types);传输与不可恢复失败 throw XidNetworkError。

import type { XidError, XidErrorCode } from '@xid-kit/types'

export class XidNetworkError extends Error {
  override readonly name = 'XidNetworkError'
  readonly status: number | null

  constructor(message: string, options: { status?: number | null; cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.status = options.status ?? null
  }
}

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

export function isXidErrorShape(value: unknown): value is XidError {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.code === 'string' && typeof candidate.message === 'string'
}
