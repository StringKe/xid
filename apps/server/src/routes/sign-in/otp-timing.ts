// 验证码的本地计时:过期只由发送时间推算,服务端对过期与错码返回同一个不透明错误,前端不能据此区分。

import type { OtpSignInMethod } from './shared'

// 与 worker/lib/ttl.ts 的 OTP_EMAIL_TTL_MS / OTP_PHONE_TTL_MS 和发送限流 1 次/分钟保持一致。
export const OTP_EMAIL_LIFETIME_MS = 10 * 60 * 1000
export const OTP_PHONE_LIFETIME_MS = 5 * 60 * 1000
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000

export function otpLifetimeMs(method: OtpSignInMethod): number {
  return method === 'otp-email' ? OTP_EMAIL_LIFETIME_MS : OTP_PHONE_LIFETIME_MS
}

export function otpLifetimeMinutes(method: OtpSignInMethod): number {
  return otpLifetimeMs(method) / 60_000
}

export function isOtpExpired(input: {
  now: number
  sentAt: number
  method: OtpSignInMethod
}): boolean {
  return input.now - input.sentAt >= otpLifetimeMs(input.method)
}

export function resendWaitSeconds(input: { now: number; sentAt: number }): number {
  const remaining = OTP_RESEND_COOLDOWN_MS - (input.now - input.sentAt)
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0
}

export function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}
