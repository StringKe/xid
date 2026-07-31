// Management API v1: permissions(原子能力 feature:action)
// CRUD。见 06 章 7、02 章 RBAC、08 章 13.2。
// 路由前缀:/v1/permissions

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import {
  authorizeProjectManagement,
  authorizeProjectRead,
  requireProjectAccessActor,
} from './project-access'
import { emitManagementAuditAsync, idAfterCursor, paginate, parsePagination } from './shared'

const app = new Hono<XidHonoEnv>()

// 形状校验只管字段类型/必填性;key 唯一性等业务校验留在 handler。
const createPermissionBodySchema = v.object({
  project_id: v.pipe(v.string(), v.minLength(1)),
  key: v.pipe(v.string(), v.minLength(1)),
  description: v.optional(v.string()),
})

const patchPermissionBodySchema = v.object({
  description: v.optional(v.string()),
})

function toResponse(row: typeof schema.permissions.$inferSelect) {
  return {
    id: row.id,
    project_id: row.projectId,
    key: row.key,
    description: row.description,
    status: row.status,
    deleted_at: row.deletedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

// GET /v1/permissions
app.get('/', async (c) => {
  const actor = await requireProjectAccessActor(c, 'permissions:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const { limit, cursor } = parsePagination(c)
  const projectId = c.req.query('project_id')
  const status = c.req.query('status') ?? 'active'
  if (!['active', 'deleted', 'all'].includes(status)) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'status' },
    })
  }
  if (actor.kind === 'session' && !projectId) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'project_id' },
    })
  }
  if (projectId) {
    await authorizeProjectRead(c, actor, projectId, c.req.query('grant_id'))
  }
  const after = idAfterCursor(schema.permissions.id, cursor)
  const filters = projectId ? [eq(schema.permissions.projectId, projectId)] : []
  if (status !== 'all') filters.push(eq(schema.permissions.status, status))
  if (after) filters.push(after)
  const rows = await db.permissions.findMany(and(...filters), {
    orderBy: asc(schema.permissions.id),
    limit: limit + 1,
  })
  return c.json(paginate(rows.map(toResponse), (r) => r.id, limit))
})

// POST /v1/permissions
app.post('/', async (c) => {
  const actor = await requireProjectAccessActor(c, 'permissions:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createPermissionBodySchema, json.value)

  const projectId = body.project_id
  await authorizeProjectManagement(c, actor, projectId)
  const key = body.key

  // key 在 project 内唯一。
  const existing = await db.permissions.findOne(
    and(eq(schema.permissions.projectId, projectId), eq(schema.permissions.key, key)),
  )
  if (existing && existing.status === 'deleted') {
    const updated = await db.permissions.update(
      {
        description: body.description,
        status: 'active',
        deletedAt: null,
      },
      eq(schema.permissions.id, existing.id),
    )
    const row = updated[0]!
    emitManagementAuditAsync(c, {
      action: 'management.permission.restored',
      actorId: actor.kind === 'session' ? actor.session.userId : actor.apiKeyId,
      targetType: 'permission',
      targetId: row.id,
    })
    return c.json(toResponse(row), 201)
  }
  if (existing)
    throw new AppError('already_exists', {
      longMessage: 'permission key already exists in project',
    })

  const row = await db.permissions.insert({
    id: createPersistedId('permission'),
    tenantId: tenant.tenantId,
    projectId,
    key,
    description: body.description,
  })

  emitManagementAuditAsync(c, {
    action: 'management.permission.created',
    actorId: actor.kind === 'session' ? actor.session.userId : actor.apiKeyId,
    targetType: 'permission',
    targetId: row.id,
  })
  return c.json(toResponse(row), 201)
})

// GET /v1/permissions/:id
app.get('/:id', async (c) => {
  const actor = await requireProjectAccessActor(c, 'permissions:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const row = await db.permissions.findOne(
    and(eq(schema.permissions.id, c.req.param('id')), eq(schema.permissions.status, 'active')),
  )
  if (!row) throw new AppError('not_found')
  await authorizeProjectRead(c, actor, row.projectId, c.req.query('grant_id'))
  return c.json(toResponse(row))
})

// PATCH /v1/permissions/:id
app.patch('/:id', async (c) => {
  const actor = await requireProjectAccessActor(c, 'permissions:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(patchPermissionBodySchema, json.value)
  if (Object.keys(body).length === 0) {
    throw new AppError('validation_failed', { httpStatus: 422 })
  }
  const where = and(
    eq(schema.permissions.id, c.req.param('id')),
    eq(schema.permissions.status, 'active'),
  )
  const existing = await db.permissions.findOne(where)
  if (!existing) throw new AppError('not_found')
  await authorizeProjectManagement(c, actor, existing.projectId)

  const patch: Partial<typeof schema.permissions.$inferInsert> = {}
  if (body.description !== undefined) patch.description = body.description

  const updated = await db.permissions.update(patch, where)
  const row = updated[0]
  if (!row) throw new AppError('not_found')
  emitManagementAuditAsync(c, {
    action: 'management.permission.updated',
    actorId: actor.kind === 'session' ? actor.session.userId : actor.apiKeyId,
    targetType: 'permission',
    targetId: row.id,
  })
  return c.json(toResponse(row))
})

// DELETE /v1/permissions/:id
app.delete('/:id', async (c) => {
  const actor = await requireProjectAccessActor(c, 'permissions:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const where = and(
    eq(schema.permissions.id, c.req.param('id')),
    eq(schema.permissions.status, 'active'),
  )
  const existing = await db.permissions.findOne(where)
  if (!existing) throw new AppError('not_found')
  await authorizeProjectManagement(c, actor, existing.projectId)
  await db.permissions.update({ status: 'deleted', deletedAt: new Date() }, where)
  emitManagementAuditAsync(c, {
    action: 'management.permission.deleted',
    actorId: actor.kind === 'session' ? actor.session.userId : actor.apiKeyId,
    targetType: 'permission',
    targetId: existing.id,
  })
  return new Response(null, { status: 204 })
})

// POST /v1/permissions/:id/restore
app.post('/:id/restore', async (c) => {
  const actor = await requireProjectAccessActor(c, 'permissions:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const where = and(
    eq(schema.permissions.id, c.req.param('id')),
    eq(schema.permissions.status, 'deleted'),
  )
  const existing = await db.permissions.findOne(where)
  if (!existing) throw new AppError('not_found')
  await authorizeProjectManagement(c, actor, existing.projectId)
  const updated = await db.permissions.update({ status: 'active', deletedAt: null }, where)
  const row = updated[0]
  if (!row) throw new AppError('not_found')
  emitManagementAuditAsync(c, {
    action: 'management.permission.restored',
    actorId: actor.kind === 'session' ? actor.session.userId : actor.apiKeyId,
    targetType: 'permission',
    targetId: row.id,
  })
  return c.json(toResponse(row))
})

export function registerPermissions(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/permissions', app)
}
