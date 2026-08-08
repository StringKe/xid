// Management API v1: /v1/organizations/:orgId/units 组织架构(OrgUnit 树)资源。
// 设计来源 docs/design/org-structure-access/design-org-structure.md 第 4 节。
// 树一致性全部委托 @xid-kit/db 服务层(createUnit/moveUnit/...),路由层只做 guard、
// 形状校验、同租户 user 校验与 Result -> AppError 映射。
// 认证:sk_live_ Bearer(org-units:read/write)或 org manager cookie session。
// 租户隔离:createTenantDb 双注入 tenant_id + org_id;跨租户/跨 org id 一律 404,不泄露存在性。

import {
  addUnitMember,
  archiveUnit,
  createTenantDb,
  createUnit,
  listChildren,
  listSubtreeMembers,
  listTree,
  moveUnit,
  removeUnitMember,
  schema,
  setPrimaryUnit,
  updateUnit,
  type OrgUnitMemberRow,
  type OrgUnitRow,
  type OrgUnitScope,
} from '@xid-kit/db'
import type { XidError } from '@xid-kit/types'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import { AppError } from '../lib/errors'
import { readJsonBody, validateBody } from '../lib/validate'
import {
  requireApiKeyOrOrgManager,
  emitManagementAuditAsync,
  parsePagination,
  paginate,
  decodeCursor,
  type OrgScopedAuth,
  type PaginatedResponse,
} from './shared'

const app = new Hono<XidHonoEnv>()

// 审计 actor:API key 取 key id,org console session 取 userId(与 projects.ts 先例一致)。
function actorIdOf(auth: OrgScopedAuth): string {
  return auth.kind === 'api_key' ? auth.apiKeyId : auth.session.userId
}

// 形状校验只管字段类型/必填;parent 存在性、深度上限、slug 唯一等业务校验在服务层(Result)。
const createUnitBodySchema = v.object({
  parent_unit_id: v.optional(v.pipe(v.string(), v.minLength(1))),
  slug: v.pipe(v.string(), v.minLength(1)),
  name: v.pipe(v.string(), v.minLength(1)),
  manager_user_id: v.optional(v.pipe(v.string(), v.minLength(1))),
})

const patchUnitBodySchema = v.object({
  name: v.optional(v.pipe(v.string(), v.minLength(1))),
  slug: v.optional(v.pipe(v.string(), v.minLength(1))),
  manager_user_id: v.optional(v.nullable(v.pipe(v.string(), v.minLength(1)))),
})

const moveUnitBodySchema = v.object({
  parent_unit_id: v.pipe(v.string(), v.minLength(1)),
})

const putMemberBodySchema = v.object({
  is_primary: v.optional(v.boolean()),
})

// unit 行转对外响应(白名单):剔除 tenant_id 隔离键。
function toUnitResponse(row: OrgUnitRow) {
  return {
    id: row.id,
    org_id: row.orgId,
    parent_unit_id: row.parentUnitId,
    path: row.path,
    depth: row.depth,
    slug: row.slug,
    name: row.name,
    manager_user_id: row.managerUserId,
    status: row.status,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

function toMemberResponse(row: OrgUnitMemberRow) {
  return {
    id: row.id,
    org_id: row.orgId,
    unit_id: row.unitId,
    user_id: row.userId,
    is_primary: row.isPrimary,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

function scopeOf(c: Context<XidHonoEnv>, orgId: string): OrgUnitScope {
  return { d1: c.env.DB, ctx: c.get('tenant'), orgId }
}

// 服务层预期失败(Result)按 code + httpStatus 映射为 AppError 走 onError;意外错误服务层已抛出。
function throwServiceError(error: XidError): never {
  throw new AppError(error.code, { httpStatus: error.httpStatus, longMessage: error.message })
}

// manager_user_id / 成员 user_id 必须属于当前租户:users 查询走租户层注入 tenant_id,
// 跨租户 id 查不到 -> 404 not_found(不泄露存在性;XidErrorCode 无 user_not_found,与
// memberships.ts 的 User not found 先例一致)。
async function requireTenantUser(c: Context<XidHonoEnv>, userId: string) {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const user = await db.users.findOne(
    and(
      eq(schema.users.id, userId),
      eq(schema.users.status, 'active'),
      isNull(schema.users.deletedAt),
    ),
  )
  if (!user) throw new AppError('not_found', { httpStatus: 404, longMessage: 'User not found.' })
}

// 树/成员列表是服务层一次性返回的物化数组(path 或 created_at,id 排序),分页在数组上按
// id 游标切页;未知游标返回空页,畸形游标由 decodeCursor 抛 validation_failed。
function paginateRows<T extends { id: string }>(
  rows: T[],
  cursor: string | null,
  limit: number,
): PaginatedResponse<T> {
  let start = 0
  if (cursor) {
    const id = decodeCursor(cursor)
    const index = rows.findIndex((row) => row.id === id)
    start = index < 0 ? rows.length : index + 1
  }
  return paginate(rows.slice(start, start + limit + 1), (row) => row.id, limit)
}

// GET /v1/organizations/:orgId/units?parent_unit_id=&limit=&cursor=
// ?parent_unit_id= 过滤直接子节点;缺省返回整树(path 字典序 = 先根遍历)。
app.get('/:orgId/units', async (c) => {
  const orgId = c.req.param('orgId')
  await requireApiKeyOrOrgManager(c, orgId, 'org-units:read')

  const scope = scopeOf(c, orgId)
  const { limit, cursor } = parsePagination(c)
  const parentUnitId = c.req.query('parent_unit_id')
  const rows =
    parentUnitId === undefined ? await listTree(scope) : await listChildren(scope, parentUnitId)
  return c.json(paginateRows(rows.map(toUnitResponse), cursor, limit))
})

// POST /v1/organizations/:orgId/units -- 创建节点
app.post('/:orgId/units', async (c) => {
  const orgId = c.req.param('orgId')
  const auth = await requireApiKeyOrOrgManager(c, orgId, 'org-units:write')

  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createUnitBodySchema, json.value)
  if (body.manager_user_id !== undefined) await requireTenantUser(c, body.manager_user_id)

  const result = await createUnit(scopeOf(c, orgId), {
    ...(body.parent_unit_id !== undefined ? { parentUnitId: body.parent_unit_id } : {}),
    slug: body.slug,
    name: body.name,
    ...(body.manager_user_id !== undefined ? { managerUserId: body.manager_user_id } : {}),
  })
  if (!result.ok) throwServiceError(result.error)
  emitManagementAuditAsync(c, {
    action: 'org_unit.created',
    actorId: actorIdOf(auth),
    orgId,
    targetType: 'org_unit',
    targetId: result.value.id,
    details: {
      parentUnitId: result.value.parentUnitId,
      managerUserId: result.value.managerUserId,
      slug: result.value.slug,
    },
  })
  return c.json(toUnitResponse(result.value), 201)
})

// GET /v1/organizations/:orgId/units/:unitId -- 详情(含 depth/path)
app.get('/:orgId/units/:unitId', async (c) => {
  const orgId = c.req.param('orgId')
  await requireApiKeyOrOrgManager(c, orgId, 'org-units:read')

  const orgDb = createTenantDb(c.env.DB, c.get('tenant')).forOrg(orgId)
  const row = await orgDb.orgUnits.findOne(eq(schema.orgUnits.id, c.req.param('unitId')))
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  return c.json(toUnitResponse(row))
})

// PATCH /v1/organizations/:orgId/units/:unitId -- 改 name/slug/manager_user_id
app.patch('/:orgId/units/:unitId', async (c) => {
  const orgId = c.req.param('orgId')
  const auth = await requireApiKeyOrOrgManager(c, orgId, 'org-units:write')

  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(patchUnitBodySchema, json.value)
  // 空 body 守卫:全 optional schema 下 {} 会让服务层 .set({}) 抛错(500),与 projects.ts 先例一致按 422 拒绝。
  if (Object.keys(body).length === 0) {
    throw new AppError('validation_failed', { httpStatus: 422 })
  }
  if (typeof body.manager_user_id === 'string') await requireTenantUser(c, body.manager_user_id)

  const result = await updateUnit(scopeOf(c, orgId), c.req.param('unitId'), {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.slug !== undefined ? { slug: body.slug } : {}),
    ...(body.manager_user_id !== undefined ? { managerUserId: body.manager_user_id } : {}),
  })
  if (!result.ok) throwServiceError(result.error)
  emitManagementAuditAsync(c, {
    action: 'org_unit.updated',
    actorId: actorIdOf(auth),
    orgId,
    targetType: 'org_unit',
    targetId: result.value.id,
    details: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.slug !== undefined ? { slug: body.slug } : {}),
      ...(body.manager_user_id !== undefined ? { managerUserId: body.manager_user_id } : {}),
    },
  })
  return c.json(toUnitResponse(result.value))
})

// POST /v1/organizations/:orgId/units/:unitId/move -- 移动子树
app.post('/:orgId/units/:unitId/move', async (c) => {
  const orgId = c.req.param('orgId')
  const auth = await requireApiKeyOrOrgManager(c, orgId, 'org-units:write')

  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(moveUnitBodySchema, json.value)

  const result = await moveUnit(scopeOf(c, orgId), c.req.param('unitId'), body.parent_unit_id)
  if (!result.ok) throwServiceError(result.error)
  emitManagementAuditAsync(c, {
    action: 'org_unit.moved',
    actorId: actorIdOf(auth),
    orgId,
    targetType: 'org_unit',
    targetId: result.value.id,
    details: { parentUnitId: result.value.parentUnitId },
  })
  return c.json(toUnitResponse(result.value))
})

// DELETE /v1/organizations/:orgId/units/:unitId -- 软归档(非物理删除,有 active 子节点拒绝)
app.delete('/:orgId/units/:unitId', async (c) => {
  const orgId = c.req.param('orgId')
  const auth = await requireApiKeyOrOrgManager(c, orgId, 'org-units:write')

  const result = await archiveUnit(scopeOf(c, orgId), c.req.param('unitId'))
  if (!result.ok) throwServiceError(result.error)
  emitManagementAuditAsync(c, {
    action: 'org_unit.archived',
    actorId: actorIdOf(auth),
    orgId,
    targetType: 'org_unit',
    targetId: result.value.id,
  })
  return c.json(toUnitResponse(result.value))
})

// GET /v1/organizations/:orgId/units/:unitId/members?include_descendants=true&limit=&cursor=
// include_descendants 默认 true(节点及后代成员);false 时只列直接成员。
// 两种路径都只返回有该 org active membership 的用户(悬挂成员行不可见,设计 2.2)。
app.get('/:orgId/units/:unitId/members', async (c) => {
  const orgId = c.req.param('orgId')
  await requireApiKeyOrOrgManager(c, orgId, 'org-units:read')

  const scope = scopeOf(c, orgId)
  const unitId = c.req.param('unitId')
  const { limit, cursor } = parsePagination(c)
  const includeDescendants = c.req.query('include_descendants') !== 'false'

  if (includeDescendants) {
    const result = await listSubtreeMembers(scope, unitId)
    if (!result.ok) throwServiceError(result.error)
    return c.json(paginateRows(result.value.map(toMemberResponse), cursor, limit))
  }

  const orgDb = createTenantDb(c.env.DB, c.get('tenant')).forOrg(orgId)
  const unit = await orgDb.orgUnits.findOne(
    and(eq(schema.orgUnits.id, unitId), eq(schema.orgUnits.status, 'active')),
  )
  if (!unit) throw new AppError('not_found', { httpStatus: 404 })
  const memberRows = await orgDb.orgUnitMembers.findMany(eq(schema.orgUnitMembers.unitId, unitId), {
    orderBy: asc(schema.orgUnitMembers.id),
  })
  const userIds = [...new Set(memberRows.map((row) => row.userId))]
  const activeMemberships =
    userIds.length === 0
      ? []
      : await orgDb.memberships.findMany(
          and(inArray(schema.memberships.userId, userIds), eq(schema.memberships.status, 'active')),
        )
  const activeUserIds = new Set(activeMemberships.map((row) => row.userId))
  const visible = memberRows.filter((row) => activeUserIds.has(row.userId))
  return c.json(paginateRows(visible.map(toMemberResponse), cursor, limit))
})

// PUT /v1/organizations/:orgId/units/:unitId/members/:userId -- 加入/设主岗
// 幂等:已是成员时 is_primary=true 委托 setPrimaryUnit(清旧设新),否则原样返回;
// 非成员委托 addUnitMember(内部前置校验该 org active Membership,设计 1 不变式)。
app.put('/:orgId/units/:unitId/members/:userId', async (c) => {
  const orgId = c.req.param('orgId')
  const auth = await requireApiKeyOrOrgManager(c, orgId, 'org-units:write')

  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(putMemberBodySchema, json.value)

  const unitId = c.req.param('unitId')
  const userId = c.req.param('userId')
  await requireTenantUser(c, userId)

  const scope = scopeOf(c, orgId)
  const orgDb = createTenantDb(c.env.DB, c.get('tenant')).forOrg(orgId)
  const existing = await orgDb.orgUnitMembers.findOne(
    and(eq(schema.orgUnitMembers.unitId, unitId), eq(schema.orgUnitMembers.userId, userId)),
  )
  if (existing) {
    if (body.is_primary === true && !existing.isPrimary) {
      const result = await setPrimaryUnit(scope, unitId, userId)
      if (!result.ok) throwServiceError(result.error)
      emitManagementAuditAsync(c, {
        action: 'org_unit.primary_changed',
        actorId: actorIdOf(auth),
        orgId,
        targetType: 'org_unit',
        targetId: unitId,
        details: { userId },
      })
      return c.json(toMemberResponse(result.value))
    }
    // 幂等无变化路径不发审计,避免噪声。
    return c.json(toMemberResponse(existing))
  }
  const result = await addUnitMember(scope, unitId, userId, {
    isPrimary: body.is_primary === true,
  })
  if (!result.ok) throwServiceError(result.error)
  emitManagementAuditAsync(c, {
    action: 'org_unit.member_added',
    actorId: actorIdOf(auth),
    orgId,
    targetType: 'org_unit',
    targetId: unitId,
    details: { userId, isPrimary: result.value.isPrimary },
  })
  return c.json(toMemberResponse(result.value), 201)
})

// DELETE /v1/organizations/:orgId/units/:unitId/members/:userId -- 移出成员
app.delete('/:orgId/units/:unitId/members/:userId', async (c) => {
  const orgId = c.req.param('orgId')
  const auth = await requireApiKeyOrOrgManager(c, orgId, 'org-units:write')

  const result = await removeUnitMember(
    scopeOf(c, orgId),
    c.req.param('unitId'),
    c.req.param('userId'),
  )
  if (!result.ok) throwServiceError(result.error)
  emitManagementAuditAsync(c, {
    action: 'org_unit.member_removed',
    actorId: actorIdOf(auth),
    orgId,
    targetType: 'org_unit',
    targetId: c.req.param('unitId'),
    details: { userId: result.value.userId, isPrimary: result.value.isPrimary },
  })
  return new Response(null, { status: 204 })
})

export function registerOrgUnitsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/organizations', app)
}
