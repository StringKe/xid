// provider 调用结果分类。rejected:明确未受理,不重发;indeterminate:可能已受理(超时、408、
// 响应无法解析),不重发;retryable:429 与 5xx,按 Retry-After 或退避重试,次数用尽后按 outcome 记失败。

export type NotificationProviderFailureOutcome = 'rejected' | 'indeterminate'

const MAX_RETRY_AFTER_SECONDS = 600

export class NotificationProviderError extends Error {
  readonly outcome: NotificationProviderFailureOutcome
  readonly code: string
  readonly retryable: boolean
  readonly retryAfterSeconds: number | undefined

  constructor(
    outcome: NotificationProviderFailureOutcome,
    code: string,
    options: { retryable?: boolean; retryAfterSeconds?: number } = {},
  ) {
    super(code)
    this.name = 'NotificationProviderError'
    this.outcome = outcome
    this.code = code
    this.retryable = options.retryable === true
    this.retryAfterSeconds = options.retryAfterSeconds
  }
}

export function parseRetryAfterSeconds(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  const seconds = /^\d+$/.test(trimmed)
    ? Number(trimmed)
    : Math.ceil((Date.parse(trimmed) - now) / 1000)
  if (!Number.isFinite(seconds)) return undefined
  return Math.min(Math.max(seconds, 1), MAX_RETRY_AFTER_SECONDS)
}

export function providerHttpFailure(
  provider: string,
  status: number,
  retryAfter?: string | null,
): NotificationProviderError {
  const code = `${provider}_${status}`
  if (status === 429) {
    return new NotificationProviderError('rejected', code, {
      retryable: true,
      retryAfterSeconds: parseRetryAfterSeconds(retryAfter),
    })
  }
  if (status >= 500) {
    return new NotificationProviderError('indeterminate', code, {
      retryable: true,
      retryAfterSeconds: parseRetryAfterSeconds(retryAfter),
    })
  }
  if (status === 408) return new NotificationProviderError('indeterminate', code)
  return new NotificationProviderError('rejected', code)
}

export function providerResponseFailure(
  provider: string,
  res: Pick<Response, 'status' | 'headers'>,
): NotificationProviderError {
  return providerHttpFailure(provider, res.status, res.headers.get('retry-after'))
}

export function providerRejected(code: string): NotificationProviderError {
  return new NotificationProviderError('rejected', code)
}

export function providerIndeterminate(code: string): NotificationProviderError {
  return new NotificationProviderError('indeterminate', code)
}
