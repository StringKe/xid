// Management API v1: directories(SCIM 目录,per-org)
// CRUD + token rotate。见 06 章 7、04 章 10.2。领域操作在 scim/directory-admin.ts,
// 本路由保留 snake_case 响应契约与 sk_* 鉴权。
// 路由前缀:/v1/directories

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import {
  createDirectory,
  deleteDirectory,
  restoreDirectory,
  rotateDirectoryToken,
  scimBaseUrl,
} from '../scim/directory-admin'
import { idAfterCursor, requireApiKey, paginate, parsePagination, requireOrg } from './shared'

const app = new Hono<XidHonoEnv>()

// 形状校验只管字段类型/必填性;org 归属等业务校验留在 handler(requireOrg)。
const createDirectoryBodySchema = v.object({
  org_id: v.pipe(v.string(), v.minLength(1)),
  provider: v.optional(v.string()),
})

const patchDirectoryBodySchema = v.object({
  provider: v.optional(v.string()),
})

function toResponse(row: typeof schema.directories.$inferSelect, baseUrl: string) {
  return {
    id: row.id,
    org_id: row.orgId,
    provider: row.provider,
    sync_status: row.syncStatus,
    last_sync_at: row.lastSyncAt,
    scim_base_url: baseUrl,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

// GET /v1/directories
app.get('/', async (c) => {
  await requireApiKey(c, 'directories:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const { limit, cursor } = parsePagination(c)
  const orgId = c.req.query('org_id')
  const active = eq(schema.directories.status, 'active')
  const after = idAfterCursor(schema.directories.id, cursor)
  const filters = orgId ? [eq(schema.directories.orgId, orgId), active] : [active]
  if (after) filters.push(after)
  const rows = await db.directories.findMany(and(...filters), {
    orderBy: asc(schema.directories.id),
    limit: limit + 1,
  })
  const baseUrl = scimBaseUrl(tenant)
  return c.json(
    paginate(
      rows.map((row) => toResponse(row, baseUrl)),
      (r) => r.id,
      limit,
    ),
  )
})

// POST /v1/directories
app.post('/', async (c) => {
  await requireApiKey(c, 'directories:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createDirectoryBodySchema, json.value)

  // org_id 必须属于当前 TenantContext 的 tenant(requireOrg 走查询层注入 tenant_id;跨租户/不存在 -> 404)。
  await requireOrg(c, body.org_id)

  const { row, token } = await createDirectory(db, {
    tenantId: tenant.tenantId,
    orgId: body.org_id,
    provider: body.provider ?? 'generic',
  })
  return c.json({ ...toResponse(row, scimBaseUrl(tenant)), scim_token: token }, 201)
})

// GET /v1/directories/:id
app.get('/:id', async (c) => {
  await requireApiKey(c, 'directories:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const row = await db.directories.findOne(
    and(eq(schema.directories.id, c.req.param('id')), eq(schema.directories.status, 'active')),
  )
  if (!row) throw new AppError('not_found')
  return c.json(toResponse(row, scimBaseUrl(tenant)))
})

// PATCH /v1/directories/:id
app.patch('/:id', async (c) => {
  await requireApiKey(c, 'directories:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(patchDirectoryBodySchema, json.value)
  const where = and(
    eq(schema.directories.id, c.req.param('id')),
    eq(schema.directories.status, 'active'),
  )
  const existing = await db.directories.findOne(where)
  if (!existing) throw new AppError('not_found')

  const patch: Partial<typeof schema.directories.$inferInsert> = {}
  if (body.provider !== undefined) patch.provider = body.provider

  const updated = await db.directories.update(patch, where)
  const row = updated[0]
  if (!row) throw new AppError('not_found')
  return c.json(toResponse(row, scimBaseUrl(tenant)))
})

// DELETE /v1/directories/:id
app.delete('/:id', async (c) => {
  await requireApiKey(c, 'directories:write')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const deleted = await deleteDirectory(db, eq(schema.directories.id, c.req.param('id')))
  if (!deleted) throw new AppError('not_found')
  return new Response(null, { status: 204 })
})

// POST /v1/directories/:id/restore
app.post('/:id/restore', async (c) => {
  await requireApiKey(c, 'directories:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const restored = await restoreDirectory(db, eq(schema.directories.id, c.req.param('id')))
  if (!restored) throw new AppError('not_found')
  return c.json({ ...toResponse(restored.row, scimBaseUrl(tenant)), scim_token: restored.token })
})

// POST /v1/directories/:id/rotate-token - 轮换 SCIM bearer token
// 旧 token 进 scim_token_hash_prev(30min 宽限期,见 04 章 10.2)。
app.post('/:id/rotate-token', async (c) => {
  await requireApiKey(c, 'directories:write')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const rotated = await rotateDirectoryToken(db, eq(schema.directories.id, c.req.param('id')))
  if (!rotated) throw new AppError('not_found')
  return c.json({
    scim_token: rotated.token,
    scim_token_prev_expires_at: rotated.previousTokenExpiresAt.toISOString(),
  })
})

export function registerDirectories(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/directories', app)
}
