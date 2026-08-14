import type { XidErrorCode } from '@xid-kit/types'

export type OneTimeLinkErrorKind = 'expired' | 'invalid' | 'retryable'

type OneTimeLinkTerminalCodes = {
  expired: XidErrorCode
  invalid: XidErrorCode
}

function xidErrorCode(error: unknown): XidErrorCode | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? (error.code as XidErrorCode) : null
}

export function classifyOneTimeLinkError(
  error: unknown,
  terminalCodes: OneTimeLinkTerminalCodes,
): OneTimeLinkErrorKind {
  const code = xidErrorCode(error)
  if (code === terminalCodes.expired) return 'expired'
  if (code === terminalCodes.invalid) return 'invalid'
  return 'retryable'
}
