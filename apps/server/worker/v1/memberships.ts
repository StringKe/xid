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
import { readJsonBody, validateBody } from '../lib/validate'
import {
  requireApiKey,
  parsePagination,
  paginate,
  idAfterCursor,
  requireOrg,
  emitWebhookAsync,
} from './shared'

const app = new Hono<XidHonoEnv>()

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
const membershipRoleSchema = v.picklist(['owner', 'admin', 'member'])

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
    const updated = await orgDb.memberships.update(
      {
        role: body.role ?? existing.role,
        status: 'active',
        joinedAt: new Date(),
      },
      eq(schema.memberships.id, existing.id),
    )
    emitWebhookAsync(c, {
      tenantId: tenant.tenantId,
      event: 'organizationMembership.created',
      payload: { orgId, userId: body.user_id },
    })
    const row = updated[0]
    if (!row) throw new AppError('not_found', { httpStatus: 404 })
    return c.json(toResponse(row), 201)
  }
  if (existing) throw new AppError('already_exists', { httpStatus: 409 })

  const membership = await orgDb.memberships.insert({
    id: crypto.randomUUID(),
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

  const patch: Partial<typeof schema.memberships.$inferInsert> = {}
  if (body.role !== undefined) patch.role = body.role
  if (body.status !== undefined) patch.status = body.status

  const updated = await orgDb.memberships.update(
    patch,
    and(eq(schema.memberships.id, membershipId), eq(schema.memberships.status, 'active')),
  )
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organizationMembership.updated',
    payload: { orgId, membershipId },
  })
  const row = updated[0]
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
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

  await orgDb.memberships.update(
    { status: 'inactive' },
    and(eq(schema.memberships.id, membershipId), eq(schema.memberships.status, 'active')),
  )
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

  const user = await db.users.findOne(
    and(
      eq(schema.users.id, existing.userId),
      eq(schema.users.status, 'active'),
      isNull(schema.users.deletedAt),
    ),
  )
  if (!user) throw new AppError('not_found', { httpStatus: 404, longMessage: 'User not found.' })

  const updated = await orgDb.memberships.update(
    { status: 'active', joinedAt: new Date() },
    and(eq(schema.memberships.id, membershipId), eq(schema.memberships.status, 'inactive')),
  )
  const row = updated[0]
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
