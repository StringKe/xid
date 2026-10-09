// /v1/users/:id 详情子资源与管理员动作:登录方式、组织成员关系、相关审计事件、发送重置密码邮件、重置 MFA。
// 守卫与 users.ts 一致(requireApiKeyOrTopLevelOrgManager);用户不属于当前租户一律 404。
// 响应不含任何密钥材料:不返回 passkey 公钥、TOTP 密文、备用码哈希,第三方账号 ID 只返回掩码。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, desc, eq, inArray, isNull, lt, ne, or } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import { AppError } from '../lib/errors'
import { resolveLocale } from '../lib/locale'
import { revokeUserCredentials } from '../lib/revoke-user-credentials'
import type { XidHonoEnv } from '../lib/types'
import { paginationQuerySchema, validateQuery } from '../lib/validate'
import { sendPasswordResetEmail } from '../me-auth/password-reset-token'
import { redactAuditPayload } from '../queues/audit-redaction'
import {
  MAX_PAGE_SIZE,
  auditActorId,
  decodeCursor,
  encodeCursor,
  requireApiKeyOrTopLevelOrgManager,
} from './shared'
import { auditAdminAction, findTenantUser } from './user-admin-shared'
import { registerUserPasskeyRoutes } from './user-passkeys'
import { assertUserActionAllowed, userDisplayName } from './user-query'

const app = new Hono<XidHonoEnv>()

type TenantDb = ReturnType<typeof createTenantDb>
type UserRow = typeof schema.users.$inferSelect

export function maskExternalId(value: string | null): string | null {
  if (!value) return null
  if (value.length <= 6) return '•'.repeat(value.length)
  return `${value.slice(0, 2)}${'•'.repeat(4)}${value.slice(-2)}`
}

// GET /v1/users/:id/sign-in-methods
app.get('/:id/sign-in-methods', async (c) => {
  await requireApiKeyOrTopLevelOrgManager(c, 'users:read')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const user = await findTenantUser(db, c.req.param('id'), { includeDeleted: true })
  const [password, passkeys, factors, unusedBackupCodes, identities] = await Promise.all([
    db.passwords.findOne(eq(schema.passwords.userId, user.id)),
    db.passkeyCredentials.findMany(
      and(
        eq(schema.passkeyCredentials.userId, user.id),
        isNull(schema.passkeyCredentials.revokedAt),
      ),
      { orderBy: schema.passkeyCredentials.createdAt, limit: 100 },
    ),
    db.mfaFactors.findMany(
      and(eq(schema.mfaFactors.userId, user.id), ne(schema.mfaFactors.factorType, 'passkey')),
      { orderBy: schema.mfaFactors.createdAt, limit: 100 },
    ),
    db.backupCodes.count(
      and(eq(schema.backupCodes.userId, user.id), eq(schema.backupCodes.used, false)),
    ),
    db.userIdentities.findMany(
      and(eq(schema.userIdentities.userId, user.id), isNull(schema.userIdentities.revokedAt)),
      { orderBy: schema.userIdentities.createdAt, limit: 100 },
    ),
  ])
  return c.json({
    hasPassword: password !== undefined,
    passwordUpdatedAt: password?.updatedAt ?? null,
    passkeys: passkeys.map((row) => ({
      id: row.id,
      deviceName: row.deviceName,
      deviceType: row.credentialDeviceType,
      backedUp: row.backedUp,
      lastUsedAt: row.lastUsedAt,
      createdAt: row.createdAt,
    })),
    mfaFactors: factors.map((row) => ({
      id: row.id,
      type: row.factorType,
      status: row.status,
      lastUsedAt: row.lastUsedAt,
      createdAt: row.createdAt,
    })),
    backupCodesRemaining: unusedBackupCodes,
    identities: identities.map((row) => ({
      id: row.id,
      type: row.identityType === 'oauth' ? 'social' : 'sso',
      provider: row.provider,
      providerUserId: maskExternalId(row.providerUserId),
      lastUsedAt: row.lastUsedAt,
      createdAt: row.createdAt,
    })),
  })
})

// GET /v1/users/:id/memberships
app.get('/:id/memberships', async (c) => {
  await requireApiKeyOrTopLevelOrgManager(c, 'users:read')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const user = await findTenantUser(db, c.req.param('id'), { includeDeleted: true })
  const memberships = await db.memberships.findMany(eq(schema.memberships.userId, user.id), {
    orderBy: schema.memberships.createdAt,
    limit: MAX_PAGE_SIZE,
  })
  const orgIds = [...new Set(memberships.map((row) => row.orgId))]
  const orgs =
    orgIds.length === 0
      ? []
      : await db.organizations.findMany(
          and(inArray(schema.organizations.id, orgIds), ne(schema.organizations.status, 'deleted')),
          { limit: orgIds.length },
        )
  const orgById = new Map(orgs.map((row) => [row.id, row]))
  return c.json({
    data: memberships
      .filter((row) => orgById.has(row.orgId))
      .map((row) => {
        const org = orgById.get(row.orgId)
        return {
          id: row.id,
          orgId: row.orgId,
          organizationName: org?.name ?? null,
          organizationSlug: org?.slug ?? null,
          parentOrgId: org?.parentOrgId ?? null,
          role: row.role,
          status: row.status,
          joinedAt: row.joinedAt ?? row.createdAt,
        }
      }),
  })
})

function decodeAuditCursor(cursor: string): { occurredAt: string; id: string } {
  const raw = decodeCursor(cursor)
  const sep = raw.indexOf('|')
  if (sep === -1) throw new AppError('validation_failed', { httpStatus: 422 })
  return { occurredAt: raw.slice(0, sep), id: raw.slice(sep + 1) }
}

function auditAfterCursor(cursor: string | undefined): SQL | undefined {
  if (!cursor) return undefined
  const after = decodeAuditCursor(cursor)
  return or(
    lt(schema.auditEvents.occurredAt, after.occurredAt),
    and(eq(schema.auditEvents.occurredAt, after.occurredAt), lt(schema.auditEvents.id, after.id)),
  )
}

async function actorNames(db: TenantDb, actorIds: readonly string[]): Promise<Map<string, string>> {
  if (actorIds.length === 0) return new Map()
  const [users, emails] = await Promise.all([
    db.users.findMany(inArray(schema.users.id, actorIds), { limit: actorIds.length }),
    db.userEmails.findMany(
      and(inArray(schema.userEmails.userId, actorIds), eq(schema.userEmails.isPrimary, true)),
      { limit: actorIds.length * 2 },
    ),
  ])
  const emailByUser = new Map(emails.map((row) => [row.userId, row.email]))
  const names = new Map<string, string>()
  for (const user of users) {
    if (user.erasedAt !== null) continue
    const name = userDisplayName(user) ?? emailByUser.get(user.id)
    if (name) names.set(user.id, name)
  }
  return names
}

// GET /v1/users/:id/audit-events:该用户作为操作者或对象的事件,含租户级事件(顶层组织管理员即租户管理员)。
app.get('/:id/audit-events', async (c) => {
  await requireApiKeyOrTopLevelOrgManager(c, 'audit_events:read')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const user = await findTenantUser(db, c.req.param('id'), { includeDeleted: true })
  const query = validateQuery(paginationQuerySchema, c.req.query())
  const limit = query.limit ?? MAX_PAGE_SIZE
  const related = or(
    eq(schema.auditEvents.actorId, user.id),
    eq(schema.auditEvents.targetId, user.id),
  )
  const rows = await db.auditEvents.findMany(and(related, auditAfterCursor(query.cursor)), {
    orderBy: [desc(schema.auditEvents.occurredAt), desc(schema.auditEvents.id)],
    limit: limit + 1,
  })
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]
  const names = await actorNames(db, [
    ...new Set(page.map((row) => row.actorId).filter((id): id is string => Boolean(id))),
  ])
  return c.json({
    data: page.map((row) => ({
      id: row.id,
      eventType: row.eventType,
      actorId: row.actorId,
      actorName: row.actorId ? (names.get(row.actorId) ?? null) : null,
      actorIp: row.actorIp,
      targetType: row.targetType,
      targetId: row.targetId,
      orgId: row.orgId,
      meta: redactAuditPayload(row.meta ?? {}),
      occurredAt: row.occurredAt,
    })),
    next_cursor: hasMore && last ? encodeCursor(`${last.occurredAt}|${last.id}`) : null,
    has_more: hasMore,
  })
})

function primaryEmailOf(
  user: UserRow,
  emails: readonly (typeof schema.userEmails.$inferSelect)[],
): string | null {
  const primary =
    emails.find((row) => row.id === user.primaryEmailId) ?? emails.find((row) => row.isPrimary)
  return primary?.email ?? null
}

// POST /v1/users/:id/password-reset:向主邮箱发送重置链接(令牌只存哈希),响应不含令牌。
app.post('/:id/password-reset', async (c) => {
  const auth = await requireApiKeyOrTopLevelOrgManager(c, 'users:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const user = await findTenantUser(db, c.req.param('id'), { includeDeleted: false })
  const emails = await db.userEmails.findMany(eq(schema.userEmails.userId, user.id), { limit: 100 })
  const email = primaryEmailOf(user, emails)
  if (!email) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'email' } })
  }
  await sendPasswordResetEmail({
    env: c.env,
    tenant,
    db,
    userId: user.id,
    email,
    locale: resolveLocale({ userLocale: user.locale }),
  })
  auditAdminAction(c, {
    action: 'user.password_reset_requested',
    actorId: auditActorId(auth),
    userId: user.id,
  })
  return c.json({ sent: true }, 202)
})

// POST /v1/users/:id/mfa/reset:删除验证器、短信因子与备用码;passkey 是登录凭证,保留。
// 随后撤销全部会话与令牌(先 SessionDO 再 D1),用户下次登录按组织策略重新绑定。
app.post('/:id/mfa/reset', async (c) => {
  const auth = await requireApiKeyOrTopLevelOrgManager(c, 'users:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const user = await findTenantUser(db, c.req.param('id'), { includeDeleted: false })
  await assertUserActionAllowed(db, auth, user.id)
  await db.mfaFactors.hardDelete(
    and(eq(schema.mfaFactors.userId, user.id), ne(schema.mfaFactors.factorType, 'passkey')),
  )
  await db.backupCodes.hardDelete(eq(schema.backupCodes.userId, user.id))
  await revokeUserCredentials(c.env, tenant, user.id)
  auditAdminAction(c, { action: 'user.mfa_reset', actorId: auditActorId(auth), userId: user.id })
  return c.json({ reset: true })
})

registerUserPasskeyRoutes(app)

export function registerUserDetailRoutes(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/users', app)
}
