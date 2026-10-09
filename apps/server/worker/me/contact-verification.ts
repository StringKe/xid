// 账户门户添加邮箱或手机号时的 6 位验证码:与登录 OTP 同样只存哈希、限 5 次、按渠道 TTL 过期,
// 但用独立 purpose,不会作废用户正在进行的登录验证码。每个用户每种联系方式同时只有一个待验证码。
// 地址已属于本租户其他用户时照常生成待验证记录但不发送,响应与成功一致,验证永远不会通过。

import { randomString, sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq, gt, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import * as v from 'valibot'
import { smsOtpQueuePayload } from '../auth/delivery-channels'
import { constantTimeEqualStr, recordOtpFailure, reserveOtpSendRateLimit } from '../auth/otp'
import { AppError } from '../lib/errors'
import { requestIp } from '../me-auth/shared'
import { enqueueTransactionalEmail } from '../lib/transactional-email'
import { OTP_EMAIL_TTL_MS, OTP_MAX_ATTEMPTS, OTP_PHONE_TTL_MS } from '../lib/ttl'
import type { XidHonoEnv } from '../lib/types'

type TenantDb = ReturnType<typeof createTenantDb>

export const CONTACT_PURPOSE = { email: 'contact_email', phone: 'contact_phone' } as const
export type ContactKind = keyof typeof CONTACT_PURPOSE

// contactId 指向已存在但未验证的 user_emails 行;新地址验证通过后才写联系人表。
const flowSchema = v.object({ target: v.string(), contactId: v.optional(v.string()) })
export type ContactFlow = v.InferOutput<typeof flowSchema>

export type PendingContact = {
  id: string
  target: string
  contactId: string | null
  expiresAt: Date
}

const channelOf = { email: 'email', phone: 'sms' } as const

function activeTokenWhere(userId: string, kind: ContactKind) {
  return and(
    eq(schema.verificationTokens.userId, userId),
    eq(schema.verificationTokens.purpose, CONTACT_PURPOSE[kind]),
    isNull(schema.verificationTokens.consumedAt),
  )
}

function parseFlow(raw: string | null): ContactFlow | null {
  if (!raw) return null
  const parsed = v.safeParse(flowSchema, JSON.parse(raw))
  return parsed.success ? parsed.output : null
}

async function deliverCode(
  c: Context<XidHonoEnv>,
  input: { kind: ContactKind; target: string; userId: string; code: string; ttlMs: number },
): Promise<void> {
  const tenantId = c.get('tenant').tenantId
  const payload = {
    tenantId,
    userId: input.userId,
    code: input.code,
    expiresInMin: input.ttlMs / 60000,
  }
  if (input.kind === 'email') {
    await enqueueTransactionalEmail(c.env, {
      type: 'otp',
      recipient: input.target,
      locale: c.get('locale'),
      payload,
    })
    return
  }
  await c.env.SMS_QUEUE.send({
    type: 'otp',
    recipient: input.target,
    payload: { ...payload, locale: c.get('locale'), ...smsOtpQueuePayload(c.get('tenant'), c.env) },
  })
}

export async function issueContactCode(
  c: Context<XidHonoEnv>,
  input: {
    userId: string
    kind: ContactKind
    flow: ContactFlow
    // false:地址已被本租户其他用户占用,只写待验证记录,不发送。
    deliver: boolean
  },
): Promise<PendingContact> {
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  await reserveOtpSendRateLimit(c.env, input.flow.target, tenant.tenantId, { ip: requestIp(c) })
  const code = randomString(6, '0123456789')
  const ttlMs = input.kind === 'email' ? OTP_EMAIL_TTL_MS : OTP_PHONE_TTL_MS
  const id = crypto.randomUUID()
  const expiresAt = new Date(Date.now() + ttlMs)
  await db.verificationTokens.update(
    { consumedAt: new Date() },
    activeTokenWhere(input.userId, input.kind),
  )
  await db.verificationTokens.insert({
    id,
    tenantId: tenant.tenantId,
    userId: input.userId,
    tokenHash: id,
    codeHash: await sha256Hex(code),
    flowContext: JSON.stringify(input.flow),
    channel: channelOf[input.kind],
    purpose: CONTACT_PURPOSE[input.kind],
    attemptCount: 0,
    expiresAt,
  })
  if (input.deliver) {
    await deliverCode(c, {
      kind: input.kind,
      target: input.flow.target,
      userId: input.userId,
      code,
      ttlMs,
    })
  }
  return { id, target: input.flow.target, contactId: input.flow.contactId ?? null, expiresAt }
}

export async function findPendingContact(
  db: TenantDb,
  input: { userId: string; kind: ContactKind },
): Promise<PendingContact | null> {
  const row = await db.verificationTokens.findOne(
    and(
      activeTokenWhere(input.userId, input.kind),
      gt(schema.verificationTokens.expiresAt, new Date()),
    ),
  )
  const flow = parseFlow(row?.flowContext ?? null)
  if (!row || !flow || (row.attemptCount ?? 0) >= OTP_MAX_ATTEMPTS) return null
  return {
    id: row.id,
    target: flow.target,
    contactId: flow.contactId ?? null,
    expiresAt: row.expiresAt,
  }
}

export async function cancelPendingContact(
  db: TenantDb,
  input: { userId: string; kind: ContactKind; id: string },
): Promise<boolean> {
  const updated = await db.verificationTokens.update(
    { consumedAt: new Date() },
    and(activeTokenWhere(input.userId, input.kind), eq(schema.verificationTokens.id, input.id)),
  )
  return updated.length === 1
}

// 码正确时一次性消费并返回待验证的地址;错误计数与过期与登录 OTP 一致。
export async function consumeContactCode(
  db: TenantDb,
  input: { userId: string; kind: ContactKind; id: string; code: string },
): Promise<ContactFlow> {
  const row = await db.verificationTokens.findOne(
    and(activeTokenWhere(input.userId, input.kind), eq(schema.verificationTokens.id, input.id)),
  )
  if (!row) throw new AppError('otp_invalid')
  if (row.expiresAt.getTime() <= Date.now()) throw new AppError('otp_expired')
  if ((row.attemptCount ?? 0) >= OTP_MAX_ATTEMPTS) throw new AppError('otp_invalid')
  const codeHash = await sha256Hex(input.code)
  if (!constantTimeEqualStr(codeHash, row.codeHash ?? '')) await recordOtpFailure(db, row)
  const consumed = await db.verificationTokens.update(
    { consumedAt: new Date() },
    and(eq(schema.verificationTokens.id, row.id), isNull(schema.verificationTokens.consumedAt)),
  )
  const flow = parseFlow(row.flowContext)
  if (consumed.length !== 1 || !flow) throw new AppError('otp_invalid')
  return flow
}
