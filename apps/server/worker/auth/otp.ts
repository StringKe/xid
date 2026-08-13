// otp.ts:Email OTP(6 位,10min)+ WhatsApp/SMS OTP(6 位,5min)passwordless 认证 handler。
// OTP 存 HMAC-SHA256 哈希(verificationTokens.codeHash),验证后立即删(01 章 4)。
// 限流:同一邮箱/手机 1/min + 5/hour(RateLimitStore DO,anti-abuse rule)。
// 最多 5 次错误后 token 作废(01 章 4:Email OTP 5 次错误后作废)。
// Phone OTP 国家白名单默认 US/CA,租户可扩展(01 章 4)。
// 枚举防护:邮箱/手机不存在与已发送统一 200 模糊响应。

import { randomString, sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { checkRateLimitStore, reserveRateLimitWindows } from '../lib/rate-limit'
import { POLICIES } from '../durable-objects/rate-limit-store'
import type { RateLimitPolicy } from '../durable-objects/rate-limit-store'
import { smsOtpQueuePayload, whatsappOtpQueuePayload } from './delivery-channels'
import { OTP_EMAIL_TTL_MS, OTP_MAX_ATTEMPTS, OTP_PHONE_TTL_MS } from '../lib/ttl'
import type { PasswordlessFlowContext } from './passwordless-flow'
import { serializePasswordlessFlowContext } from './passwordless-flow'

// Phone 国家前缀白名单(默认 US +1 / CA +1)
const PHONE_ALLOWED_PREFIXES = ['+1']

export type OtpChannel = 'email' | 'whatsapp' | 'sms'

const RL_MIN_KEY = (target: string, tenantId: string) => `otp:min:${tenantId}:${target}`
const RL_HOUR_KEY = (target: string, tenantId: string) => `otp:hour:${tenantId}:${target}`

const OTP_SEND_HOURLY_POLICY = {
  windowMs: 60 * 60 * 1000,
  maxRequests: 5,
  lockDurationMs: 0,
} as const

const ACTIVE_CREDENTIAL_REPLACE_ATTEMPTS = 3

export async function checkRateLimit(
  env: Env,
  key: string,
  policy: RateLimitPolicy,
): Promise<void> {
  const result = await checkRateLimitStore(env, key, policy)
  if (!result.allowed) throw new AppError('rate_limited')
}

export async function reserveOtpSendRateLimit(
  env: Env,
  target: string,
  tenantId: string,
): Promise<void> {
  await reserveRateLimitWindows(env, `otp:send:${tenantId}:${target}`, [
    { key: RL_MIN_KEY(target, tenantId), policy: POLICIES.OTP_SEND },
    { key: RL_HOUR_KEY(target, tenantId), policy: OTP_SEND_HOURLY_POLICY },
  ])
}

// 生成 6 位数字 OTP(crypto.getRandomValues,无模偏差)。
function generateOtp(): string {
  return randomString(6, '0123456789')
}

// constant-time OTP 比较(防时序侧信道)。
export function constantTimeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ (b.charCodeAt(i) ?? 0)
  }
  return diff === 0
}

function validatePhoneOtpTarget(phone: string): boolean {
  return PHONE_ALLOWED_PREFIXES.some((pfx) => phone.startsWith(pfx))
}

// 限流 key + hourly policy 导出供 me-auth 渠道拆分端点(/otp/email/send 等)复用,统一 key 命名。
export { RL_MIN_KEY as otpMinKey, RL_HOUR_KEY as otpHourKey, OTP_SEND_HOURLY_POLICY }
export { validatePhoneOtpTarget }

// 生成 + 持久化 OTP(删旧同渠道 token,插新 token,email 渠道入队发送)。
export async function persistAndSendOtp(opts: {
  c: Context<XidHonoEnv>
  db: ReturnType<typeof createTenantDb>
  tenantId: string
  channel: OtpChannel
  target: string
  userId: string
  flowContext?: PasswordlessFlowContext
}): Promise<void> {
  const { c, db, tenantId, channel, target, userId, flowContext } = opts
  const code = generateOtp()
  const ttlMs = channel === 'email' ? OTP_EMAIL_TTL_MS : OTP_PHONE_TTL_MS
  const tokenId = crypto.randomUUID()

  await replaceActiveOtpToken({
    db,
    channel,
    purpose: 'otp',
    values: {
      id: tokenId,
      tenantId,
      userId,
      tokenHash: tokenId,
      codeHash: await sha256Hex(code),
      ...(flowContext ? { flowContext: serializePasswordlessFlowContext(flowContext) } : {}),
      channel,
      purpose: 'otp',
      attemptCount: 0,
      expiresAt: new Date(Date.now() + ttlMs),
    },
  })
  if (channel === 'email') {
    await c.env.EMAIL_QUEUE.send({
      type: 'otp',
      recipient: target,
      payload: { tenantId, userId, code, expiresInMin: ttlMs / 60000 },
    })
  } else if (channel === 'whatsapp') {
    const channelPayload = whatsappOtpQueuePayload(c.get('tenant'), c.env)
    await c.env.WHATSAPP_QUEUE.send({
      type: 'otp',
      recipient: target,
      payload: {
        tenantId,
        userId,
        code,
        expiresInMin: ttlMs / 60000,
        locale: c.get('locale'),
        ...channelPayload,
      },
    })
  } else {
    const channelPayload = smsOtpQueuePayload(c.get('tenant'), c.env)
    await c.env.SMS_QUEUE.send({
      type: 'otp',
      recipient: target,
      payload: {
        tenantId,
        userId,
        code,
        expiresInMin: ttlMs / 60000,
        locale: c.get('locale'),
        ...channelPayload,
      },
    })
  }
}

function isActiveCredentialConflict(error: unknown): boolean {
  return error instanceof Error && /unique constraint/iu.test(error.message)
}

export async function replaceActiveOtpToken(opts: {
  db: ReturnType<typeof createTenantDb>
  channel: OtpChannel
  purpose: 'otp'
  values: {
    id: string
    tenantId: string
    userId: string
    tokenHash: string
    codeHash?: string
    flowContext?: string
    channel?: OtpChannel
    purpose: 'otp'
    attemptCount?: number
    expiresAt: Date
  }
}): Promise<void> {
  const { db, channel, purpose, values } = opts
  const currentCredential = and(
    eq(schema.verificationTokens.userId, values.userId),
    eq(schema.verificationTokens.purpose, purpose),
    eq(schema.verificationTokens.channel, channel),
    isNull(schema.verificationTokens.consumedAt),
  )

  for (let attempt = 1; attempt <= ACTIVE_CREDENTIAL_REPLACE_ATTEMPTS; attempt++) {
    await db.verificationTokens.update({ consumedAt: new Date() }, currentCredential)
    try {
      await db.verificationTokens.insert(values)
      return
    } catch (error) {
      if (!isActiveCredentialConflict(error) || attempt === ACTIVE_CREDENTIAL_REPLACE_ATTEMPTS) {
        throw error
      }
    }
  }
}

// target(email/phone)解析为 userId,verify 必须按此 userId 绑定 token,绝不跨账户。
export async function resolveTargetUserId(
  db: ReturnType<typeof createTenantDb>,
  channel: OtpChannel,
  target: string,
): Promise<string | null> {
  if (channel === 'email') {
    const row = await db.userEmails.findOne(eq(schema.userEmails.email, target))
    return row?.userId ?? null
  }
  const row = await db.userPhones.findOne(eq(schema.userPhones.phone, target))
  return row?.userId ?? null
}

export type OtpRow = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createTenantDb>['verificationTokens']['findOne']>>
>

// P0:按 target -> userId,再按 (userId, channel, purpose) 精确查 OTP token + 状态校验(枚举防护统一错误)。
export async function loadVerifiableOtp(
  db: ReturnType<typeof createTenantDb>,
  channel: OtpChannel,
  target: string,
): Promise<OtpRow> {
  const targetUserId = await resolveTargetUserId(db, channel, target)
  const tokenRow = targetUserId
    ? await db.verificationTokens.findOne(
        and(
          eq(schema.verificationTokens.userId, targetUserId),
          eq(schema.verificationTokens.channel, channel),
          eq(schema.verificationTokens.purpose, 'otp'),
          isNull(schema.verificationTokens.consumedAt),
        ),
      )
    : undefined
  if (!tokenRow) throw new AppError('otp_invalid')
  if (tokenRow.consumedAt !== null) throw new AppError('otp_invalid')
  if (tokenRow.expiresAt.getTime() <= Date.now()) throw new AppError('otp_expired')
  if ((tokenRow.attemptCount ?? 0) >= OTP_MAX_ATTEMPTS) throw new AppError('otp_invalid')
  return tokenRow
}

// 码错误:递增失败计数,达上限删 token,统一抛 otp_invalid。
export async function recordOtpFailure(
  db: ReturnType<typeof createTenantDb>,
  tokenRow: OtpRow,
): Promise<never> {
  const newCount = (tokenRow.attemptCount ?? 0) + 1
  const values =
    newCount >= OTP_MAX_ATTEMPTS
      ? { attemptCount: newCount, consumedAt: new Date() }
      : { attemptCount: newCount }
  await db.verificationTokens.update(
    values,
    and(
      eq(schema.verificationTokens.tokenHash, tokenRow.tokenHash),
      eq(schema.verificationTokens.attemptCount, tokenRow.attemptCount ?? 0),
      isNull(schema.verificationTokens.consumedAt),
    ),
  )
  throw new AppError('otp_invalid')
}

export async function consumeVerifiableOtp(
  db: ReturnType<typeof createTenantDb>,
  tokenRow: OtpRow,
): Promise<boolean> {
  const consumed = await db.verificationTokens.update(
    { consumedAt: new Date() },
    and(
      eq(schema.verificationTokens.tokenHash, tokenRow.tokenHash),
      isNull(schema.verificationTokens.consumedAt),
    ),
  )
  return consumed.length === 1
}
