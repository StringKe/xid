// Management API v1: /v1/organizations/:orgId/memberships 成员资源。
// CRUD + list(cursor 分页)。
// 认证:sk_live_ Bearer。租户隔离:createTenantDb + forOrg(orgId)。
// 见 tenant-isolation rule:org 级实体双重注入 tenant_id + org_id。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import { readJsonBody, validateBody } from '../lib/validate'
import {
  requireApiKey,
  parsePagination,
  paginate,
  idAfterCursor,
  requireOrg,
  emitWebhookAsync,
} from './shared'
import { ORGANIZATION_MEMBERSHIP_ROLES, type OrganizationMembershipRole } from '@xid-kit/types'

const app = new Hono<XidHonoEnv>()

type MembershipStatus = 'active' | 'inactive'

type MembershipMutation = {
  tenantId: string
  orgId: string
  membershipId: string
  expectedStatus: MembershipStatus
  role?: OrganizationMembershipRole
  status?: MembershipStatus
  joinedAt?: Date
  protectActiveOwner?: boolean
  requireCurrentRole?: 'owner' | 'non_owner'
}

function prepareMembershipMutation(env: Env, input: MembershipMutation): D1PreparedStatement {
  const assignments: string[] = []
  const bindings: unknown[] = []
  if (input.role !== undefined) {
    assignments.push('"role" = ?')
    bindings.push(input.role)
  }
  if (input.status !== undefined) {
    assignments.push('"status" = ?')
    bindings.push(input.status)
  }
  if (input.joinedAt !== undefined) {
    assignments.push('"joined_at" = ?')
    bindings.push(input.joinedAt.getTime())
  }
  assignments.push('"updated_at" = ?')
  bindings.push(Date.now())

  const roleCondition =
    input.requireCurrentRole === 'owner'
      ? `AND "role" = 'owner'`
      : input.requireCurrentRole === 'non_owner'
        ? `AND "role" <> 'owner'`
        : ''
  const ownerCondition = input.protectActiveOwner
    ? `AND (
         "role" <> 'owner'
         OR EXISTS (
           SELECT 1
             FROM memberships replacement_owner
             JOIN users replacement_user
               ON replacement_user.tenant_id = replacement_owner.tenant_id
              AND replacement_user.id = replacement_owner.user_id
            WHERE replacement_owner.tenant_id = memberships.tenant_id
              AND replacement_owner.org_id = memberships.org_id
              AND replacement_owner.id <> memberships.id
              AND replacement_owner.role = 'owner'
              AND replacement_owner.status = 'active'
              AND replacement_user.status = 'active'
              AND replacement_user.deleted_at IS NULL
         )
       )`
    : ''

  return env.DB.prepare(
    `UPDATE memberships
        SET ${assignments.join(', ')}
      WHERE "tenant_id" = ?
        AND "org_id" = ?
        AND "id" = ?
        AND "status" = '${input.expectedStatus}'
        ${roleCondition}
        ${ownerCondition}`,
  ).bind(...bindings, input.tenantId, input.orgId, input.membershipId)
}

async function mutateMembership(env: Env, input: MembershipMutation): Promise<boolean> {
  const [result] = await env.DB.batch([prepareMembershipMutation(env, input)])
  const changes = (result?.meta as { changes?: number } | undefined)?.changes
  return changes === 1
}

// membership 行转对外响应:白名单显式列出,剔除 tenantId(隔离键)、
// isManaged(SCIM 托管内部标记)、invitedByUserId(内部邀请来源)。
function toResponse(row: typeof schema.memberships.$inferSelect) {
  return {
    id: row.id,
    orgId: row.orgId,
    userId: row.userId,
    role: row.role,
    membershipType: row.membershipType,
    status: row.status,
    joinedAt: row.joinedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

// 形状校验只管字段类型/必填;user 存在性、唯一约束等业务校验留在 handler(见 error-handling rule)。
const membershipRoleSchema = v.picklist(ORGANIZATION_MEMBERSHIP_ROLES)

const createMembershipBodySchema = v.object({
  user_id: v.pipe(v.string(), v.minLength(1)),
  role: v.optional(membershipRoleSchema),
})

const patchMembershipBodySchema = v.object({
  role: v.optional(membershipRoleSchema),
  status: v.optional(v.picklist(['active', 'inactive'])),
})

// GET /v1/organizations/:orgId/memberships?limit=&cursor=
app.get('/:orgId/memberships', async (c) => {
  await requireApiKey(c, 'memberships:read')
  const orgId = c.req.param('orgId')
  await requireOrg(c, orgId)

  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const orgDb = db.forOrg(orgId)
  const { limit, cursor } = parsePagination(c)

  const afterCond = idAfterCursor(schema.memberships.id, cursor)
  const statusCond = eq(schema.memberships.status, 'active')
  const where = afterCond ? and(statusCond, afterCond) : statusCond
  const rows = await orgDb.memberships.findMany(where, {
    orderBy: asc(schema.memberships.id),
    limit: limit + 1,
  })
  return c.json(paginate(rows.map(toResponse), (r) => r.id, limit))
})

// GET /v1/organizations/:orgId/memberships/:membershipId
app.get('/:orgId/memberships/:membershipId', async (c) => {
  await requireApiKey(c, 'memberships:read')
  const orgId = c.req.param('orgId')
  await requireOrg(c, orgId)

  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const orgDb = db.forOrg(orgId)
  const membershipId = c.req.param('membershipId')
  const row = await orgDb.memberships.findOne(
    and(eq(schema.memberships.id, membershipId), eq(schema.memberships.status, 'active')),
  )
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  return c.json(toResponse(row))
})

// POST /v1/organizations/:orgId/memberships -- 添加成员
app.post('/:orgId/memberships', async (c) => {
  await requireApiKey(c, 'memberships:write')
  const orgId = c.req.param('orgId')
  await requireOrg(c, orgId)

  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)

  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createMembershipBodySchema, json.value)
  if (body.role === 'owner') throw new AppError('forbidden', { httpStatus: 403 })

  // 验证 user 属于当前租户(tenant_id 自动注入,findOne 内含 WHERE tenant_id=?)
  const user = await db.users.findOne(
    and(
      eq(schema.users.id, body.user_id),
      eq(schema.users.status, 'active'),
      isNull(schema.users.deletedAt),
    ),
  )
  if (!user) throw new AppError('not_found', { httpStatus: 404, longMessage: 'User not found.' })

  // 唯一约束(org_id, user_id),见 schema/rbac.ts
  const orgDb = db.forOrg(orgId)
  const existing = await orgDb.memberships.findOne(eq(schema.memberships.userId, body.user_id))
  if (existing && existing.status !== 'active') {
    const nextRole = body.role ?? existing.role
    if (nextRole === 'owner') throw new AppError('forbidden', { httpStatus: 403 })
    const changed = await mutateMembership(c.env, {
      tenantId: tenant.tenantId,
      orgId,
      membershipId: existing.id,
      expectedStatus: 'inactive',
      role: nextRole,
      status: 'active',
      joinedAt: new Date(),
      requireCurrentRole: 'non_owner',
    })
    if (!changed) throw new AppError('conflict', { httpStatus: 409 })
    const row = await orgDb.memberships.findOne(eq(schema.memberships.id, existing.id))
    if (!row) throw new AppError('not_found', { httpStatus: 404 })
    emitWebhookAsync(c, {
      tenantId: tenant.tenantId,
      event: 'organizationMembership.created',
      payload: { orgId, userId: body.user_id },
    })
    return c.json(toResponse(row), 201)
  }
  if (existing) throw new AppError('already_exists', { httpStatus: 409 })

  const membership = await orgDb.memberships.insert({
    id: createPersistedId('membership'),
    tenantId: tenant.tenantId,
    orgId,
    userId: body.user_id,
    role: body.role ?? 'member',
    joinedAt: new Date(),
  })
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organizationMembership.created',
    payload: { orgId, userId: body.user_id },
  })
  return c.json(toResponse(membership), 201)
})

// PATCH /v1/organizations/:orgId/memberships/:membershipId -- 更新角色
app.patch('/:orgId/memberships/:membershipId', async (c) => {
  await requireApiKey(c, 'memberships:write')
  const orgId = c.req.param('orgId')
  await requireOrg(c, orgId)

  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const orgDb = db.forOrg(orgId)
  const membershipId = c.req.param('membershipId')

  const existing = await orgDb.memberships.findOne(
    and(eq(schema.memberships.id, membershipId), eq(schema.memberships.status, 'active')),
  )
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })

  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(patchMembershipBodySchema, json.value)

  if (body.role === 'owner' && existing.role !== 'owner') {
    throw new AppError('forbidden', { httpStatus: 403 })
  }
  const changed = await mutateMembership(c.env, {
    tenantId: tenant.tenantId,
    orgId,
    membershipId,
    expectedStatus: 'active',
    role: body.role,
    status: body.status,
    protectActiveOwner:
      body.status === 'inactive' || (body.role !== undefined && body.role !== 'owner'),
    requireCurrentRole: body.role === 'owner' ? 'owner' : undefined,
  })
  if (!changed) throw new AppError('conflict', { httpStatus: 409 })
  const row = await orgDb.memberships.findOne(eq(schema.memberships.id, membershipId))
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organizationMembership.updated',
    payload: { orgId, membershipId },
  })
  return c.json(toResponse(row))
})

// DELETE /v1/organizations/:orgId/memberships/:membershipId -- 移除成员
app.delete('/:orgId/memberships/:membershipId', async (c) => {
  await requireApiKey(c, 'memberships:write')
  const orgId = c.req.param('orgId')
  await requireOrg(c, orgId)

  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const orgDb = db.forOrg(orgId)
  const membershipId = c.req.param('membershipId')

  const existing = await orgDb.memberships.findOne(
    and(eq(schema.memberships.id, membershipId), eq(schema.memberships.status, 'active')),
  )
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })

  const changed = await mutateMembership(c.env, {
    tenantId: tenant.tenantId,
    orgId,
    membershipId,
    expectedStatus: 'active',
    status: 'inactive',
    protectActiveOwner: true,
  })
  if (!changed) throw new AppError('conflict', { httpStatus: 409 })
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organizationMembership.deleted',
    payload: { orgId, membershipId, userId: existing.userId },
  })
  return new Response(null, { status: 204 })
})

// POST /v1/organizations/:orgId/memberships/:membershipId/restore -- 恢复成员关系
app.post('/:orgId/memberships/:membershipId/restore', async (c) => {
  await requireApiKey(c, 'memberships:write')
  const orgId = c.req.param('orgId')
  await requireOrg(c, orgId)

  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)
  const orgDb = db.forOrg(orgId)
  const membershipId = c.req.param('membershipId')

  const existing = await orgDb.memberships.findOne(
    and(eq(schema.memberships.id, membershipId), eq(schema.memberships.status, 'inactive')),
  )
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  if (existing.role === 'owner') throw new AppError('forbidden', { httpStatus: 403 })

  const user = await db.users.findOne(
    and(
      eq(schema.users.id, existing.userId),
      eq(schema.users.status, 'active'),
      isNull(schema.users.deletedAt),
    ),
  )
  if (!user) throw new AppError('not_found', { httpStatus: 404, longMessage: 'User not found.' })

  const changed = await mutateMembership(c.env, {
    tenantId: tenant.tenantId,
    orgId,
    membershipId,
    expectedStatus: 'inactive',
    status: 'active',
    joinedAt: new Date(),
    requireCurrentRole: 'non_owner',
  })
  if (!changed) throw new AppError('conflict', { httpStatus: 409 })
  const row = await orgDb.memberships.findOne(eq(schema.memberships.id, membershipId))
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organizationMembership.restored',
    payload: { orgId, membershipId, userId: existing.userId },
  })
  return c.json(toResponse(row))
})

export function registerMembershipsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/organizations', app)
}
