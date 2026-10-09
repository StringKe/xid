// 手机 OTP 的总量上限:按目标号码的 1/min + 5/h 之外,再按来源 IP 和租户限制每小时、每日发送量,
// 防止换号轮发的短信话费欺诈。计数在 RateLimitStore DO,不可达时 fail closed,超限统一 rate_limited。

import type { RateLimitPolicy } from '../durable-objects/rate-limit-store'
import { reserveRateLimitWindows } from '../lib/rate-limit'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const PHONE_OTP_IP_HOURLY: RateLimitPolicy = {
  windowMs: HOUR_MS,
  maxRequests: 10,
  lockDurationMs: 0,
}
const PHONE_OTP_IP_DAILY: RateLimitPolicy = { windowMs: DAY_MS, maxRequests: 30, lockDurationMs: 0 }
const PHONE_OTP_TENANT_HOURLY: RateLimitPolicy = {
  windowMs: HOUR_MS,
  maxRequests: 500,
  lockDurationMs: 0,
}
const PHONE_OTP_TENANT_DAILY: RateLimitPolicy = {
  windowMs: DAY_MS,
  maxRequests: 5000,
  lockDurationMs: 0,
}

const E164 = /^\+\d{8,15}$/

export function isPhoneOtpTarget(target: string): boolean {
  return E164.test(target)
}

export async function reservePhoneOtpIpBudget(env: Env, ip: string): Promise<void> {
  const key = `otp:phone:ip:${ip}`
  await reserveRateLimitWindows(env, key, [
    { key: `${key}:hour`, policy: PHONE_OTP_IP_HOURLY },
    { key: `${key}:day`, policy: PHONE_OTP_IP_DAILY },
  ])
}

export async function reservePhoneOtpTenantBudget(env: Env, tenantId: string): Promise<void> {
  const key = `otp:phone:tenant:${tenantId}`
  await reserveRateLimitWindows(env, key, [
    { key: `${key}:hour`, policy: PHONE_OTP_TENANT_HOURLY },
    { key: `${key}:day`, policy: PHONE_OTP_TENANT_DAILY },
  ])
}
