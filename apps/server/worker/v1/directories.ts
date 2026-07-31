// Management API v1: directories(SCIM 目录,per-org)
// CRUD + token rotate。见 06 章 7、04 章 9。
// Bearer token 哈希存储(SHA-256 存 scim_token_hash)。
// 路由前缀:/v1/directories

import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
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

// 生成 SCIM bearer token(32 字节随机,base64url)。
function genScimToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function toResponse(row: typeof schema.directories.$inferSelect) {
  return {
    id: row.id,
    org_id: row.orgId,
    provider: row.provider,
    sync_status: row.syncStatus,
    last_sync_at: row.lastSyncAt,
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
  return c.json(paginate(rows.map(toResponse), (r) => r.id, limit))
})

// POST /v1/directories
app.post('/', async (c) => {
  await requireApiKey(c, 'directories:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createDirectoryBodySchema, json.value)

  const orgId = body.org_id

  // org_id 必须属于当前 TenantContext 的 tenant(requireOrg 走查询层注入 tenant_id;跨租户/不存在 -> 404)。
  await requireOrg(c, orgId)

  const token = genScimToken()
  const tokenHash = await sha256Hex(token)

  const row = await db.directories.insert({
    id: createPersistedId('directory'),
    tenantId: tenant.tenantId,
    orgId,
    provider: body.provider ?? 'generic',
    scimTokenHash: tokenHash,
  })

  return c.json({ ...toResponse(row), scim_token: token }, 201)
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
  return c.json(toResponse(row))
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
  return c.json(toResponse(row))
})

// DELETE /v1/directories/:id
app.delete('/:id', async (c) => {
  await requireApiKey(c, 'directories:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const where = and(
    eq(schema.directories.id, c.req.param('id')),
    eq(schema.directories.status, 'active'),
  )
  const existing = await db.directories.findOne(where)
  if (!existing) throw new AppError('not_found')
  await db.directories.update(
    {
      status: 'deleted',
      syncStatus: 'disabled',
      scimTokenHashPrev: null,
      scimTokenPrevExpires: null,
      deletedAt: new Date(),
    },
    where,
  )
  return new Response(null, { status: 204 })
})

// POST /v1/directories/:id/restore
app.post('/:id/restore', async (c) => {
  await requireApiKey(c, 'directories:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const where = and(
    eq(schema.directories.id, c.req.param('id')),
    eq(schema.directories.status, 'deleted'),
  )
  const existing = await db.directories.findOne(where)
  if (!existing) throw new AppError('not_found')

  const token = genScimToken()
  const tokenHash = await sha256Hex(token)
  const updated = await db.directories.update(
    {
      status: 'active',
      syncStatus: 'idle',
      scimTokenHash: tokenHash,
      scimTokenHashPrev: null,
      scimTokenPrevExpires: null,
      deletedAt: null,
    },
    where,
  )
  const row = updated[0]
  if (!row) throw new AppError('not_found')
  return c.json({ ...toResponse(row), scim_token: token })
})

// POST /v1/directories/:id/rotate-token - 轮换 SCIM bearer token
// 旧 token 进 scim_token_hash_prev(30min 宽限期,见 04 章 9.2)。
app.post('/:id/rotate-token', async (c) => {
  await requireApiKey(c, 'directories:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const where = and(
    eq(schema.directories.id, c.req.param('id')),
    eq(schema.directories.status, 'active'),
  )
  const existing = await db.directories.findOne(where)
  if (!existing) throw new AppError('not_found')

  const newToken = genScimToken()
  const newHash = await sha256Hex(newToken)
  const prevExpires = new Date(Date.now() + 30 * 60 * 1000)

  await db.directories.update(
    {
      scimTokenHashPrev: existing.scimTokenHash,
      scimTokenPrevExpires: prevExpires,
      scimTokenHash: newHash,
    },
    where,
  )

  return c.json({ scim_token: newToken })
})

export function registerDirectories(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/directories', app)
}
