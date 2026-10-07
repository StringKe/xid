// /v1/me/phones:添加手机号(短信 6 位码验证)与移除。已验证手机号不会自动成为 MFA 因子,
// 短信两步验证仍需在 Security 单独开启;移除手机号时同时停用以它为目标的短信因子。
// 发送复用 OTP 的 1/min + 5/h 限流与 E.164 规范化,国家前缀白名单与登录 OTP 一致。

import { createTenantDb, schema, USER_PROVISIONED_BY_ANONYMOUS } from '@xid-kit/db'
import { normalizePhoneNumber } from '@xid-kit/types'
import { and, asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { smsDeliveryReady } from '../auth/delivery-channels'
import { validatePhoneOtpTarget } from '../auth/otp'
import { AppError } from '../lib/errors'
import { SMS_FACTOR_TYPE } from '../lib/mfa-methods'
import { requireStepUp } from '../lib/step-up'
import type { SessionData, XidHonoEnv } from '../lib/types'
import { otpCodeSchema, readJsonBody, validateBody } from '../lib/validate'
import { enforceVerifyRateLimit } from '../lib/verify-rate-limit'
import { requestIp } from '../me-auth/shared'
import {
  cancelPendingContact,
  consumeContactCode,
  findPendingContact,
  issueContactCode,
  type PendingContact,
} from './contact-verification'
import { requireSession } from './shared'
import { hasOtherSignInMethod } from './sign-in-methods'

type PhoneNumber = {
  id: string
  phone: string
  verified: boolean
  isPrimary: boolean
  pending: boolean
  expiresAt: string | null
  createdAt: string | null
}

type PhoneList = {
  data: PhoneNumber[]
  // 租户没有可用短信渠道时不能添加手机号,界面据此隐藏入口。
  canAdd: boolean
}

type PhoneRow = typeof schema.userPhones.$inferSelect
type TenantDb = ReturnType<typeof createTenantDb>

const addPhoneSchema = v.object({ phone: v.pipe(v.string(), v.trim(), v.minLength(1)) })
const verifyPhoneSchema = v.object({ code: v.pipe(v.string(), v.trim(), otpCodeSchema) })

const CONTACT_VERIFY_SCOPE = 'me_contact'

function toPhone(row: PhoneRow, primaryPhoneId: string | null): PhoneNumber {
  return {
    id: row.id,
    phone: row.phone,
    verified: row.verified,
    isPrimary: row.id === primaryPhoneId,
    pending: false,
    expiresAt: null,
    createdAt: row.createdAt.toISOString(),
  }
}

function toPendingPhone(pending: PendingContact): PhoneNumber {
  return {
    id: pending.id,
    phone: pending.target,
    verified: false,
    isPrimary: false,
    pending: true,
    expiresAt: pending.expiresAt.toISOString(),
    createdAt: null,
  }
}

async function loadUser(db: TenantDb, userId: string): Promise<typeof schema.users.$inferSelect> {
  const user = await db.users.findOne(eq(schema.users.id, userId))
  if (!user) throw new AppError('unauthorized', { httpStatus: 401 })
  return user
}

async function listPhones(c: Context<XidHonoEnv>, session: SessionData): Promise<PhoneList> {
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const [user, rows, pending] = await Promise.all([
    loadUser(db, session.userId),
    db.userPhones.findMany(eq(schema.userPhones.userId, session.userId), {
      orderBy: [asc(schema.userPhones.createdAt), asc(schema.userPhones.id)],
    }),
    findPendingContact(db, { userId: session.userId, kind: 'phone' }),
  ])
  const data = rows.map((row) => toPhone(row, user.primaryPhoneId))
  return {
    data: pending ? [...data, toPendingPhone(pending)] : data,
    canAdd: smsDeliveryReady(tenant, c.env),
  }
}

const app = new Hono<XidHonoEnv>()

app.get('/', async (c) => {
  const session = await requireSession(c)
  return c.json(await listPhones(c, session))
})

app.post('/', async (c) => {
  const session = await requireSession(c)
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(addPhoneSchema, json.value)
  const phone = normalizePhoneNumber(body.phone)
  if (!phone || !validatePhoneOtpTarget(phone)) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'phone' } })
  }
  if (!smsDeliveryReady(tenant, c.env)) throw new AppError('invalid_request')
  const user = await loadUser(db, session.userId)
  if (user.provisionedBy === USER_PROVISIONED_BY_ANONYMOUS) {
    throw new AppError('conflict', { httpStatus: 409 })
  }

  const existing = await db.userPhones.findOne(eq(schema.userPhones.phone, phone))
  if (existing?.userId === session.userId) {
    throw new AppError('already_exists', { httpStatus: 409, meta: { paramName: 'phone' } })
  }
  const pending = await issueContactCode(c, {
    userId: session.userId,
    kind: 'phone',
    flow: { target: phone },
    deliver: existing === undefined,
  })
  return c.json(toPendingPhone(pending), 202)
})

app.post('/:id/verify', async (c) => {
  const session = await requireSession(c)
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('otp_invalid')
  const parsed = v.safeParse(verifyPhoneSchema, json.value)
  if (!parsed.success) throw new AppError('otp_invalid')
  await enforceVerifyRateLimit({
    env: c.env,
    tenantId: tenant.tenantId,
    scope: CONTACT_VERIFY_SCOPE,
    account: session.userId,
    ip: requestIp(c),
  })

  const flow = await consumeContactCode(db, {
    userId: session.userId,
    kind: 'phone',
    id: c.req.param('id'),
    code: parsed.output.code,
  })
  const phoneId = crypto.randomUUID()
  const inserted = await db.userPhones.insertManyIgnore([
    {
      id: phoneId,
      tenantId: tenant.tenantId,
      userId: session.userId,
      phone: flow.target,
      verified: true,
      verificationStatus: 'verified',
      verifiedAt: new Date(),
    },
  ])
  if (inserted.length !== 1) throw new AppError('otp_invalid')
  const user = await loadUser(db, session.userId)
  if (!user.primaryPhoneId) {
    await db.users.update({ primaryPhoneId: phoneId }, eq(schema.users.id, session.userId))
    await db.userPhones.update({ isPrimary: true }, eq(schema.userPhones.id, phoneId))
  }
  await c.env.AUDIT_QUEUE.send({
    tenantId: tenant.tenantId,
    action: 'user.phone_added',
    actorId: session.userId,
    ts: Date.now(),
    payload: { targetType: 'user', targetId: session.userId, phoneId },
  })
  return c.json(await listPhones(c, session))
})

app.delete('/:id', async (c) => {
  const session = await requireSession(c)
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const id = c.req.param('id')
  if (await cancelPendingContact(db, { userId: session.userId, kind: 'phone', id })) {
    return new Response(null, { status: 204 })
  }
  const owned = and(eq(schema.userPhones.id, id), eq(schema.userPhones.userId, session.userId))
  const row = await db.userPhones.findOne(owned)
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  if (row.verified) {
    await requireStepUp(c, tenant, session)
    const removed = { kind: 'phone', id: row.id } as const
    if (!(await hasOtherSignInMethod(c, { userId: session.userId, removed }))) {
      throw new AppError('sign_in_method_required')
    }
  }

  await db.mfaFactors.update(
    { status: 'revoked' },
    and(
      eq(schema.mfaFactors.userId, session.userId),
      eq(schema.mfaFactors.factorType, SMS_FACTOR_TYPE),
      eq(schema.mfaFactors.target, row.id),
    ),
  )
  await db.userPhones.hardDelete(owned)
  const user = await loadUser(db, session.userId)
  if (user.primaryPhoneId === row.id) {
    await db.users.update({ primaryPhoneId: null }, eq(schema.users.id, session.userId))
  }
  await c.env.AUDIT_QUEUE.send({
    tenantId: tenant.tenantId,
    action: 'user.phone_removed',
    actorId: session.userId,
    ts: Date.now(),
    payload: { targetType: 'user', targetId: session.userId, phoneId: row.id },
  })
  return new Response(null, { status: 204 })
})

export function registerPhonesRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/me/phones', app)
}
