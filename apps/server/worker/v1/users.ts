// Management API v1: /v1/users 身份资源。
// CRUD + list(筛选、计数、cursor 分页) + ban/unban + bulk metadata PATCH + NDJSON / CSV 导出。
// 认证:sk_live_/sk_test_ Bearer,或顶层组织 owner/admin/org_manager 的 cookie 会话
// (requireApiKeyOrTopLevelOrgManager);子组织管理员无权访问租户级用户目录。
// 租户隔离:所有查询走 createTenantDb(P0),tenant_id 从 TenantContext 取。

import { createTenantDb, schema } from '@xid-kit/db'
import { normalizePhoneNumber } from '@xid-kit/types'
import { and, desc, eq, gt, lt, or } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import { isUniqueConstraintError } from '../lib/d1-errors'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import { resolveLocale } from '../lib/locale'
import { revokeUserCredentials } from '../lib/revoke-user-credentials'
import { requireStepUp } from '../lib/step-up'
import {
  bcp47LocaleSchema,
  emailSchema,
  ianaTimeZoneSchema,
  PROFILE_NAME_MAX_LENGTH,
  profileNameSchema,
  readJsonBody,
  validateBody,
  validateQuery,
} from '../lib/validate'
import { sendPasswordResetEmail } from '../me-auth/password-reset-token'
import { scheduleUserScimTargetSyncs } from '../scim/outbound-enqueue'
import {
  auditActorId,
  decodeCursor,
  emitManagementAuditAsync,
  emitWebhookAsync,
  encodeCursor,
  parsePagination,
  requireApiKeyOrTopLevelOrgManager,
  type OrgScopedAuth,
} from './shared'
import {
  assertUserActionAllowed,
  countUsersByStatus,
  csvHeader,
  csvRow,
  notDeletedUser,
  readUserListQuery,
  statusFilter,
  summarizeUsers,
  userFiltersWithoutStatus,
  userListQuerySchema,
} from './user-query'
import { registerUserDetailRoutes } from './user-detail'

const app = new Hono<XidHonoEnv>()
const EXPORT_BATCH_SIZE = 100

const metadataSchema = v.record(v.string(), v.unknown())
const usernameSchema = v.pipe(v.string(), v.maxLength(PROFILE_NAME_MAX_LENGTH))
const externalIdSchema = v.pipe(v.string(), v.maxLength(255))

const createUserBodySchema = v.object({
  username: v.optional(usernameSchema),
  external_id: v.optional(externalIdSchema),
  email: v.optional(emailSchema),
  phone: v.optional(v.pipe(v.string(), v.maxLength(32))),
  send_password_setup: v.optional(v.boolean()),
  first_name: v.optional(profileNameSchema),
  last_name: v.optional(profileNameSchema),
  display_name: v.optional(profileNameSchema),
  public_metadata: v.optional(metadataSchema),
  private_metadata: v.optional(metadataSchema),
  unsafe_metadata: v.optional(metadataSchema),
})

const patchUserBodySchema = v.object({
  first_name: v.optional(profileNameSchema),
  last_name: v.optional(profileNameSchema),
  display_name: v.optional(profileNameSchema),
  username: v.optional(usernameSchema),
  external_id: v.optional(externalIdSchema),
  public_metadata: v.optional(metadataSchema),
  private_metadata: v.optional(metadataSchema),
  unsafe_metadata: v.optional(metadataSchema),
  locale: v.optional(bcp47LocaleSchema),
  timezone: v.optional(ianaTimeZoneSchema),
})

const bulkMetadataBodySchema = v.object({
  updates: v.pipe(
    v.array(v.object({ user_id: v.string(), public_metadata: metadataSchema })),
    v.minLength(1),
    v.maxLength(100),
  ),
})

const exportQuerySchema = v.object({ format: v.optional(v.picklist(['ndjson', 'csv'])) })

type UserRow = typeof schema.users.$inferSelect

// 白名单显式列出;剔除 failedLoginCount、provisionedBy、mergedIntoUserId、主联系方式 FK、tenantId 等内部字段。
// 字段名保持 camelCase:@xid-kit/core 的 ManagementUser wire 契约按 camelCase 读。
export function toUserResponse(row: UserRow) {
  return {
    id: row.id,
    username: row.username,
    externalId: row.externalId,
    firstName: row.firstName,
    lastName: row.lastName,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    locale: row.locale,
    timezone: row.timezone,
    publicMetadata: row.publicMetadata,
    privateMetadata: row.privateMetadata,
    unsafeMetadata: row.unsafeMetadata,
    customAttributes: row.customAttributes,
    status: row.deletedAt !== null ? 'deleted' : row.status,
    passwordChangeRequired: row.passwordChangeRequired,
    lockoutUntil: row.lockoutUntil,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function auditUser(
  c: Context<XidHonoEnv>,
  auth: OrgScopedAuth,
  input: { action: string; userId: string; details?: Record<string, unknown> },
): void {
  emitManagementAuditAsync(c, {
    action: input.action,
    actorId: auditActorId(auth),
    orgId: c.get('tenant').tenantId,
    targetType: 'user',
    targetId: input.userId,
    ...(input.details ? { details: input.details } : {}),
  })
}

// 列表按 created_at DESC, id DESC 排序;复合游标 "createdAtMs|id"。
function decodeUserCursor(cursor: string): { createdAt: Date; id: string } {
  const raw = decodeCursor(cursor)
  const sep = raw.indexOf('|')
  const createdAt = Number(raw.slice(0, sep))
  if (sep === -1 || !Number.isFinite(createdAt)) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'cursor' } })
  }
  return { createdAt: new Date(createdAt), id: raw.slice(sep + 1) }
}

function userAfterCursor(cursor: string | null): SQL | undefined {
  if (!cursor) return undefined
  const after = decodeUserCursor(cursor)
  return or(
    lt(schema.users.createdAt, after.createdAt),
    and(eq(schema.users.createdAt, after.createdAt), lt(schema.users.id, after.id)),
  )
}

// GET /v1/users?limit=&cursor=&search=&status=&sign_in_method=&created_from=&created_to=
//   &last_sign_in_from=&last_sign_in_to=&provisioned_by=
app.get('/', async (c) => {
  await requireApiKeyOrTopLevelOrgManager(c, 'users:read')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const { limit, cursor } = parsePagination(c)
  const query = validateQuery(userListQuerySchema, readUserListQuery(c.req.query()))
  const base = userFiltersWithoutStatus(query)
  const filters = [...base, statusFilter(query.status)]

  const [rows, total, counts] = await Promise.all([
    db.users.findMany(and(...filters, userAfterCursor(cursor)), {
      orderBy: [desc(schema.users.createdAt), desc(schema.users.id)],
      limit: limit + 1,
    }),
    db.users.count(and(...filters)),
    countUsersByStatus(db, base),
  ])
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]
  const extras = await summarizeUsers(db, page)
  return c.json({
    data: page.map((row) => ({
      ...toUserResponse(row),
      ...(extras.get(row.id) ?? {
        primaryEmail: null,
        primaryPhone: null,
        signInMethods: [],
        organizations: [],
      }),
    })),
    next_cursor: hasMore && last ? encodeCursor(`${last.createdAt.getTime()}|${last.id}`) : null,
    has_more: hasMore,
    total,
    counts,
  })
})

function exportStream(
  db: ReturnType<typeof createTenantDb>,
  filters: readonly SQL[],
  format: 'ndjson' | 'csv',
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let cursor: string | null = null
      try {
        if (format === 'csv') controller.enqueue(encoder.encode(csvHeader()))
        while (true) {
          const after = cursor ? gt(schema.users.id, cursor) : undefined
          const rows = await db.users.findMany(and(...filters, after), {
            orderBy: schema.users.id,
            limit: EXPORT_BATCH_SIZE,
          })
          if (rows.length === 0) break
          const extras = format === 'csv' ? await summarizeUsers(db, rows) : null
          for (const user of rows) {
            const line = extras
              ? csvRow(user, extras.get(user.id))
              : `${JSON.stringify({
                  id: user.id,
                  username: user.username,
                  external_id: user.externalId,
                  first_name: user.firstName,
                  last_name: user.lastName,
                  display_name: user.displayName,
                  status: user.status,
                  public_metadata: user.publicMetadata,
                  locale: user.locale,
                  created_at: user.createdAt,
                })}\n`
            controller.enqueue(encoder.encode(line))
          }
          cursor = rows[rows.length - 1]?.id ?? null
          if (rows.length < EXPORT_BATCH_SIZE) break
        }
        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
  })
}

// GET /v1/users/export?format=ndjson|csv&<列表筛选>:按当前筛选流式导出,不含密码哈希与 private metadata。
app.get('/export', async (c) => {
  const auth = await requireApiKeyOrTopLevelOrgManager(c, 'users:read')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const { format = 'ndjson' } = validateQuery(exportQuerySchema, {
    ...(c.req.query('format') ? { format: c.req.query('format') } : {}),
  })
  const query = validateQuery(userListQuerySchema, readUserListQuery(c.req.query()))
  const filters = [...userFiltersWithoutStatus(query), statusFilter(query.status)]
  emitManagementAuditAsync(c, {
    action: 'user.exported',
    actorId: auditActorId(auth),
    orgId: c.get('tenant').tenantId,
    targetType: 'user_export',
    targetId: format,
    details: { filters: Object.keys(readUserListQuery(c.req.query())) },
  })
  const csv = format === 'csv'
  return new Response(exportStream(db, filters, format), {
    headers: {
      'content-type': csv ? 'text/csv; charset=utf-8' : 'application/x-ndjson',
      'content-disposition': `attachment; filename="users-export.${csv ? 'csv' : 'ndjson'}"`,
      'cache-control': 'no-store',
    },
  })
})

// POST /v1/users/bulk_metadata:批量更新 public_metadata
app.post('/bulk_metadata', async (c) => {
  const auth = await requireApiKeyOrTopLevelOrgManager(c, 'users:write')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(bulkMetadataBodySchema, json.value)

  const results = await Promise.all(
    body.updates.map(async (item) => {
      const rows = await db.users.update(
        { publicMetadata: item.public_metadata },
        and(eq(schema.users.id, item.user_id), notDeletedUser()),
      )
      return rows[0] ?? null
    }),
  )
  const updated = results.filter((row): row is UserRow => row !== null)
  for (const row of updated) auditUser(c, auth, { action: 'user.metadata_updated', userId: row.id })
  return c.json({ updated: updated.length })
})

// provisioned_by 是内部登记值;对外只给来源类别(目录同步、SSO JIT、自助注册、访客、管理员或 API 创建)。
function userSource(
  provisionedBy: string | null,
): 'directory_sync' | 'sso' | 'self_signup' | 'guest' | 'admin' {
  if (provisionedBy === 'scim') return 'directory_sync'
  if (provisionedBy === 'jit_sso') return 'sso'
  if (provisionedBy === 'anonymous') return 'guest'
  if (provisionedBy?.startsWith('hosted_')) return 'self_signup'
  return 'admin'
}

// GET /v1/users/:id?include_deleted=true
app.get('/:id', async (c) => {
  await requireApiKeyOrTopLevelOrgManager(c, 'users:read')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const id = c.req.param('id')
  const includeDeleted = c.req.query('include_deleted') === 'true'
  const user = await db.users.findOne(
    includeDeleted ? eq(schema.users.id, id) : and(eq(schema.users.id, id), notDeletedUser()),
  )
  if (!user) throw new AppError('not_found', { httpStatus: 404 })
  const [emails, phones] = await Promise.all([
    db.userEmails.findMany(eq(schema.userEmails.userId, id), {
      orderBy: schema.userEmails.createdAt,
      limit: 100,
    }),
    db.userPhones.findMany(eq(schema.userPhones.userId, id), {
      orderBy: schema.userPhones.createdAt,
      limit: 100,
    }),
  ])
  const primaryEmailId =
    user.primaryEmailId ?? emails.find((row) => row.isPrimary)?.id ?? emails[0]?.id ?? null
  const primaryPhoneId =
    user.primaryPhoneId ?? phones.find((row) => row.isPrimary)?.id ?? phones[0]?.id ?? null
  return c.json({
    ...toUserResponse(user),
    isGuest: user.provisionedBy === 'anonymous',
    source: userSource(user.provisionedBy),
    emails: emails.map((row) => ({
      id: row.id,
      email: row.email,
      verified: row.verified,
      isPrimary: row.id === primaryEmailId,
    })),
    phones: phones.map((row) => ({
      id: row.id,
      phone: row.phone,
      verified: row.verified,
      isPrimary: row.id === primaryPhoneId,
    })),
  })
})

async function assertIdentifiersAvailable(
  db: ReturnType<typeof createTenantDb>,
  input: { username?: string; externalId?: string; email?: string; phone?: string },
): Promise<void> {
  const [username, externalId, email, phone] = await Promise.all([
    input.username === undefined
      ? null
      : db.users.findOne(and(eq(schema.users.username, input.username), notDeletedUser())),
    input.externalId === undefined
      ? null
      : db.users.findOne(and(eq(schema.users.externalId, input.externalId), notDeletedUser())),
    input.email === undefined
      ? null
      : db.userEmails.findOne(eq(schema.userEmails.email, input.email)),
    input.phone === undefined
      ? null
      : db.userPhones.findOne(eq(schema.userPhones.phone, input.phone)),
  ])
  const conflict = username
    ? 'username'
    : externalId
      ? 'external_id'
      : email
        ? 'email'
        : phone
          ? 'phone'
          : null
  if (conflict)
    throw new AppError('already_exists', { httpStatus: 409, meta: { paramName: conflict } })
}

// drizzle 把 D1 的 UNIQUE 消息放在 cause 链上,表名可能只出现在内层。
function errorChainMentions(error: unknown, needle: string): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current.message.includes(needle)) return true
    current = current.cause
  }
  return false
}

function normalizeAdminPhone(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const phone = normalizePhoneNumber(raw)
  if (!phone)
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'phone' } })
  return phone
}

// POST /v1/users:可带主邮箱与手机号;租户内邮箱或手机号冲突 409(管理接口,不受枚举规则约束)。
app.post('/', async (c) => {
  const auth = await requireApiKeyOrTopLevelOrgManager(c, 'users:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createUserBodySchema, json.value)
  const email = body.email?.trim().toLowerCase()
  const phone = normalizeAdminPhone(body.phone)
  if (body.send_password_setup && !email) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'email' } })
  }
  await assertIdentifiersAvailable(db, {
    username: body.username,
    externalId: body.external_id,
    email,
    phone,
  })

  const id = createPersistedId('user')
  const emailId = email ? crypto.randomUUID() : null
  const phoneId = phone ? crypto.randomUUID() : null
  const user = await db.users.insert({
    id,
    tenantId: tenant.tenantId,
    username: body.username ?? null,
    externalId: body.external_id ?? null,
    primaryEmailId: emailId,
    primaryPhoneId: phoneId,
    firstName: body.first_name ?? null,
    lastName: body.last_name ?? null,
    displayName: body.display_name ?? null,
    publicMetadata: body.public_metadata ?? {},
    privateMetadata: body.private_metadata ?? {},
    unsafeMetadata: body.unsafe_metadata ?? {},
    status: 'active',
  })
  try {
    if (email && emailId) {
      await db.userEmails.insert({
        id: emailId,
        tenantId: tenant.tenantId,
        userId: id,
        email,
        verified: false,
        verificationStatus: 'unverified',
        isPrimary: true,
      })
    }
    if (phone && phoneId) {
      await db.userPhones.insert({
        id: phoneId,
        tenantId: tenant.tenantId,
        userId: id,
        phone,
        verified: false,
        verificationStatus: 'unverified',
        isPrimary: true,
      })
    }
  } catch (error) {
    // 回滚刚建的用户,避免留下无联系方式的孤儿;只有唯一索引冲突(并发写入同一联系方式)映射为 409。
    await db.userEmails.hardDelete(eq(schema.userEmails.userId, id))
    await db.userPhones.hardDelete(eq(schema.userPhones.userId, id))
    await db.users.hardDelete(eq(schema.users.id, id))
    if (!isUniqueConstraintError(error)) throw error
    throw new AppError('already_exists', {
      httpStatus: 409,
      meta: { paramName: errorChainMentions(error, 'user_phones') ? 'phone' : 'email' },
      cause: error,
    })
  }
  if (body.send_password_setup && email) {
    await sendPasswordResetEmail({
      env: c.env,
      tenant,
      db,
      userId: id,
      email,
      locale: resolveLocale({ userLocale: null }),
    })
  }
  emitWebhookAsync(c, { tenantId: tenant.tenantId, event: 'user.created', payload: { userId: id } })
  auditUser(c, auth, { action: 'user.created', userId: id })
  return c.json(toUserResponse(user), 201)
})

// PATCH /v1/users/:id
app.patch('/:id', async (c) => {
  const auth = await requireApiKeyOrTopLevelOrgManager(c, 'users:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const id = c.req.param('id')
  const existing = await db.users.findOne(and(eq(schema.users.id, id), notDeletedUser()))
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })

  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(patchUserBodySchema, json.value)
  await assertIdentifiersAvailable(db, {
    username:
      body.username !== undefined && body.username !== existing.username
        ? body.username
        : undefined,
    externalId:
      body.external_id !== undefined && body.external_id !== existing.externalId
        ? body.external_id
        : undefined,
  })

  const patch: Partial<typeof schema.users.$inferInsert> = {}
  if (body.first_name !== undefined) patch.firstName = body.first_name
  if (body.last_name !== undefined) patch.lastName = body.last_name
  if (body.display_name !== undefined) patch.displayName = body.display_name
  if (body.username !== undefined) patch.username = body.username
  if (body.external_id !== undefined) patch.externalId = body.external_id
  if (body.public_metadata !== undefined) patch.publicMetadata = body.public_metadata
  if (body.private_metadata !== undefined) patch.privateMetadata = body.private_metadata
  if (body.unsafe_metadata !== undefined) patch.unsafeMetadata = body.unsafe_metadata
  if (body.locale !== undefined) patch.locale = body.locale
  if (body.timezone !== undefined) patch.timezone = body.timezone

  const updated = await db.users.update(patch, eq(schema.users.id, id))
  const row = updated[0]
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  emitWebhookAsync(c, { tenantId: tenant.tenantId, event: 'user.updated', payload: { userId: id } })
  auditUser(c, auth, { action: 'user.updated', userId: id })
  return c.json(toUserResponse(row))
})

// DELETE /v1/users/:id:软删除并撤销全部会话;cookie 调用方需要 step-up,API key 调用不变。
app.delete('/:id', async (c) => {
  const auth = await requireApiKeyOrTopLevelOrgManager(c, 'users:write')
  const tenant = c.get('tenant')
  if (auth.kind === 'org_console') await requireStepUp(c, tenant, auth.session)
  const db = createTenantDb(c.env.DB, tenant)
  const id = c.req.param('id')
  const existing = await db.users.findOne(and(eq(schema.users.id, id), notDeletedUser()))
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  await assertUserActionAllowed(db, auth, id)

  await db.users.update({ deletedAt: new Date(), status: 'deleted' }, eq(schema.users.id, id))
  await revokeUserCredentials(c.env, tenant, id)
  emitWebhookAsync(c, { tenantId: tenant.tenantId, event: 'user.deleted', payload: { userId: id } })
  auditUser(c, auth, { action: 'user.deleted', userId: id })
  scheduleUserScimTargetSyncs(c, id)
  return new Response(null, { status: 204 })
})

// POST /v1/users/:id/restore
app.post('/:id/restore', async (c) => {
  const auth = await requireApiKeyOrTopLevelOrgManager(c, 'users:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const id = c.req.param('id')
  const existing = await db.users.findOne(eq(schema.users.id, id))
  if (!existing || (existing.status !== 'deleted' && existing.deletedAt === null)) {
    throw new AppError('not_found', { httpStatus: 404 })
  }
  await assertIdentifiersAvailable(db, {
    username: existing.username ?? undefined,
    externalId: existing.externalId ?? undefined,
  })
  const updated = await db.users.update(
    { deletedAt: null, status: 'active' },
    eq(schema.users.id, id),
  )
  const row = updated[0]
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'user.restored',
    payload: { userId: id },
  })
  auditUser(c, auth, { action: 'user.restored', userId: id })
  scheduleUserScimTargetSyncs(c, id)
  return c.json(toUserResponse(row))
})

// POST /v1/users/:id/ban | /unban:界面文案为 Suspend / Resume。
async function setBanned(c: Context<XidHonoEnv>, banned: boolean): Promise<Response> {
  const auth = await requireApiKeyOrTopLevelOrgManager(c, 'users:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const id = c.req.param('id') ?? ''
  const existing = await db.users.findOne(and(eq(schema.users.id, id), notDeletedUser()))
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  if ((existing.status === 'banned') === banned) return c.json(toUserResponse(existing))
  if (banned) await assertUserActionAllowed(db, auth, id)

  const updated = await db.users.update(
    { status: banned ? 'banned' : 'active' },
    eq(schema.users.id, id),
  )
  const row = updated[0]
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  const event = banned ? 'user.banned' : 'user.unbanned'
  emitWebhookAsync(c, { tenantId: tenant.tenantId, event, payload: { userId: id } })
  auditUser(c, auth, { action: event, userId: id })
  scheduleUserScimTargetSyncs(c, id)
  return c.json(toUserResponse(row))
}

app.post('/:id/ban', (c) => setBanned(c, true))
app.post('/:id/unban', (c) => setBanned(c, false))

export function registerUsersRoutes(honoApp: Hono<XidHonoEnv>): void {
  // /export 与 /bulk_metadata 在 /:id 之前注册,避免被详情路由截获。
  honoApp.route('/v1/users', app)
  registerUserDetailRoutes(honoApp)
}
