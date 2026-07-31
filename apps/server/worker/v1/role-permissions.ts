// Management API v1: RolePermission mapping CRUD.
// A mapping never crosses Project boundaries. ABAC JSON is validated at the write boundary so
// unsupported operators or variable paths cannot become permissive legacy configuration.

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { isUniqueConstraintError } from '../lib/d1-errors'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import { isValidAbacCondition } from '../rbac/action'
import {
  authorizeProjectManagement,
  authorizeProjectRead,
  requireProjectAccessActor,
} from './project-access'
import { emitManagementAuditAsync, idAfterCursor, paginate, parsePagination } from './shared'

const app = new Hono<XidHonoEnv>()

const createRolePermissionBodySchema = v.object({
  role_id: v.pipe(v.string(), v.minLength(1)),
  permission_id: v.pipe(v.string(), v.minLength(1)),
  condition_expression: v.optional(v.nullable(v.record(v.string(), v.unknown()))),
})

const patchRolePermissionBodySchema = v.object({
  condition_expression: v.nullable(v.record(v.string(), v.unknown())),
})

function requireValidCondition(value: Record<string, unknown> | null | undefined): void {
  if (!isValidAbacCondition(value ?? null)) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'condition_expression' },
    })
  }
}

function toResponse(row: typeof schema.rolePermissions.$inferSelect) {
  return {
    id: row.id,
    role_id: row.roleId,
    permission_id: row.permissionId,
    condition_expression: row.conditionExpression,
    created_at: row.createdAt,
  }
}

async function requireActiveRole(c: Parameters<typeof authorizeProjectRead>[0], roleId: string) {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const role = await db.roles.findOne(
    and(eq(schema.roles.id, roleId), eq(schema.roles.status, 'active')),
  )
  if (!role) throw new AppError('not_found', { httpStatus: 404 })
  return role
}

async function requireMappingTargets(
  c: Parameters<typeof authorizeProjectRead>[0],
  roleId: string,
  permissionId: string,
) {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const [role, permission] = await Promise.all([
    db.roles.findOne(and(eq(schema.roles.id, roleId), eq(schema.roles.status, 'active'))),
    db.permissions.findOne(
      and(eq(schema.permissions.id, permissionId), eq(schema.permissions.status, 'active')),
    ),
  ])
  if (!role || !permission || role.projectId !== permission.projectId) {
    throw new AppError('not_found', { httpStatus: 404 })
  }
  return { role, permission }
}

app.get('/', async (c) => {
  const actor = await requireProjectAccessActor(c, 'role_permissions:read')
  const { limit, cursor } = parsePagination(c)
  const roleId = c.req.query('role_id')
  if (actor.kind === 'session' && !roleId) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'role_id' },
    })
  }
  if (roleId) {
    const role = await requireActiveRole(c, roleId)
    await authorizeProjectRead(c, actor, role.projectId, c.req.query('grant_id'))
  }

  const filters = []
  if (roleId) filters.push(eq(schema.rolePermissions.roleId, roleId))
  const after = idAfterCursor(schema.rolePermissions.id, cursor)
  if (after) filters.push(after)
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const rows = await db.rolePermissions.findMany(filters.length > 0 ? and(...filters) : undefined, {
    orderBy: asc(schema.rolePermissions.id),
    limit: limit + 1,
  })
  return c.json(paginate(rows.map(toResponse), (row) => row.id, limit))
})

app.post('/', async (c) => {
  const actor = await requireProjectAccessActor(c, 'role_permissions:write')
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createRolePermissionBodySchema, json.value)
  requireValidCondition(body.condition_expression)
  const { role } = await requireMappingTargets(c, body.role_id, body.permission_id)
  await authorizeProjectManagement(c, actor, role.projectId)

  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const existing = await db.rolePermissions.findOne(
    and(
      eq(schema.rolePermissions.roleId, body.role_id),
      eq(schema.rolePermissions.permissionId, body.permission_id),
    ),
  )
  if (existing) throw new AppError('already_exists', { httpStatus: 409 })
  let row: typeof schema.rolePermissions.$inferSelect
  try {
    row = await db.rolePermissions.insert({
      id: createPersistedId('rolePermission'),
      tenantId: c.get('tenant').tenantId,
      roleId: body.role_id,
      permissionId: body.permission_id,
      conditionExpression: body.condition_expression,
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new AppError('already_exists', { httpStatus: 409, cause: error })
    }
    throw error
  }
  emitManagementAuditAsync(c, {
    action: 'management.role_permission.created',
    actorId: actor.kind === 'session' ? actor.session.userId : actor.apiKeyId,
    targetType: 'role_permission',
    targetId: row.id,
    details: { roleId: row.roleId, permissionId: row.permissionId },
  })
  return c.json(toResponse(row), 201)
})

app.get('/:id', async (c) => {
  const actor = await requireProjectAccessActor(c, 'role_permissions:read')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const row = await db.rolePermissions.findOne(eq(schema.rolePermissions.id, c.req.param('id')))
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  const role = await requireActiveRole(c, row.roleId)
  await authorizeProjectRead(c, actor, role.projectId, c.req.query('grant_id'))
  return c.json(toResponse(row))
})

app.patch('/:id', async (c) => {
  const actor = await requireProjectAccessActor(c, 'role_permissions:write')
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(patchRolePermissionBodySchema, json.value)
  requireValidCondition(body.condition_expression)
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const row = await db.rolePermissions.findOne(eq(schema.rolePermissions.id, c.req.param('id')))
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  const { role } = await requireMappingTargets(c, row.roleId, row.permissionId)
  await authorizeProjectManagement(c, actor, role.projectId)
  const updated = await db.rolePermissions.update(
    { conditionExpression: body.condition_expression },
    eq(schema.rolePermissions.id, row.id),
  )
  const result = updated[0]
  if (!result) throw new AppError('not_found', { httpStatus: 404 })
  emitManagementAuditAsync(c, {
    action: 'management.role_permission.updated',
    actorId: actor.kind === 'session' ? actor.session.userId : actor.apiKeyId,
    targetType: 'role_permission',
    targetId: result.id,
    details: { roleId: result.roleId, permissionId: result.permissionId },
  })
  return c.json(toResponse(result))
})

app.delete('/:id', async (c) => {
  const actor = await requireProjectAccessActor(c, 'role_permissions:write')
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const row = await db.rolePermissions.findOne(eq(schema.rolePermissions.id, c.req.param('id')))
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  const { role } = await requireMappingTargets(c, row.roleId, row.permissionId)
  await authorizeProjectManagement(c, actor, role.projectId)
  await db.rolePermissions.hardDelete(eq(schema.rolePermissions.id, row.id))
  emitManagementAuditAsync(c, {
    action: 'management.role_permission.deleted',
    actorId: actor.kind === 'session' ? actor.session.userId : actor.apiKeyId,
    targetType: 'role_permission',
    targetId: row.id,
    details: { roleId: row.roleId, permissionId: row.permissionId },
  })
  return new Response(null, { status: 204 })
})

export function registerRolePermissions(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/role-permissions', app)
}
