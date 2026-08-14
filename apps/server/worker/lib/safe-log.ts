type SafeLogContext = {
  component?: string
  operation?: string
  outcome?: string
  reason?: string
  queue?: string
  attempt?: number
  status?: number
}

type SafeErrorDescriptor = {
  type: string
  code?: string
}

const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u
const SAFE_ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/u

function safeErrorType(error: unknown): string {
  if (!(error instanceof Error)) return typeof error
  return SAFE_ERROR_NAME.test(error.name) ? error.name : 'Error'
}

function safeErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && SAFE_ERROR_CODE.test(code) ? code : undefined
}

function describeError(error: unknown): SafeErrorDescriptor {
  const code = safeErrorCode(error)
  return {
    type: safeErrorType(error),
    ...(code ? { code } : {}),
  }
}

export function logWorkerError(event: string, error?: unknown, context: SafeLogContext = {}): void {
  console.error({
    event,
    severity: 'error',
    ...(error === undefined ? {} : { error: describeError(error) }),
    ...context,
  })
}

export function logWorkerWarning(event: string, context: SafeLogContext = {}): void {
  console.warn({ event, severity: 'warning', ...context })
}
