// Tenant-scoped ManagerAssignment provisioning.
// instance_manager stays exclusively on /v1/platform/*; this module can only manage exact
// Organization, Project, and ProjectGrant scopes inside the current TenantContext.

import { createTenantDb, schema } from '@xid-kit/db'
import {
  TENANT_MANAGER_ROLES,
  TENANT_MANAGER_SCOPE_TYPES,
  isTenantManagerRole,
  isTenantManagerRoleScope,
  isTenantManagerScopeType,
  type TenantManagerScopeType,
} from '@xid-kit/types'
import { and, asc, eq, isNull, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { isUniqueConstraintError } from '../lib/d1-errors'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import {
  authorizeOrganizationManagement,
  authorizeProjectGrantRead,
  authorizeProjectManagement,
  requireProjectAccessActor,
  type ProjectAccessActor,
} from './project-access'
import { emitManagementAuditAsync, idAfterCursor, paginate, parsePagination } from './shared'

const app = new Hono<XidHonoEnv>()

const createAssignmentBodySchema = v.object({
  user_id: v.pipe(v.string(), v.minLength(1)),
  manager_role: v.picklist(TENANT_MANAGER_ROLES),
  scope_type: v.picklist(TENANT_MANAGER_SCOPE_TYPES),
  scope_id: v.pipe(v.string(), v.minLength(1)),
})

function toResponse(row: typeof schema.managerAssignments.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    manager_role: row.managerRole,
    scope_type: row.scopeType,
    scope_id: row.scopeId,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

async function requireActiveGrant(c: Context<XidHonoEnv>, grantId: string) {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const grant = await db.projectGrants.findOne(
    and(eq(schema.projectGrants.id, grantId), eq(schema.projectGrants.status, 'active')),
  )
  if (!grant) throw new AppError('not_found', { httpStatus: 404 })
  return grant
}

async function requireActiveProject(c: Context<XidHonoEnv>, projectId: string) {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const project = await db.projects.findOne(
    and(eq(schema.projects.id, projectId), eq(schema.projects.status, 'active')),
  )
  if (!project) throw new AppError('not_found', { httpStatus: 404 })
  return project
}

async function authorizeScopeRead(
  c: Context<XidHonoEnv>,
  actor: ProjectAccessActor,
  scopeType: TenantManagerScopeType,
  scopeId: string,
): Promise<void> {
  if (scopeType === 'org') {
    await authorizeOrganizationManagement(c, actor, scopeId)
    return
  }
  if (scopeType === 'project') {
    await authorizeProjectManagement(c, actor, scopeId)
    return
  }
  const grant = await requireActiveGrant(c, scopeId)
  await authorizeProjectGrantRead(c, actor, grant)
}

// Provisioning another manager is an Organization-level privilege. An exact project_manager or
// project_grant_manager may consume its own scope, but cannot delegate that management authority.
async function authorizeScopeProvisioning(
  c: Context<XidHonoEnv>,
  actor: ProjectAccessActor,
  scopeType: TenantManagerScopeType,
  scopeId: string,
): Promise<void> {
  if (scopeType === 'org') {
    await authorizeOrganizationManagement(c, actor, scopeId)
    return
  }
  if (scopeType === 'project') {
    const project = await requireActiveProject(c, scopeId)
    await authorizeOrganizationManagement(c, actor, project.orgId)
    return
  }
  const grant = await requireActiveGrant(c, scopeId)
  const project = await requireActiveProject(c, grant.grantedProjectId)
  await authorizeOrganizationManagement(c, actor, project.orgId)
}

async function requireActiveTargetUser(c: Context<XidHonoEnv>, userId: string): Promise<void> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const user = await db.users.findOne(
    and(
      eq(schema.users.id, userId),
      eq(schema.users.status, 'active'),
      isNull(schema.users.deletedAt),
    ),
  )
  if (!user) throw new AppError('not_found', { httpStatus: 404 })
}

app.get('/', async (c) => {
  const actor = await requireProjectAccessActor(c, 'manager_assignments:read')
  const scopeType = c.req.query('scope_type')
  const scopeId = c.req.query('scope_id')
  if (scopeType !== undefined && !isTenantManagerScopeType(scopeType)) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'scope_type' },
    })
  }
  if (actor.kind === 'session' && (!scopeType || !scopeId)) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'scope_id' },
    })
  }
  if (scopeType && scopeId) {
    await authorizeScopeRead(c, actor, scopeType, scopeId)
  }

  const { limit, cursor } = parsePagination(c)
  const filters = [ne(schema.managerAssignments.managerRole, 'instance_manager')]
  if (scopeType) {
    filters.push(eq(schema.managerAssignments.scopeType, scopeType))
  }
  if (scopeId) filters.push(eq(schema.managerAssignments.scopeId, scopeId))
  const userId = c.req.query('user_id')
  if (userId) filters.push(eq(schema.managerAssignments.userId, userId))
  const managerRole = c.req.query('manager_role')
  if (managerRole !== undefined && !isTenantManagerRole(managerRole)) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'manager_role' },
    })
  }
  if (managerRole) {
    filters.push(eq(schema.managerAssignments.managerRole, managerRole))
  }
  const after = idAfterCursor(schema.managerAssignments.id, cursor)
  if (after) filters.push(after)
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const rows = await db.managerAssignments.findMany(
    filters.length > 0 ? and(...filters) : undefined,
    { orderBy: asc(schema.managerAssignments.id), limit: limit + 1 },
  )
  return c.json(paginate(rows.map(toResponse), (row) => row.id, limit))
})

app.post('/', async (c) => {
  const actor = await requireProjectAccessActor(c, 'manager_assignments:write')
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createAssignmentBodySchema, json.value)
  if (!isTenantManagerRoleScope(body.manager_role, body.scope_type)) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'scope_type' },
    })
  }
  if (actor.kind === 'session' && actor.session.userId === body.user_id) {
    throw new AppError('forbidden', { httpStatus: 403 })
  }
  await requireActiveTargetUser(c, body.user_id)
  await authorizeScopeProvisioning(c, actor, body.scope_type, body.scope_id)

  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const existing = await db.managerAssignments.findOne(
    and(
      eq(schema.managerAssignments.userId, body.user_id),
      eq(schema.managerAssignments.managerRole, body.manager_role),
      eq(schema.managerAssignments.scopeType, body.scope_type),
      eq(schema.managerAssignments.scopeId, body.scope_id),
    ),
  )
  if (existing) throw new AppError('already_exists', { httpStatus: 409 })
  let row: typeof schema.managerAssignments.$inferSelect
  try {
    row = await db.managerAssignments.insert({
      id: createPersistedId('managerAssignment'),
      tenantId: c.get('tenant').tenantId,
      userId: body.user_id,
      managerRole: body.manager_role,
      scopeType: body.scope_type,
      scopeId: body.scope_id,
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new AppError('already_exists', { httpStatus: 409, cause: error })
    }
    throw error
  }
  emitManagementAuditAsync(c, {
    action: 'management.manager_assignment.granted',
    actorId: actor.kind === 'session' ? actor.session.userId : actor.apiKeyId,
    targetType: 'manager_assignment',
    targetId: row.id,
    details: {
      targetUserId: row.userId,
      managerRole: row.managerRole,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
    },
  })
  return c.json(toResponse(row), 201)
})

app.delete('/:id', async (c) => {
  const actor = await requireProjectAccessActor(c, 'manager_assignments:write')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const row = await db.managerAssignments.findOne(
    eq(schema.managerAssignments.id, c.req.param('id')),
  )
  if (!row || row.managerRole === 'instance_manager' || row.scopeId === null) {
    throw new AppError('not_found', { httpStatus: 404 })
  }
  if (actor.kind === 'session' && actor.session.userId === row.userId) {
    throw new AppError('forbidden', { httpStatus: 403 })
  }
  if (
    !isTenantManagerRole(row.managerRole) ||
    !isTenantManagerScopeType(row.scopeType) ||
    !isTenantManagerRoleScope(row.managerRole, row.scopeType)
  ) {
    throw new AppError('not_found', { httpStatus: 404 })
  }
  await authorizeScopeProvisioning(c, actor, row.scopeType, row.scopeId)
  await db.managerAssignments.hardDelete(eq(schema.managerAssignments.id, row.id))
  emitManagementAuditAsync(c, {
    action: 'management.manager_assignment.revoked',
    actorId: actor.kind === 'session' ? actor.session.userId : actor.apiKeyId,
    targetType: 'manager_assignment',
    targetId: row.id,
    details: {
      targetUserId: row.userId,
      managerRole: row.managerRole,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
    },
  })
  return new Response(null, { status: 204 })
})

export function registerManagerAssignments(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/manager-assignments', app)
}
