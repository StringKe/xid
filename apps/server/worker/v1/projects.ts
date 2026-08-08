// Management API v1: Project CRUD.
// Project is the business-RBAC namespace owned by one Organization. Deletion is reversible:
// dependent rows stay intact, while every runtime/management lookup requires project.status=active.

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import {
  authorizeOrganizationManagement,
  authorizeProjectRead,
  authorizeProjectRowManagement,
  requireProjectAccessActor,
} from './project-access'
import {
  emitManagementAuditAsync,
  idAfterCursor,
  paginate,
  parsePagination,
  requireOrg,
} from './shared'

const app = new Hono<XidHonoEnv>()

const createProjectBodySchema = v.object({
  org_id: v.pipe(v.string(), v.minLength(1)),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  description: v.optional(v.pipe(v.string(), v.maxLength(2000))),
})

const patchProjectBodySchema = v.object({
  name: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
  description: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(2000)))),
  // 访问策略三模式(设计 design-access-request.md 3.3):open / restricted / approval_required。
  access_policy: v.optional(v.picklist(['open', 'restricted', 'approval_required'])),
})

function toResponse(row: typeof schema.projects.$inferSelect) {
  return {
    id: row.id,
    org_id: row.orgId,
    name: row.name,
    description: row.description,
    status: row.status,
    access_policy: row.accessPolicy,
    deleted_at: row.deletedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

app.get('/', async (c) => {
  const actor = await requireProjectAccessActor(c, 'projects:read')
  const { limit, cursor } = parsePagination(c)
  const orgId = c.req.query('org_id')
  const projectId = c.req.query('project_id')
  const status = c.req.query('status') ?? 'active'
  if (!['active', 'deleted', 'all'].includes(status)) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'status' },
    })
  }
  if (actor.kind === 'session') {
    if (projectId) {
      if (status === 'active') {
        await authorizeProjectRead(c, actor, projectId, c.req.query('grant_id'))
      } else {
        const db = createTenantDb(c.env.DB, c.get('tenant'))
        const project = await db.projects.findOne(eq(schema.projects.id, projectId))
        if (!project) throw new AppError('not_found', { httpStatus: 404 })
        await authorizeProjectRowManagement(c, actor, project)
      }
    } else if (orgId) {
      await authorizeOrganizationManagement(c, actor, orgId)
    } else {
      throw new AppError('validation_failed', {
        httpStatus: 422,
        meta: { paramName: 'org_id' },
      })
    }
  }

  const filters = []
  if (status !== 'all') filters.push(eq(schema.projects.status, status))
  if (orgId) filters.push(eq(schema.projects.orgId, orgId))
  if (projectId) filters.push(eq(schema.projects.id, projectId))
  const after = idAfterCursor(schema.projects.id, cursor)
  if (after) filters.push(after)
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const rows = await db.projects.findMany(and(...filters), {
    orderBy: asc(schema.projects.id),
    limit: limit + 1,
  })
  return c.json(paginate(rows.map(toResponse), (row) => row.id, limit))
})

app.post('/', async (c) => {
  const actor = await requireProjectAccessActor(c, 'projects:write')
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createProjectBodySchema, json.value)
  await requireOrg(c, body.org_id)
  await authorizeOrganizationManagement(c, actor, body.org_id)

  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const row = await db.projects.insert({
    id: createPersistedId('project'),
    tenantId: tenant.tenantId,
    orgId: body.org_id,
    name: body.name,
    description: body.description,
    status: 'active',
  })
  emitManagementAuditAsync(c, {
    action: 'management.project.created',
    actorId: actor.kind === 'session' ? actor.session.userId : actor.apiKeyId,
    orgId: row.orgId,
    targetType: 'project',
    targetId: row.id,
  })
  return c.json(toResponse(row), 201)
})

app.get('/:id', async (c) => {
  const actor = await requireProjectAccessActor(c, 'projects:read')
  const project = await authorizeProjectRead(c, actor, c.req.param('id'))
  return c.json(toResponse(project))
})

app.patch('/:id', async (c) => {
  const actor = await requireProjectAccessActor(c, 'projects:write')
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(patchProjectBodySchema, json.value)
  if (Object.keys(body).length === 0) {
    throw new AppError('validation_failed', { httpStatus: 422 })
  }
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const where = and(eq(schema.projects.id, c.req.param('id')), eq(schema.projects.status, 'active'))
  const existing = await db.projects.findOne(where)
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  await authorizeProjectRowManagement(c, actor, existing)

  const patch: Partial<typeof schema.projects.$inferInsert> = {}
  if (body.name !== undefined) patch.name = body.name
  if (body.description !== undefined) patch.description = body.description
  if (body.access_policy !== undefined) patch.accessPolicy = body.access_policy
  const updated = await db.projects.update(patch, where)
  const row = updated[0]
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  emitManagementAuditAsync(c, {
    action: 'management.project.updated',
    actorId: actor.kind === 'session' ? actor.session.userId : actor.apiKeyId,
    orgId: row.orgId,
    targetType: 'project',
    targetId: row.id,
  })
  // access_policy 实际翻转时补一条专用事件(设计 3.4:payload 含 old/new,actor 即 actorId);
  // 同值重写不发,避免噪声。
  if (body.access_policy !== undefined && body.access_policy !== existing.accessPolicy) {
    emitManagementAuditAsync(c, {
      action: 'project.access_policy_changed',
      actorId: actor.kind === 'session' ? actor.session.userId : actor.apiKeyId,
      orgId: row.orgId,
      targetType: 'project',
      targetId: row.id,
      details: {
        oldAccessPolicy: existing.accessPolicy,
        newAccessPolicy: body.access_policy,
      },
    })
  }
  return c.json(toResponse(row))
})

app.delete('/:id', async (c) => {
  const actor = await requireProjectAccessActor(c, 'projects:write')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const where = and(eq(schema.projects.id, c.req.param('id')), eq(schema.projects.status, 'active'))
  const existing = await db.projects.findOne(where)
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  await authorizeProjectRowManagement(c, actor, existing)
  await db.projects.update({ status: 'deleted', deletedAt: new Date() }, where)
  emitManagementAuditAsync(c, {
    action: 'management.project.deleted',
    actorId: actor.kind === 'session' ? actor.session.userId : actor.apiKeyId,
    orgId: existing.orgId,
    targetType: 'project',
    targetId: existing.id,
  })
  return new Response(null, { status: 204 })
})

app.post('/:id/restore', async (c) => {
  const actor = await requireProjectAccessActor(c, 'projects:write')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const where = and(
    eq(schema.projects.id, c.req.param('id')),
    eq(schema.projects.status, 'deleted'),
  )
  const existing = await db.projects.findOne(where)
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  await requireOrg(c, existing.orgId)
  await authorizeProjectRowManagement(c, actor, existing)
  const updated = await db.projects.update({ status: 'active', deletedAt: null }, where)
  const row = updated[0]
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  emitManagementAuditAsync(c, {
    action: 'management.project.restored',
    actorId: actor.kind === 'session' ? actor.session.userId : actor.apiKeyId,
    orgId: row.orgId,
    targetType: 'project',
    targetId: row.id,
  })
  return c.json(toResponse(row))
})

export function registerProjects(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/projects', app)
}
