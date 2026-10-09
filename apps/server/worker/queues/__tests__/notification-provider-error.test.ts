import { describe, expect, it } from 'vitest'
import { parseRetryAfterSeconds, providerHttpFailure } from '../notification-provider-error'

describe('providerHttpFailure', () => {
  it('marks 429 retryable and rejected once retries run out', () => {
    const failure = providerHttpFailure('twilio', 429, '12')

    expect(failure.retryable).toBe(true)
    expect(failure.outcome).toBe('rejected')
    expect(failure.retryAfterSeconds).toBe(12)
    expect(failure.code).toBe('twilio_429')
  })

  it('marks 5xx retryable and indeterminate once retries run out', () => {
    const failure = providerHttpFailure('vonage', 502)

    expect(failure.retryable).toBe(true)
    expect(failure.outcome).toBe('indeterminate')
    expect(failure.retryAfterSeconds).toBeUndefined()
  })

  it('keeps 408 indeterminate without retry', () => {
    const failure = providerHttpFailure('infobip', 408)

    expect(failure.retryable).toBe(false)
    expect(failure.outcome).toBe('indeterminate')
  })

  it('treats other 4xx as a permanent rejection', () => {
    const failure = providerHttpFailure('meta_whatsapp', 400)

    expect(failure.retryable).toBe(false)
    expect(failure.outcome).toBe('rejected')
  })
})

describe('parseRetryAfterSeconds', () => {
  it('parses delta seconds and an HTTP date', () => {
    const now = Date.parse('2026-10-09T00:00:00Z')

    expect(parseRetryAfterSeconds('45', now)).toBe(45)
    expect(parseRetryAfterSeconds('Fri, 09 Oct 2026 00:01:00 GMT', now)).toBe(60)
  })

  it('clamps to the 1 to 600 second range', () => {
    expect(parseRetryAfterSeconds('0')).toBe(1)
    expect(parseRetryAfterSeconds('86400')).toBe(600)
  })

  it('ignores a missing or malformed header', () => {
    expect(parseRetryAfterSeconds(null)).toBeUndefined()
    expect(parseRetryAfterSeconds('soon')).toBeUndefined()
  })
})
