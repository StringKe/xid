// Management API v1: roles(Project 级角色)
// CRUD。见 06 章 7、02 章 RBAC、08 章 13.1。
// 路由前缀:/v1/roles

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
    status: row.status,
    deleted_at: row.deletedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

// GET /v1/roles
app.get('/', async (c) => {
  const actor = await requireProjectAccessActor(c, 'roles:read')
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
  const after = idAfterCursor(schema.roles.id, cursor)
  const filters = projectId ? [eq(schema.roles.projectId, projectId)] : []
  if (status !== 'all') filters.push(eq(schema.roles.status, status))
  if (after) filters.push(after)
  const rows = await db.roles.findMany(and(...filters), {
    orderBy: asc(schema.roles.id),
    limit: limit + 1,
  })
  return c.json(paginate(rows.map(toResponse), (r) => r.id, limit))
})

// POST /v1/roles
app.post('/', async (c) => {
  const actor = await requireProjectAccessActor(c, 'roles:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createRoleBodySchema, json.value)

  const projectId = body.project_id
  await authorizeProjectManagement(c, actor, projectId)
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
    const row = updated[0]!
    emitManagementAuditAsync(c, {
      action: 'management.role.restored',
      actorId: actor.kind === 'session' ? actor.session.userId : actor.apiKeyId,
      targetType: 'role',
      targetId: row.id,
    })
    return c.json(toResponse(row), 201)
  }
  if (existing)
    throw new AppError('already_exists', { longMessage: 'role key already exists in project' })

  const row = await db.roles.insert({
    id: createPersistedId('role'),
    tenantId: tenant.tenantId,
    projectId,
    key,
    displayName,
    group: body.group,
  })

  emitManagementAuditAsync(c, {
    action: 'management.role.created',
    actorId: actor.kind === 'session' ? actor.session.userId : actor.apiKeyId,
    targetType: 'role',
    targetId: row.id,
  })
  return c.json(toResponse(row), 201)
})

// GET /v1/roles/:id
app.get('/:id', async (c) => {
  const actor = await requireProjectAccessActor(c, 'roles:read')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const row = await db.roles.findOne(
    and(eq(schema.roles.id, c.req.param('id')), eq(schema.roles.status, 'active')),
  )
  if (!row) throw new AppError('not_found')
  await authorizeProjectRead(c, actor, row.projectId, c.req.query('grant_id'))
  return c.json(toResponse(row))
})

// PATCH /v1/roles/:id
app.patch('/:id', async (c) => {
  const actor = await requireProjectAccessActor(c, 'roles:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(patchRoleBodySchema, json.value)
  if (Object.keys(body).length === 0) {
    throw new AppError('validation_failed', { httpStatus: 422 })
  }
  const where = and(eq(schema.roles.id, c.req.param('id')), eq(schema.roles.status, 'active'))
  const existing = await db.roles.findOne(where)
  if (!existing) throw new AppError('not_found')
  await authorizeProjectManagement(c, actor, existing.projectId)

  const patch: Partial<typeof schema.roles.$inferInsert> = {}
  if (body.display_name !== undefined) patch.displayName = body.display_name
  if (body.group !== undefined) patch.group = body.group

  const updated = await db.roles.update(patch, where)
  const row = updated[0]
  if (!row) throw new AppError('not_found')
  emitManagementAuditAsync(c, {
    action: 'management.role.updated',
    actorId: actor.kind === 'session' ? actor.session.userId : actor.apiKeyId,
    targetType: 'role',
    targetId: row.id,
  })
  return c.json(toResponse(row))
})

// DELETE /v1/roles/:id
app.delete('/:id', async (c) => {
  const actor = await requireProjectAccessActor(c, 'roles:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const where = and(eq(schema.roles.id, c.req.param('id')), eq(schema.roles.status, 'active'))
  const existing = await db.roles.findOne(where)
  if (!existing) throw new AppError('not_found')
  await authorizeProjectManagement(c, actor, existing.projectId)
  await db.roles.update({ status: 'deleted', deletedAt: new Date() }, where)
  emitManagementAuditAsync(c, {
    action: 'management.role.deleted',
    actorId: actor.kind === 'session' ? actor.session.userId : actor.apiKeyId,
    targetType: 'role',
    targetId: existing.id,
  })
  return new Response(null, { status: 204 })
})

// POST /v1/roles/:id/restore
app.post('/:id/restore', async (c) => {
  const actor = await requireProjectAccessActor(c, 'roles:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const where = and(eq(schema.roles.id, c.req.param('id')), eq(schema.roles.status, 'deleted'))
  const existing = await db.roles.findOne(where)
  if (!existing) throw new AppError('not_found')
  await authorizeProjectManagement(c, actor, existing.projectId)
  const updated = await db.roles.update({ status: 'active', deletedAt: null }, where)
  const row = updated[0]
  if (!row) throw new AppError('not_found')
  emitManagementAuditAsync(c, {
    action: 'management.role.restored',
    actorId: actor.kind === 'session' ? actor.session.userId : actor.apiKeyId,
    targetType: 'role',
    targetId: row.id,
  })
  return c.json(toResponse(row))
})

export function registerRoles(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/roles', app)
}
