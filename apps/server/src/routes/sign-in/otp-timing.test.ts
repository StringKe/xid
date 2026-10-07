import { describe, expect, it } from 'vitest'
import { formatCountdown, isOtpExpired, otpLifetimeMinutes, resendWaitSeconds } from './otp-timing'

describe('otp timing', () => {
  it('keeps an email code valid for ten minutes and a phone code for five', () => {
    expect(otpLifetimeMinutes('otp-email')).toBe(10)
    expect(otpLifetimeMinutes('otp-sms')).toBe(5)
  })

  it('expires a code exactly at the end of its lifetime', () => {
    const sentAt = 1_000_000

    expect(isOtpExpired({ now: sentAt + 9 * 60_000, sentAt, method: 'otp-email' })).toBe(false)
    expect(isOtpExpired({ now: sentAt + 10 * 60_000, sentAt, method: 'otp-email' })).toBe(true)
    expect(isOtpExpired({ now: sentAt + 5 * 60_000, sentAt, method: 'otp-whatsapp' })).toBe(true)
  })

  it('counts down the one-minute resend window and stops at zero', () => {
    expect(resendWaitSeconds({ now: 18_000, sentAt: 0 })).toBe(42)
    expect(resendWaitSeconds({ now: 60_000, sentAt: 0 })).toBe(0)
  })

  it('formats the countdown as minutes and zero-padded seconds', () => {
    expect(formatCountdown(42)).toBe('0:42')
    expect(formatCountdown(65)).toBe('1:05')
  })
})
