// POST /auth/resend-verification。
// 有 session:给当前用户未验证的主邮箱(或待验证邮箱)重发。
// 无 session(注册后链接过期):按邮箱重发,形状与 forgot-password 相同,恒 200 不泄露账户是否存在;
// 邮箱匹配多个组织时逐个处理,只给 active 用户未验证的主邮箱发信。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { readSession } from '../lib/session'
import type { TenantVar, XidHonoEnv } from '../lib/types'
import { firstIssuePath, readJsonBody } from '../lib/validate'
import { issueEmailVerification } from './email-verify-token'
import { resolveEntryTenants, withTenant } from './instance-login'
import { enforceSendRateLimit, requestIp, verifyTurnstile } from './shared'

type Db = ReturnType<typeof createTenantDb>
type EmailRow = typeof schema.userEmails.$inferSelect

const resendBodySchema = v.object({
  email: v.optional(v.string()),
  organizationId: v.optional(v.nullable(v.string())),
  turnstileToken: v.optional(v.nullable(v.string())),
})

export async function loadPrimaryEmailRow(
  db: Db,
  userId: string,
  primaryEmailId: string | null,
): Promise<EmailRow | null> {
  if (primaryEmailId) {
    const row = await db.userEmails.findOne(
      and(eq(schema.userEmails.id, primaryEmailId), eq(schema.userEmails.userId, userId)),
    )
    if (row) return row
  }
  return (
    (await db.userEmails.findOne(
      and(eq(schema.userEmails.userId, userId), eq(schema.userEmails.isPrimary, true)),
    )) ?? null
  )
}

export async function handleResendVerification(c: Context<XidHonoEnv>): Promise<Response> {
  const session = c.get('session') ?? (await readSession(c))
  if (session) return resendForSession(c, session.userId)
  return resendForEmail(c)
}

async function resendForSession(c: Context<XidHonoEnv>, userId: string): Promise<Response> {
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const user = await db.users.findOne(eq(schema.users.id, userId))
  if (!user || user.status !== 'active' || user.deletedAt !== null) return c.json({ ok: true })

  const primary = await loadPrimaryEmailRow(db, user.id, user.primaryEmailId)
  const targetEmail = primary
    ? primary.verified
      ? null
      : primary.email.trim().toLowerCase()
    : (user.pendingEmail?.trim().toLowerCase() ?? null)
  if (!targetEmail) return c.json({ ok: true })

  await enforceSendRateLimit(c.env, `emailverify:${tenant.tenantId}`, targetEmail)
  await issueEmailVerification({
    env: c.env,
    tenant,
    userId,
    email: targetEmail,
    locale: c.get('locale'),
  })
  return c.json({ ok: true })
}

async function resendForEmail(c: Context<XidHonoEnv>): Promise<Response> {
  const json = await readJsonBody(c)
  if (!json.ok) return c.json({ ok: true })
  const parsed = v.safeParse(resendBodySchema, json.value)
  if (!parsed.success) {
    const paramName = firstIssuePath(parsed.issues)
    if (paramName.split('.')[0] !== 'organizationId') return c.json({ ok: true })
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName } })
  }
  const email = (parsed.output.email ?? '').trim().toLowerCase()
  if (!email) return c.json({ ok: true })
  await verifyTurnstile(parsed.output.turnstileToken, c.env, requestIp(c))
  const tenants = await resolveEntryTenants(
    c,
    { kind: 'email', value: email },
    parsed.output.organizationId,
  )
  for (const tenant of tenants) {
    await withTenant(c, tenant, () => resendForTenantEmail(c, tenant, email))
  }
  return c.json({ ok: true })
}

async function resendForTenantEmail(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  email: string,
): Promise<void> {
  await enforceSendRateLimit(c.env, `emailverify:${tenant.tenantId}`, email)
  const db = createTenantDb(c.env.DB, tenant)
  const emailRow = await db.userEmails.findOne(eq(schema.userEmails.email, email))
  if (!emailRow || emailRow.verified) return
  const user = await db.users.findOne(eq(schema.users.id, emailRow.userId))
  if (!user || user.status !== 'active' || user.deletedAt !== null) return
  const primary = await loadPrimaryEmailRow(db, user.id, user.primaryEmailId)
  if (primary?.id !== emailRow.id) return
  await issueEmailVerification({
    env: c.env,
    tenant,
    userId: user.id,
    email,
    locale: c.get('locale'),
  })
}
