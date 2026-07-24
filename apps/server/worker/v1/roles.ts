// Management API v1: roles(Project 级角色)
// CRUD。见 06 章 7、02 章 RBAC、08 章 13.1。
// 路由前缀:/v1/roles

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import { idAfterCursor, requireApiKey, paginate, parsePagination } from './shared'

const app = new Hono<XidHonoEnv>()

// 形状校验只管字段类型/必填性;key 唯一性等业务校验留在 handler。
const createRoleBodySchema = v.object({
  project_id: v.pipe(v.string(), v.minLength(1)),
  key: v.pipe(v.string(), v.minLength(1)),
  display_name: v.pipe(v.string(), v.minLength(1)),
  group: v.optional(v.string()),
})

const patchRoleBodySchema = v.object({
  display_name: v.optional(v.string()),
  group: v.optional(v.string()),
})

function toResponse(row: typeof schema.roles.$inferSelect) {
  return {
    id: row.id,
    project_id: row.projectId,
    key: row.key,
    display_name: row.displayName,
    group: row.group,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

// GET /v1/roles
app.get('/', async (c) => {
  await requireApiKey(c, 'roles:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const { limit, cursor } = parsePagination(c)
  const projectId = c.req.query('project_id')
  const active = eq(schema.roles.status, 'active')
  const after = idAfterCursor(schema.roles.id, cursor)
  const filters = projectId ? [eq(schema.roles.projectId, projectId), active] : [active]
  if (after) filters.push(after)
  const rows = await db.roles.findMany(and(...filters), {
    orderBy: asc(schema.roles.id),
    limit: limit + 1,
  })
  return c.json(paginate(rows.map(toResponse), (r) => r.id, limit))
})

// POST /v1/roles
app.post('/', async (c) => {
  await requireApiKey(c, 'roles:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createRoleBodySchema, json.value)

  const projectId = body.project_id
  const key = body.key
  const displayName = body.display_name

  // key 在 project 内唯一(唯一约束 roles_tenant_project_key_unq)。
  const existing = await db.roles.findOne(
    and(eq(schema.roles.projectId, projectId), eq(schema.roles.key, key)),
  )
  if (existing && existing.status === 'deleted') {
    const updated = await db.roles.update(
      {
        displayName,
        group: body.group,
        status: 'active',
        deletedAt: null,
      },
      eq(schema.roles.id, existing.id),
    )
    return c.json(toResponse(updated[0]!), 201)
  }
  if (existing)
    throw new AppError('already_exists', { longMessage: 'role key already exists in project' })

  const row = await db.roles.insert({
    id: crypto.randomUUID(),
    tenantId: tenant.tenantId,
    projectId,
    key,
    displayName,
    group: body.group,
  })

  return c.json(toResponse(row), 201)
})

// GET /v1/roles/:id
app.get('/:id', async (c) => {
  await requireApiKey(c, 'roles:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const row = await db.roles.findOne(
    and(eq(schema.roles.id, c.req.param('id')), eq(schema.roles.status, 'active')),
  )
  if (!row) throw new AppError('not_found')
  return c.json(toResponse(row))
})

// PATCH /v1/roles/:id
app.patch('/:id', async (c) => {
  await requireApiKey(c, 'roles:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(patchRoleBodySchema, json.value)
  const where = and(eq(schema.roles.id, c.req.param('id')), eq(schema.roles.status, 'active'))
  const existing = await db.roles.findOne(where)
  if (!existing) throw new AppError('not_found')

  const patch: Partial<typeof schema.roles.$inferInsert> = {}
  if (body.display_name !== undefined) patch.displayName = body.display_name
  if (body.group !== undefined) patch.group = body.group

  const updated = await db.roles.update(patch, where)
  const row = updated[0]
  if (!row) throw new AppError('not_found')
  return c.json(toResponse(row))
})

// DELETE /v1/roles/:id
app.delete('/:id', async (c) => {
  await requireApiKey(c, 'roles:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const where = and(eq(schema.roles.id, c.req.param('id')), eq(schema.roles.status, 'active'))
  const existing = await db.roles.findOne(where)
  if (!existing) throw new AppError('not_found')
  await db.roles.update({ status: 'deleted', deletedAt: new Date() }, where)
  return new Response(null, { status: 204 })
})

// POST /v1/roles/:id/restore
app.post('/:id/restore', async (c) => {
  await requireApiKey(c, 'roles:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const where = and(eq(schema.roles.id, c.req.param('id')), eq(schema.roles.status, 'deleted'))
  const existing = await db.roles.findOne(where)
  if (!existing) throw new AppError('not_found')
  const updated = await db.roles.update({ status: 'active', deletedAt: null }, where)
  const row = updated[0]
  if (!row) throw new AppError('not_found')
  return c.json(toResponse(row))
})

export function registerRoles(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/roles', app)
}
