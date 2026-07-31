// Management API v1:UserGrant 管理。
// Project Manager 管理本 Project;Project Grant Manager 与被授权 Organization Admin
// 只能管理精确 ProjectGrant 下、目标 Organization 成员的授予。

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
  authorizeProjectGrantAssignment,
  authorizeProjectManagement,
  requireProjectAccessActor,
  type ProjectAccessActor,
} from './project-access'
import { idAfterCursor, paginate, parsePagination } from './shared'

const app = new Hono<XidHonoEnv>()

const createUserGrantBodySchema = v.object({
  user_id: v.pipe(v.string(), v.minLength(1)),
  project_id: v.pipe(v.string(), v.minLength(1)),
  role_id: v.pipe(v.string(), v.minLength(1)),
  granted_via_grant_id: v.optional(v.pipe(v.string(), v.minLength(1))),
})

function toResponse(row: typeof schema.userGrants.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    project_id: row.projectId,
    role_id: row.roleId,
    granted_via_grant_id: row.grantedViaGrantId,
    revoked_at: row.revokedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

async function requireActiveProjectGrant(
  c: Context<XidHonoEnv>,
  projectId: string,
  grantId: string,
): Promise<typeof schema.projectGrants.$inferSelect> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const grant = await db.projectGrants.findOne(
    and(
      eq(schema.projectGrants.id, grantId),
      eq(schema.projectGrants.grantedProjectId, projectId),
      eq(schema.projectGrants.status, 'active'),
    ),
  )
  if (!grant) throw new AppError('not_found', { httpStatus: 404 })
  return grant
}

async function authorizeUserGrantScope(
  c: Context<XidHonoEnv>,
  actor: ProjectAccessActor,
  projectId: string,
  grantId?: string | null,
): Promise<{ targetOrgId: string }> {
  if (grantId) {
    const grant = await requireActiveProjectGrant(c, projectId, grantId)
    await authorizeProjectGrantAssignment(c, actor, grant)
    return { targetOrgId: grant.grantedToOrgId }
  }
  const project = await authorizeProjectManagement(c, actor, projectId)
  return { targetOrgId: project.orgId }
}

async function validateUserGrantTargets(
  c: Context<XidHonoEnv>,
  input: {
    userId: string
    projectId: string
    roleId: string
    targetOrgId: string
  },
): Promise<void> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const [user, role, membership] = await Promise.all([
    db.users.findOne(
      and(
        eq(schema.users.id, input.userId),
        eq(schema.users.status, 'active'),
        isNull(schema.users.deletedAt),
      ),
    ),
    db.roles.findOne(
      and(
        eq(schema.roles.id, input.roleId),
        eq(schema.roles.projectId, input.projectId),
        eq(schema.roles.status, 'active'),
      ),
    ),
    db.memberships.findOne(
      and(
        eq(schema.memberships.userId, input.userId),
        eq(schema.memberships.orgId, input.targetOrgId),
        eq(schema.memberships.status, 'active'),
      ),
    ),
  ])
  if (!user || !role || !membership) throw new AppError('not_found', { httpStatus: 404 })
}

app.get('/', async (c) => {
  const actor = await requireProjectAccessActor(c, 'user_grants:read')
  const { limit, cursor } = parsePagination(c)
  const projectId = c.req.query('project_id')
  const grantId = c.req.query('granted_via_grant_id')
  if (actor.kind === 'session' && !projectId) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'project_id' },
    })
  }
  if (projectId) await authorizeUserGrantScope(c, actor, projectId, grantId)

  const filters = [isNull(schema.userGrants.revokedAt)]
  const after = idAfterCursor(schema.userGrants.id, cursor)
  if (after) filters.push(after)
  if (projectId) filters.push(eq(schema.userGrants.projectId, projectId))
  if (grantId) filters.push(eq(schema.userGrants.grantedViaGrantId, grantId))
  const userId = c.req.query('user_id')
  if (userId) filters.push(eq(schema.userGrants.userId, userId))

  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const rows = await db.userGrants.findMany(and(...filters), {
    orderBy: asc(schema.userGrants.id),
    limit: limit + 1,
  })
  return c.json(paginate(rows.map(toResponse), (row) => row.id, limit))
})

app.post('/', async (c) => {
  const actor = await requireProjectAccessActor(c, 'user_grants:write')
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createUserGrantBodySchema, json.value)
  const grantId = body.granted_via_grant_id
  const { targetOrgId } = await authorizeUserGrantScope(c, actor, body.project_id, grantId)
  await validateUserGrantTargets(c, {
    userId: body.user_id,
    projectId: body.project_id,
    roleId: body.role_id,
    targetOrgId,
  })

  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const grantFilter = grantId
    ? eq(schema.userGrants.grantedViaGrantId, grantId)
    : isNull(schema.userGrants.grantedViaGrantId)
  const existing = await db.userGrants.findOne(
    and(
      eq(schema.userGrants.userId, body.user_id),
      eq(schema.userGrants.projectId, body.project_id),
      eq(schema.userGrants.roleId, body.role_id),
      grantFilter,
    ),
  )
  if (existing?.revokedAt) {
    const updated = await db.userGrants.update(
      { revokedAt: null },
      eq(schema.userGrants.id, existing.id),
    )
    return c.json(toResponse(updated[0]!), 201)
  }
  if (existing) throw new AppError('already_exists', { httpStatus: 409 })

  const row = await db.userGrants.insert({
    id: createPersistedId('userGrant'),
    tenantId: c.get('tenant').tenantId,
    userId: body.user_id,
    projectId: body.project_id,
    roleId: body.role_id,
    grantedViaGrantId: grantId,
  })
  return c.json(toResponse(row), 201)
})

async function readActiveUserGrant(
  c: Context<XidHonoEnv>,
): Promise<typeof schema.userGrants.$inferSelect> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const id = c.req.param('id')
  if (!id) throw new AppError('not_found', { httpStatus: 404 })
  const row = await db.userGrants.findOne(
    and(eq(schema.userGrants.id, id), isNull(schema.userGrants.revokedAt)),
  )
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  return row
}

app.get('/:id', async (c) => {
  const actor = await requireProjectAccessActor(c, 'user_grants:read')
  const row = await readActiveUserGrant(c)
  await authorizeUserGrantScope(c, actor, row.projectId, row.grantedViaGrantId)
  return c.json(toResponse(row))
})

async function revokeUserGrant(
  c: Context<XidHonoEnv>,
): Promise<typeof schema.userGrants.$inferSelect> {
  const actor = await requireProjectAccessActor(c, 'user_grants:write')
  const row = await readActiveUserGrant(c)
  await authorizeUserGrantScope(c, actor, row.projectId, row.grantedViaGrantId)
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const updated = await db.userGrants.update(
    { revokedAt: new Date() },
    and(eq(schema.userGrants.id, row.id), isNull(schema.userGrants.revokedAt)),
  )
  const result = updated[0]
  if (!result) throw new AppError('not_found', { httpStatus: 404 })
  return result
}

app.post('/:id/revoke', async (c) => c.json(toResponse(await revokeUserGrant(c))))

app.delete('/:id', async (c) => {
  await revokeUserGrant(c)
  return new Response(null, { status: 204 })
})

export function registerUserGrants(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/user-grants', app)
}
