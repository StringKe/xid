// session-auth(me-auth)子域共享辅助:rate-limit DO 调用、Turnstile 校验、session 工具。
// 这些端点全部挂在 protocol sub-app(经 tenant 中间件),按 cookie session 认证(readSession),
// 不是 sk_live Bearer。匿名端点(登录前)与已登录端点(account/mfa)共用本层。
// 铁律:tenant 从 c.get('tenant') 取;D1 走 createTenantDb 租户层;枚举防护统一模糊响应。

import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { SessionData, XidHonoEnv } from '../lib/types'
import { ACTIVE_SESSION_STATUS, readSession } from '../lib/session'
import { checkRateLimitStore } from '../lib/rate-limit'
import { POLICIES } from '../durable-objects/rate-limit-store'
import type { RateLimitPolicy } from '../durable-objects/rate-limit-store'

// 发送类限流(磁链/OTP/重发):同一接收方 5/hour(1/min 走 POLICIES.OTP_SEND)。
export const SEND_PER_HOUR_POLICY: RateLimitPolicy = {
  windowMs: 60 * 60 * 1000,
  maxRequests: 5,
  lockDurationMs: 0,
}

// 自助建组织限流:同一用户 10/day,防登录后无限建 org 刷资源。
export const ORG_CREATE_PER_DAY_POLICY: RateLimitPolicy = {
  windowMs: 24 * 60 * 60 * 1000,
  maxRequests: 10,
  lockDurationMs: 0,
}

// RateLimitStore DO check:超限抛 rate_limited(枚举防护:发送端点超限仍由调用方决定是否 200)。
export async function checkRateLimit(
  env: Env,
  key: string,
  policy: RateLimitPolicy,
): Promise<boolean> {
  const result = await checkRateLimitStore(env, key, policy)
  return result.allowed
}

// 发送类双窗限流(1/min + 5/hour per 接收方),超限抛 rate_limited。
export async function enforceSendRateLimit(env: Env, scope: string, target: string): Promise<void> {
  const minKey = `${scope}:min:${target}`
  const hourKey = `${scope}:hour:${target}`
  if (!(await checkRateLimit(env, minKey, POLICIES.OTP_SEND))) throw new AppError('rate_limited')
  if (!(await checkRateLimit(env, hourKey, SEND_PER_HOUR_POLICY)))
    throw new AppError('rate_limited')
}

// cookie session 认证:无有效 session 抛 401。已登录端点(sign-out 幂等除外)统一用此守卫。
// 只认完整 active session:session 中间件按全状态注入 c.get('session'),pending_mfa /
// pending_mfa_setup 在此视为未认证(防 MFA 绕过,对齐 me/shared.ts resolveActiveSession);
// MFA 挑战类端点不走本守卫,各自 readSession 显式声明 allowedStatuses。
export async function requireSession(c: Context<XidHonoEnv>): Promise<SessionData> {
  const current = c.get('session')
  if (current?.status === ACTIVE_SESSION_STATUS) return current
  const session = await readSession(c, [ACTIVE_SESSION_STATUS])
  if (!session) throw new AppError('unauthorized', { httpStatus: 401 })
  return session
}

// 请求 IP / UA(签发 session 时记录,见 lib/session IssueSessionInput)。
export function requestIp(c: Context<XidHonoEnv>): string | null {
  return c.req.header('cf-connecting-ip') ?? null
}

export function requestUserAgent(c: Context<XidHonoEnv>): string | null {
  return c.req.header('user-agent') ?? null
}

const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
// siteverify 在登录关键路径上,超时必须短,避免 Cloudflare 侧抖动拖垮认证 P99。
const TURNSTILE_VERIFY_TIMEOUT_MS = 5000

// Turnstile 校验(01 章 7:登录/注册/密码重置/OTP 发送介入点)。
// TURNSTILE_SECRET 未配置时跳过(dev/test 友好);已配置则强制 siteverify 真校验。
// 失败统一抛模糊认证错误(captcha_required / captcha_failed),不区分用户存在性;
// 远端失败原因只进 cause 供服务端日志,不外泄给客户端(枚举防护,见 anti-abuse rule)。
export async function verifyTurnstile(
  token: string | null | undefined,
  env: Env,
  ip?: string | null,
): Promise<void> {
  const secret = env.TURNSTILE_SECRET
  if (!secret) return
  if (!token) throw new AppError('captcha_required')
  const body = new URLSearchParams({ secret, response: token })
  if (ip) body.set('remoteip', ip)
  let success = false
  try {
    const res = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(TURNSTILE_VERIFY_TIMEOUT_MS),
    })
    const result = (await res.json()) as { success?: boolean }
    success = result.success === true
  } catch (err) {
    throw new AppError('captcha_failed', { cause: err })
  }
  if (!success) throw new AppError('captcha_failed')
}
