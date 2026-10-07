// /v1/me/emails:多邮箱。添加先发 6 位码,验证通过才写 user_emails;设为主邮箱和移除已验证邮箱需要 step-up。
// 主邮箱不能移除(先把另一个已验证邮箱设为主邮箱)。访客转正走 /auth/otp/email/*,这里拒绝访客。
// 认证:cookie session;租户隔离:createTenantDb(user_emails 有 UNIQUE (tenant_id, email))。

import { createTenantDb, schema, USER_PROVISIONED_BY_ANONYMOUS } from '@xid-kit/db'
import { and, asc, eq, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { assertEmailAllowed, isHostedAuthPolicyError } from '../auth/hosted-policy'
import { AppError } from '../lib/errors'
import { requireStepUp } from '../lib/step-up'
import type { SessionData, XidHonoEnv } from '../lib/types'
import { emailSchema, otpCodeSchema, readJsonBody, validateBody } from '../lib/validate'
import { enforceVerifyRateLimit } from '../lib/verify-rate-limit'
import { requestIp } from '../me-auth/shared'
import { emitWebhookAsync } from '../v1/shared'
import {
  cancelPendingContact,
  consumeContactCode,
  findPendingContact,
  issueContactCode,
  type PendingContact,
} from './contact-verification'
import { requireSession } from './shared'
import { hasOtherSignInMethod } from './sign-in-methods'

type EmailAddress = {
  id: string
  email: string
  verified: boolean
  isPrimary: boolean
  // pending:验证码已发出但还没验证的新地址,id 是待验证记录;验证后才成为正式邮箱。
  pending: boolean
  expiresAt: string | null
  createdAt: string | null
}

type EmailRow = typeof schema.userEmails.$inferSelect
type TenantDb = ReturnType<typeof createTenantDb>

const addEmailSchema = v.object({
  email: v.pipe(v.string(), v.trim(), v.toLowerCase(), emailSchema),
})
const verifyEmailSchema = v.object({ code: v.pipe(v.string(), v.trim(), otpCodeSchema) })

const CONTACT_VERIFY_SCOPE = 'me_contact'

function toEmailAddress(row: EmailRow, primaryEmailId: string | null): EmailAddress {
  return {
    id: row.id,
    email: row.email,
    verified: row.verified,
    isPrimary: row.id === primaryEmailId,
    pending: false,
    expiresAt: null,
    createdAt: row.createdAt.toISOString(),
  }
}

function toPendingAddress(pending: PendingContact): EmailAddress {
  return {
    id: pending.id,
    email: pending.target,
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

// 历史数据可能没有 primary_email_id,与 loadPrimaryEmail 同口径回退到 is_primary 行或最早一行。
function primaryIdOf(
  user: typeof schema.users.$inferSelect,
  rows: readonly EmailRow[],
): string | null {
  if (user.primaryEmailId && rows.some((row) => row.id === user.primaryEmailId)) {
    return user.primaryEmailId
  }
  return (rows.find((row) => row.isPrimary) ?? rows[0])?.id ?? null
}

async function listEmails(c: Context<XidHonoEnv>, session: SessionData): Promise<EmailAddress[]> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const [user, rows, pending] = await Promise.all([
    loadUser(db, session.userId),
    db.userEmails.findMany(eq(schema.userEmails.userId, session.userId), {
      orderBy: [asc(schema.userEmails.createdAt), asc(schema.userEmails.id)],
    }),
    findPendingContact(db, { userId: session.userId, kind: 'email' }),
  ])
  const primaryId = primaryIdOf(user, rows)
  const items = rows.map((row) => toEmailAddress(row, primaryId))
  const pendingIsNew = pending && !pending.contactId
  return pendingIsNew ? [...items, toPendingAddress(pending)] : items
}

function assertTenantAllowsEmail(c: Context<XidHonoEnv>, email: string): void {
  try {
    assertEmailAllowed(c.get('tenant'), email)
  } catch (error) {
    if (!isHostedAuthPolicyError(error)) throw error
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'email' } })
  }
}

async function audit(
  c: Context<XidHonoEnv>,
  input: { action: string; userId: string; emailId: string },
): Promise<void> {
  await c.env.AUDIT_QUEUE.send({
    tenantId: c.get('tenant').tenantId,
    action: input.action,
    actorId: input.userId,
    ts: Date.now(),
    payload: { targetType: 'user', targetId: input.userId, emailId: input.emailId },
  })
}

const app = new Hono<XidHonoEnv>()

app.get('/', async (c) => {
  const session = await requireSession(c)
  return c.json({ data: await listEmails(c, session) })
})

app.post('/', async (c) => {
  const session = await requireSession(c)
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const { email } = validateBody(addEmailSchema, json.value)
  const user = await loadUser(db, session.userId)
  if (user.provisionedBy === USER_PROVISIONED_BY_ANONYMOUS) {
    throw new AppError('conflict', { httpStatus: 409 })
  }
  assertTenantAllowsEmail(c, email)

  const existing = await db.userEmails.findOne(eq(schema.userEmails.email, email))
  if (existing?.userId === session.userId) {
    throw new AppError('already_exists', { httpStatus: 409, meta: { paramName: 'email' } })
  }
  const pending = await issueContactCode(c, {
    userId: session.userId,
    kind: 'email',
    flow: { target: email },
    deliver: existing === undefined,
  })
  return c.json(toPendingAddress(pending), 202)
})

// 已有未验证邮箱(例如社交登录带来的)补发验证码。
app.post('/:id/send-code', async (c) => {
  const session = await requireSession(c)
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const row = await db.userEmails.findOne(
    and(eq(schema.userEmails.id, c.req.param('id')), eq(schema.userEmails.userId, session.userId)),
  )
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  if (row.verified) throw new AppError('conflict', { httpStatus: 409 })
  const pending = await issueContactCode(c, {
    userId: session.userId,
    kind: 'email',
    flow: { target: row.email, contactId: row.id },
    deliver: true,
  })
  return c.json(toPendingAddress(pending), 202)
})

app.post('/:id/verify', async (c) => {
  const session = await requireSession(c)
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('otp_invalid')
  const parsed = v.safeParse(verifyEmailSchema, json.value)
  if (!parsed.success) throw new AppError('otp_invalid')
  await enforceVerifyRateLimit({
    env: c.env,
    tenantId: tenant.tenantId,
    scope: CONTACT_VERIFY_SCOPE,
    account: session.userId,
    ip: requestIp(c),
  })

  const id = c.req.param('id')
  const flow = await consumeContactCode(db, {
    userId: session.userId,
    kind: 'email',
    id,
    code: parsed.output.code,
  })
  const now = new Date()
  const verified = { verified: true, verificationStatus: 'verified', verifiedAt: now }
  let emailId = flow.contactId
  if (emailId) {
    const updated = await db.userEmails.update(
      verified,
      and(
        eq(schema.userEmails.id, emailId),
        eq(schema.userEmails.userId, session.userId),
        eq(schema.userEmails.email, flow.target),
      ),
    )
    if (updated.length !== 1) throw new AppError('otp_invalid')
  } else {
    emailId = crypto.randomUUID()
    const inserted = await db.userEmails.insertManyIgnore([
      {
        id: emailId,
        tenantId: tenant.tenantId,
        userId: session.userId,
        email: flow.target,
        ...verified,
      },
    ])
    if (inserted.length !== 1) throw new AppError('otp_invalid')
  }
  // 没有主邮箱的账号(例如只用社交或手机号登录)把第一个验证通过的邮箱设为主邮箱。
  const user = await loadUser(db, session.userId)
  if (!user.primaryEmailId) {
    await setPrimary(db, { userId: session.userId, emailId })
  }
  await audit(c, { action: 'user.email_added', userId: session.userId, emailId })
  return c.json({ data: await listEmails(c, session) })
})

async function setPrimary(db: TenantDb, input: { userId: string; emailId: string }): Promise<void> {
  await db.users.update({ primaryEmailId: input.emailId }, eq(schema.users.id, input.userId))
  await db.userEmails.update(
    { isPrimary: false },
    and(eq(schema.userEmails.userId, input.userId), ne(schema.userEmails.id, input.emailId)),
  )
  await db.userEmails.update(
    { isPrimary: true },
    and(eq(schema.userEmails.userId, input.userId), eq(schema.userEmails.id, input.emailId)),
  )
}

app.post('/:id/primary', async (c) => {
  const session = await requireSession(c)
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const row = await db.userEmails.findOne(
    and(eq(schema.userEmails.id, c.req.param('id')), eq(schema.userEmails.userId, session.userId)),
  )
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  if (!row.verified) throw new AppError('email_verification_required')
  await requireStepUp(c, tenant, session)

  await setPrimary(db, { userId: session.userId, emailId: row.id })
  await audit(c, { action: 'user.primary_email_changed', userId: session.userId, emailId: row.id })
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'user.updated',
    payload: { userId: session.userId },
  })
  return c.json({ data: await listEmails(c, session) })
})

app.delete('/:id', async (c) => {
  const session = await requireSession(c)
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const id = c.req.param('id')
  if (await cancelPendingContact(db, { userId: session.userId, kind: 'email', id })) {
    return new Response(null, { status: 204 })
  }
  const row = await db.userEmails.findOne(
    and(eq(schema.userEmails.id, id), eq(schema.userEmails.userId, session.userId)),
  )
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  const user = await loadUser(db, session.userId)
  const rows = await db.userEmails.findMany(eq(schema.userEmails.userId, session.userId))
  if (primaryIdOf(user, rows) === row.id) throw new AppError('conflict', { httpStatus: 409 })
  if (row.verified) {
    await requireStepUp(c, tenant, session)
    const removed = { kind: 'email', id: row.id } as const
    if (!(await hasOtherSignInMethod(c, { userId: session.userId, removed }))) {
      throw new AppError('sign_in_method_required')
    }
  }

  await db.userEmails.hardDelete(
    and(eq(schema.userEmails.id, row.id), eq(schema.userEmails.userId, session.userId)),
  )
  await audit(c, { action: 'user.email_removed', userId: session.userId, emailId: row.id })
  return new Response(null, { status: 204 })
})

export function registerEmailsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/me/emails', app)
}
