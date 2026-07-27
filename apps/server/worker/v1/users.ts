// Management API v1: /v1/users 身份资源。
// CRUD + list(cursor 分页) + ban/unban + search + bulk metadata PATCH + export 元数据。
// 认证:sk_live_/sk_test_ Bearer(requireApiKey)。
// 租户隔离:所有查询走 createTenantDb(P0),tenant_id 从 TenantContext 取。
// 见 api-sdk-conventions rule、tenant-isolation rule。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, gt, isNull, like, ne, or } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import { AppError } from '../lib/errors'
import { readJsonBody, validateBody, validateQuery } from '../lib/validate'
import { requireApiKey, parsePagination, paginate, idAfterCursor, emitWebhookAsync } from './shared'

const app = new Hono<XidHonoEnv>()
const EXPORT_BATCH_SIZE = 100

// 形状校验只管字段类型/必填性;唯一性等业务校验留在 handler(见 error-handling rule)。
const metadataSchema = v.record(v.string(), v.unknown())

const createUserBodySchema = v.object({
  username: v.optional(v.string()),
  external_id: v.optional(v.string()),
  first_name: v.optional(v.string()),
  last_name: v.optional(v.string()),
  display_name: v.optional(v.string()),
  public_metadata: v.optional(metadataSchema),
  private_metadata: v.optional(metadataSchema),
  unsafe_metadata: v.optional(metadataSchema),
})

const patchUserBodySchema = v.object({
  first_name: v.optional(v.string()),
  last_name: v.optional(v.string()),
  display_name: v.optional(v.string()),
  username: v.optional(v.string()),
  external_id: v.optional(v.string()),
  public_metadata: v.optional(metadataSchema),
  private_metadata: v.optional(metadataSchema),
  unsafe_metadata: v.optional(metadataSchema),
  locale: v.optional(v.string()),
  timezone: v.optional(v.string()),
})

const bulkMetadataBodySchema = v.object({
  updates: v.pipe(
    v.array(v.object({ user_id: v.string(), public_metadata: metadataSchema })),
    v.minLength(1),
    v.maxLength(100),
  ),
})

function notDeletedUser() {
  return and(ne(schema.users.status, 'deleted'), isNull(schema.users.deletedAt))
}

// 用户行转对外响应:白名单显式列出,剔除内部实现字段。
// 保留 status/lockoutUntil/lastLoginAt 等运维状态(sk 可见),剔除 failedLoginCount(内部计数)、
// provisionedBy/mergedIntoUserId(内部实现)、primaryEmailId/primaryPhoneId(内部 FK)、
// tenantId(隔离键)、isNewUser/profileCompletionStatus(内部 onboarding)、deletedAt(软删标记)。
// 字段名保持 camelCase:@xid-kit/core 的 ManagementUser wire 契约按 camelCase 读。
function toResponse(row: typeof schema.users.$inferSelect) {
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
    status: row.status,
    passwordChangeRequired: row.passwordChangeRequired,
    lockoutUntil: row.lockoutUntil,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

// ---- 列表 ----

// 列表 query:provisioned_by 过滤(如 ?provisioned_by=anonymous 只看 guest)。
// provisioned_by 是自由文本(登记值见 schema/users.ts),形状层只约束长度。
const listUsersQuerySchema = v.object({
  provisioned_by: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
})

// GET /v1/users?limit=&cursor=&search=&provisioned_by=
app.get('/', async (c) => {
  await requireApiKey(c, 'users:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const { limit, cursor } = parsePagination(c)
  const search = c.req.query('search') ?? null
  const query = validateQuery(listUsersQuerySchema, {
    provisioned_by: c.req.query('provisioned_by'),
  })

  const afterCond = idAfterCursor(schema.users.id, cursor)
  const notDeleted = notDeletedUser()
  const provisionedCond: SQL | undefined = query.provisioned_by
    ? eq(schema.users.provisionedBy, query.provisioned_by)
    : undefined
  const baseConds = [notDeleted, provisionedCond, afterCond].filter(
    (cond): cond is NonNullable<typeof cond> => cond != null,
  )

  let rows: (typeof schema.users.$inferSelect)[]

  if (search) {
    const pattern = `%${search}%`
    const searchCond = or(
      like(schema.users.username, pattern),
      like(schema.users.firstName, pattern),
      like(schema.users.lastName, pattern),
    )
    rows = await db.users.findMany(and(searchCond, ...baseConds), {
      orderBy: asc(schema.users.id),
      limit: limit + 1,
    })
  } else {
    rows = await db.users.findMany(and(...baseConds), {
      orderBy: asc(schema.users.id),
      limit: limit + 1,
    })
  }

  return c.json(paginate(rows.map(toResponse), (r) => r.id, limit))
})

// ---- export(元数据,不含密码哈希) ----

// GET /v1/users/export -- 返回 NDJSON 流
app.get('/export', async (c) => {
  await requireApiKey(c, 'users:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)

  // 仅导出非删除用户的公开字段(不含 privateMetadata/密码哈希)。
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let cursor: string | null = null
      try {
        while (true) {
          const after = cursor ? gt(schema.users.id, cursor) : undefined
          const rows = await db.users.findMany(
            after ? and(notDeletedUser(), after) : notDeletedUser(),
            { orderBy: asc(schema.users.id), limit: EXPORT_BATCH_SIZE },
          )
          if (rows.length === 0) break
          for (const user of rows) {
            controller.enqueue(
              encoder.encode(
                `${JSON.stringify({
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
                })}\n`,
              ),
            )
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
  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson',
      'content-disposition': 'attachment; filename="users-export.ndjson"',
    },
  })
})

// ---- 单个用户 ----

// GET /v1/users/:id
app.get('/:id', async (c) => {
  await requireApiKey(c, 'users:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const id = c.req.param('id')
  const user = await db.users.findOne(and(eq(schema.users.id, id), notDeletedUser()))
  if (!user) throw new AppError('not_found', { httpStatus: 404 })
  return c.json(toResponse(user))
})

// ---- 创建 ----

// POST /v1/users
app.post('/', async (c) => {
  await requireApiKey(c, 'users:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)

  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createUserBodySchema, json.value)

  if (body.username !== undefined) {
    const existing = await db.users.findOne(
      and(eq(schema.users.username, body.username), notDeletedUser()),
    )
    if (existing)
      throw new AppError('already_exists', { httpStatus: 409, meta: { paramName: 'username' } })
  }
  if (body.external_id !== undefined) {
    const existing = await db.users.findOne(
      and(eq(schema.users.externalId, body.external_id), notDeletedUser()),
    )
    if (existing)
      throw new AppError('already_exists', { httpStatus: 409, meta: { paramName: 'external_id' } })
  }

  const id = crypto.randomUUID()
  const user = await db.users.insert({
    id,
    tenantId: tenant.tenantId,
    username: body.username ?? null,
    externalId: body.external_id ?? null,
    firstName: body.first_name ?? null,
    lastName: body.last_name ?? null,
    displayName: body.display_name ?? null,
    publicMetadata: body.public_metadata ?? {},
    privateMetadata: body.private_metadata ?? {},
    unsafeMetadata: body.unsafe_metadata ?? {},
    status: 'active',
  })
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'user.created',
    payload: { userId: id },
  })
  return c.json(toResponse(user), 201)
})

// ---- 更新 ----

// PATCH /v1/users/:id  (metadata PATCH 限速:10/10s/user 见 api-sdk-conventions rule)
app.patch('/:id', async (c) => {
  await requireApiKey(c, 'users:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const id = c.req.param('id')

  const existing = await db.users.findOne(and(eq(schema.users.id, id), notDeletedUser()))
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })

  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(patchUserBodySchema, json.value)

  if (body.username !== undefined && body.username !== existing.username) {
    const dup = await db.users.findOne(
      and(eq(schema.users.username, body.username), notDeletedUser()),
    )
    if (dup)
      throw new AppError('already_exists', { httpStatus: 409, meta: { paramName: 'username' } })
  }
  if (body.external_id !== undefined && body.external_id !== existing.externalId) {
    const dup = await db.users.findOne(
      and(eq(schema.users.externalId, body.external_id), notDeletedUser()),
    )
    if (dup)
      throw new AppError('already_exists', { httpStatus: 409, meta: { paramName: 'external_id' } })
  }

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
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'user.updated',
    payload: { userId: id },
  })
  return c.json(toResponse(row))
})

// ---- 删除 ----

// DELETE /v1/users/:id
app.delete('/:id', async (c) => {
  await requireApiKey(c, 'users:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const id = c.req.param('id')

  const existing = await db.users.findOne(and(eq(schema.users.id, id), notDeletedUser()))
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })

  // 软删除:设 deleted_at + status=deleted。
  await db.users.update({ deletedAt: new Date(), status: 'deleted' }, eq(schema.users.id, id))
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'user.deleted',
    payload: { userId: id },
  })
  return new Response(null, { status: 204 })
})

// POST /v1/users/:id/restore
app.post('/:id/restore', async (c) => {
  await requireApiKey(c, 'users:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const id = c.req.param('id')

  const existing = await db.users.findOne(eq(schema.users.id, id))
  if (!existing || (existing.status !== 'deleted' && existing.deletedAt === null)) {
    throw new AppError('not_found', { httpStatus: 404 })
  }

  if (existing.username) {
    const dup = await db.users.findOne(
      and(eq(schema.users.username, existing.username), notDeletedUser()),
    )
    if (dup)
      throw new AppError('already_exists', { httpStatus: 409, meta: { paramName: 'username' } })
  }
  if (existing.externalId) {
    const dup = await db.users.findOne(
      and(eq(schema.users.externalId, existing.externalId), notDeletedUser()),
    )
    if (dup)
      throw new AppError('already_exists', {
        httpStatus: 409,
        meta: { paramName: 'external_id' },
      })
  }

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
  return c.json(toResponse(row))
})

// ---- ban / unban ----

// POST /v1/users/:id/ban
app.post('/:id/ban', async (c) => {
  await requireApiKey(c, 'users:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const id = c.req.param('id')

  const existing = await db.users.findOne(and(eq(schema.users.id, id), notDeletedUser()))
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  if (existing.status === 'banned') return c.json(toResponse(existing))

  const updated = await db.users.update({ status: 'banned' }, eq(schema.users.id, id))
  const row = updated[0]
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'user.banned',
    payload: { userId: id },
  })
  return c.json(toResponse(row))
})

// POST /v1/users/:id/unban
app.post('/:id/unban', async (c) => {
  await requireApiKey(c, 'users:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const id = c.req.param('id')

  const existing = await db.users.findOne(and(eq(schema.users.id, id), notDeletedUser()))
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  if (existing.status !== 'banned') return c.json(toResponse(existing))

  const updated = await db.users.update({ status: 'active' }, eq(schema.users.id, id))
  const row = updated[0]
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'user.unbanned',
    payload: { userId: id },
  })
  return c.json(toResponse(row))
})

// ---- bulk metadata PATCH ----

// POST /v1/users/bulk_metadata  -- 批量更新 public_metadata(限速:10/10s/user 在 api-sdk-conventions rule)
app.post('/bulk_metadata', async (c) => {
  await requireApiKey(c, 'users:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)

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
  return c.json({ updated: results.filter(Boolean).length })
})

export function registerUsersRoutes(honoApp: Hono<XidHonoEnv>): void {
  // export(/v1/users/export) 已在 /:id 前注册,避免被详情路由截获。
  honoApp.route('/v1/users', app)
}
