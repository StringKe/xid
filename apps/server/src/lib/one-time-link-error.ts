// 一次性链接错误分类:只有限流、服务端暂时故障和网络错误(无 code)可以原样重试。
// 策略拒绝、账户不可用等其余错误一律终态,只给回到登录的出口,避免对已消费的 token 反复重试。

import type { XidErrorCode } from '@xid-kit/types'

export type OneTimeLinkErrorKind = 'expired' | 'invalid' | 'unavailable' | 'retryable'

type OneTimeLinkTerminalCodes = {
  expired: XidErrorCode
  invalid: XidErrorCode
}

const RETRYABLE_CODES: ReadonlySet<XidErrorCode> = new Set<XidErrorCode>([
  'rate_limited',
  'server_error',
  'service_unavailable',
  'temporarily_unavailable',
])

function xidErrorCode(error: unknown): XidErrorCode | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? (error.code as XidErrorCode) : null
}

export function classifyOneTimeLinkError(
  error: unknown,
  terminalCodes: OneTimeLinkTerminalCodes,
): OneTimeLinkErrorKind {
  const code = xidErrorCode(error)
  if (code === null || RETRYABLE_CODES.has(code)) return 'retryable'
  if (code === terminalCodes.expired) return 'expired'
  if (code === terminalCodes.invalid) return 'invalid'
  return 'unavailable'
}
