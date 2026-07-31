// Management API v1: project grants(跨组织授权)
// list/get/create/revoke。撤销不物理删除,同时级联标记对应 user_grants.revoked_at。
// 路由前缀:/v1/project-grants

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import {
  authorizeOrganizationManagement,
  authorizeProjectGrantRead,
  authorizeProjectManagement,
  requireProjectAccessActor,
} from './project-access'
import { idAfterCursor, paginate, parsePagination, requireOrg } from './shared'

const app = new Hono<XidHonoEnv>()

// 形状校验只管字段类型/必填性;org 归属、自授权等业务校验留在 handler。
const createProjectGrantBodySchema = v.object({
  granted_project_id: v.pipe(v.string(), v.minLength(1)),
  granted_by_org_id: v.pipe(v.string(), v.minLength(1)),
  granted_to_org_id: v.pipe(v.string(), v.minLength(1)),
})

function toResponse(row: typeof schema.projectGrants.$inferSelect) {
  return {
    id: row.id,
    granted_project_id: row.grantedProjectId,
    granted_by_org_id: row.grantedByOrgId,
    granted_to_org_id: row.grantedToOrgId,
    status: row.status,
    revoked_at: row.revokedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

async function requireProjectBelongsToOrg(
  c: Context<XidHonoEnv>,
  projectId: string,
  orgId: string,
): Promise<void> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const project = await db.projects.findOne(
    and(
      eq(schema.projects.id, projectId),
      eq(schema.projects.orgId, orgId),
      eq(schema.projects.status, 'active'),
    ),
  )
  if (!project) throw new AppError('not_found', { httpStatus: 404 })
}

async function revokeUserGrantsForProjectGrant(
  c: Context<XidHonoEnv>,
  grantId: string,
  now: Date,
): Promise<void> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  await db.userGrants.update(
    { revokedAt: now },
    and(eq(schema.userGrants.grantedViaGrantId, grantId), isNull(schema.userGrants.revokedAt)),
  )
}

// GET /v1/project-grants?limit=&cursor=&granted_project_id=&granted_to_org_id=
app.get('/', async (c) => {
  const actor = await requireProjectAccessActor(c, 'project_grants:read')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const { limit, cursor } = parsePagination(c)
  const filters = [eq(schema.projectGrants.status, 'active')]
  const afterCond = idAfterCursor(schema.projectGrants.id, cursor)
  if (afterCond) filters.push(afterCond)
  const projectId = c.req.query('granted_project_id')
  if (projectId) filters.push(eq(schema.projectGrants.grantedProjectId, projectId))
  const toOrgId = c.req.query('granted_to_org_id')
  if (toOrgId) filters.push(eq(schema.projectGrants.grantedToOrgId, toOrgId))
  if (actor.kind === 'session') {
    if (projectId) {
      await authorizeProjectManagement(c, actor, projectId)
    } else if (toOrgId) {
      await authorizeOrganizationManagement(c, actor, toOrgId)
    } else {
      throw new AppError('validation_failed', {
        httpStatus: 422,
        meta: { paramName: 'granted_project_id' },
      })
    }
  }
  const rows = await db.projectGrants.findMany(and(...filters), {
    orderBy: asc(schema.projectGrants.id),
    limit: limit + 1,
  })
  return c.json(paginate(rows.map(toResponse), (r) => r.id, limit))
})

// POST /v1/project-grants
app.post('/', async (c) => {
  const actor = await requireProjectAccessActor(c, 'project_grants:write')
  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createProjectGrantBodySchema, json.value)

  const projectId = body.granted_project_id
  const byOrgId = body.granted_by_org_id
  const toOrgId = body.granted_to_org_id
  if (byOrgId === toOrgId) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      longMessage: 'granted_to_org_id must differ from granted_by_org_id.',
    })
  }

  await requireOrg(c, byOrgId)
  await requireOrg(c, toOrgId)
  await authorizeProjectManagement(c, actor, projectId)
  await requireProjectBelongsToOrg(c, projectId, byOrgId)

  const existing = await db.projectGrants.findOne(
    and(
      eq(schema.projectGrants.grantedProjectId, projectId),
      eq(schema.projectGrants.grantedToOrgId, toOrgId),
    ),
  )
  if (existing && existing.status === 'revoked') {
    const updated = await db.projectGrants.update(
      { status: 'active', revokedAt: null },
      eq(schema.projectGrants.id, existing.id),
    )
    return c.json(toResponse(updated[0]!), 201)
  }
  if (existing) {
    throw new AppError('already_exists', {
      httpStatus: 409,
      longMessage: 'project grant already exists.',
    })
  }

  const row = await db.projectGrants.insert({
    id: createPersistedId('projectGrant'),
    tenantId: tenant.tenantId,
    grantedProjectId: projectId,
    grantedByOrgId: byOrgId,
    grantedToOrgId: toOrgId,
    status: 'active',
  })
  return c.json(toResponse(row), 201)
})

// GET /v1/project-grants/:id
app.get('/:id', async (c) => {
  const actor = await requireProjectAccessActor(c, 'project_grants:read')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const row = await db.projectGrants.findOne(
    and(eq(schema.projectGrants.id, c.req.param('id')), eq(schema.projectGrants.status, 'active')),
  )
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  await authorizeProjectGrantRead(c, actor, row)
  return c.json(toResponse(row))
})

// POST /v1/project-grants/:id/revoke
app.post('/:id/revoke', async (c) => {
  const actor = await requireProjectAccessActor(c, 'project_grants:write')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const where = and(
    eq(schema.projectGrants.id, c.req.param('id')),
    eq(schema.projectGrants.status, 'active'),
  )
  const existing = await db.projectGrants.findOne(where)
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  await authorizeProjectManagement(c, actor, existing.grantedProjectId)

  const now = new Date()
  const updated = await db.projectGrants.update({ status: 'revoked', revokedAt: now }, where)
  await revokeUserGrantsForProjectGrant(c, existing.id, now)
  return c.json(toResponse(updated[0]!))
})

// DELETE /v1/project-grants/:id
app.delete('/:id', async (c) => {
  const actor = await requireProjectAccessActor(c, 'project_grants:write')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const where = and(
    eq(schema.projectGrants.id, c.req.param('id')),
    eq(schema.projectGrants.status, 'active'),
  )
  const existing = await db.projectGrants.findOne(where)
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  await authorizeProjectManagement(c, actor, existing.grantedProjectId)

  const now = new Date()
  await db.projectGrants.update({ status: 'revoked', revokedAt: now }, where)
  await revokeUserGrantsForProjectGrant(c, existing.id, now)
  return new Response(null, { status: 204 })
})

export function registerProjectGrants(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/project-grants', app)
}
