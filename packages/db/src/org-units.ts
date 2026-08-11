// OrgUnit 树服务:单表走 createTenantDb 双注入;raw SQL 仅用于子树 path 重写、主岗原子 pair、多表 join,
// 且显式绑定 tenant_id(D1 无交互事务,多写用 d1.batch)。子树用 GLOB 走 path 索引(LIKE 对 BINARY
// 列不走索引);TOCTOU 靠 WHERE/EXISTS 绑定校验快照,并发 0 行 -> 409,禁止半重写。

import type { Result, TenantContext, XidError } from '@xid-kit/types'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { OrgScopedDb } from './tenant-db'
import { createTenantDb } from './tenant-db'
import { orgUnits, orgUnitMembers } from './schema/org-units'
import { memberships } from './schema/rbac'

export type OrgUnitRow = typeof orgUnits.$inferSelect
export type OrgUnitMemberRow = typeof orgUnitMembers.$inferSelect

export type ApproverResolution = {
  managerUserId: string
  viaUnitId: string
  depth: number
}

export type OrgUnitScope = {
  d1: D1Database
  ctx: TenantContext
  orgId: string
}

// 根 = 1,上限 8(设计 2.1,应用层检查)。
export const ORG_UNIT_MAX_DEPTH = 8

// 与 apps persisted-id 同契约(前缀 + 21 位 base62 拒绝采样);packages 不依赖 apps 故内联。
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const RANDOM_LENGTH = 21
const ACCEPT_BELOW = 248

function randomSuffix(): string {
  let suffix = ''
  while (suffix.length < RANDOM_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_LENGTH - suffix.length))
    for (const byte of bytes) {
      if (byte >= ACCEPT_BELOW) continue
      suffix += BASE62[byte % BASE62.length]
      if (suffix.length === RANDOM_LENGTH) break
    }
  }
  return suffix
}

const newUnitId = () => `ou_${randomSuffix()}`
const newUnitMemberId = () => `oum_${randomSuffix()}`

function err(code: XidError['code'], message: string, httpStatus: number): Result<never> {
  return { ok: false, error: { code, message, httpStatus } }
}

const notFound = (message: string): Result<never> => err('not_found', message, 404)

// 唯一冲突是预期 Result;drizzle 把底层错误包进 "Failed query",真实信息在 cause 链。
function isUniqueViolation(cause: unknown): boolean {
  let current: unknown = cause
  while (current instanceof Error) {
    if (current.message.includes('UNIQUE constraint failed')) return true
    current = current.cause
  }
  return false
}

function orgDb(scope: OrgUnitScope): OrgScopedDb {
  return createTenantDb(scope.d1, scope.ctx).forOrg(scope.orgId)
}

const activeUnit = (unitId: string) => and(eq(orgUnits.id, unitId), eq(orgUnits.status, 'active'))

export type CreateUnitInput = {
  parentUnitId?: string
  slug: string
  name: string
  managerUserId?: string
}

// INSERT...SELECT...WHERE EXISTS 绑定 parent 快照;并发 path 改写 -> 0 行 409,防挂到失效前缀。
// 根节点 slug 重名 v1 接受(SQLite NULL 不参与唯一比较,设计 2.1)。
export async function createUnit(
  scope: OrgUnitScope,
  input: CreateUnitInput,
): Promise<Result<OrgUnitRow>> {
  const db = orgDb(scope)
  let parent: OrgUnitRow | undefined
  if (input.parentUnitId !== undefined) {
    parent = await db.orgUnits.findOne(activeUnit(input.parentUnitId))
    if (!parent) return notFound('parent unit not found')
  }
  const depth = parent ? parent.depth + 1 : 1
  if (depth > ORG_UNIT_MAX_DEPTH) {
    return err('unprocessable_entity', 'org unit depth limit exceeded', 422)
  }
  const id = newUnitId()
  const path = parent ? `${parent.path}/${id}` : `/${id}`
  if (parent) {
    const now = Date.now()
    try {
      const inserted = await scope.d1
        .prepare(
          `INSERT INTO org_units
             (id, tenant_id, org_id, parent_unit_id, path, depth, slug, name,
              manager_user_id, status, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?
           WHERE EXISTS (
             SELECT 1 FROM org_units
              WHERE tenant_id = ? AND id = ? AND status = 'active' AND path = ?
           )`,
        )
        .bind(
          id,
          scope.ctx.tenantId,
          scope.orgId,
          parent.id,
          path,
          depth,
          input.slug,
          input.name,
          input.managerUserId ?? null,
          now,
          now,
          scope.ctx.tenantId,
          parent.id,
          parent.path,
        )
        .run()
      if (inserted.meta.changes === 0) {
        return err('conflict', 'parent unit was modified concurrently', 409)
      }
    } catch (cause) {
      if (isUniqueViolation(cause)) return err('already_exists', 'unit slug already exists', 409)
      throw cause
    }
    const row = await db.orgUnits.findOne(eq(orgUnits.id, id))
    if (!row) return notFound('unit not found')
    return { ok: true, value: row }
  }
  try {
    const row = await db.orgUnits.insert({
      id,
      tenantId: scope.ctx.tenantId,
      orgId: scope.orgId,
      parentUnitId: null,
      path,
      depth,
      slug: input.slug,
      name: input.name,
      managerUserId: input.managerUserId ?? null,
      status: 'active',
    })
    return { ok: true, value: row }
  } catch (cause) {
    if (isUniqueViolation(cause)) return err('already_exists', 'unit slug already exists', 409)
    throw cause
  }
}

export type UpdateUnitInput = {
  name?: string
  slug?: string
  managerUserId?: string | null
}

export async function updateUnit(
  scope: OrgUnitScope,
  unitId: string,
  patch: UpdateUnitInput,
): Promise<Result<OrgUnitRow>> {
  const db = orgDb(scope)
  const values: Partial<OrgUnitRow> = {}
  if (patch.name !== undefined) values.name = patch.name
  if (patch.slug !== undefined) values.slug = patch.slug
  if (patch.managerUserId !== undefined) values.managerUserId = patch.managerUserId
  try {
    const rows = await db.orgUnits.update(values, eq(orgUnits.id, unitId))
    const row = rows[0]
    if (!row) return notFound('unit not found')
    return { ok: true, value: row }
  } catch (cause) {
    if (isUniqueViolation(cause)) return err('already_exists', 'unit slug already exists', 409)
    throw cause
  }
}

// path/depth 重写与 parent 更新同 batch;语句 1 WHERE 绑旧 path,语句 2 EXISTS 引用落点,防半重写。
export async function moveUnit(
  scope: OrgUnitScope,
  unitId: string,
  parentUnitId: string,
): Promise<Result<OrgUnitRow>> {
  const db = orgDb(scope)
  const { d1, ctx, orgId } = scope
  const node = await db.orgUnits.findOne(eq(orgUnits.id, unitId))
  if (!node) return notFound('unit not found')
  const target = await db.orgUnits.findOne(activeUnit(parentUnitId))
  if (!target) return notFound('parent unit not found')
  if (target.id === node.id || target.path.startsWith(`${node.path}/`)) {
    return err('conflict', 'cannot move a unit into itself or its descendant', 409)
  }
  // GLOB `path*` 同时匹配自身(* 零字符)与全部后代。
  const subtree = await db.orgUnits.findMany(sql`${orgUnits.path} GLOB ${`${node.path}*`}`)
  const subtreeMaxDepth = subtree.reduce((max, row) => Math.max(max, row.depth), node.depth)
  const depthDelta = target.depth + 1 - node.depth
  if (subtreeMaxDepth + depthDelta > ORG_UNIT_MAX_DEPTH) {
    return err('unprocessable_entity', 'org unit depth limit exceeded', 422)
  }
  const now = Date.now()
  const newPrefix = `${target.path}/${node.id}`
  const results = await d1.batch([
    // 语句 1:WHERE 绑旧 path 做乐观并发控制。
    d1
      .prepare(
        `UPDATE org_units
            SET parent_unit_id = ?,
                path = ?,
                depth = ?,
                updated_at = ?
          WHERE tenant_id = ? AND org_id = ? AND id = ? AND path = ?`,
      )
      .bind(target.id, newPrefix, target.depth + 1, now, ctx.tenantId, orgId, node.id, node.path),
    // 语句 2:EXISTS 引用语句 1 落点;语句 1 失败则本句零行,避免半重写。
    d1
      .prepare(
        `UPDATE org_units
            SET path = ? || substr(path, ?),
                depth = depth + ?,
                updated_at = ?
          WHERE tenant_id = ? AND org_id = ? AND path GLOB ?
            AND EXISTS (
              SELECT 1 FROM org_units
               WHERE tenant_id = ? AND id = ? AND parent_unit_id = ? AND path = ?
            )`,
      )
      .bind(
        newPrefix,
        node.path.length + 1,
        depthDelta,
        now,
        ctx.tenantId,
        orgId,
        `${node.path}*`,
        ctx.tenantId,
        node.id,
        target.id,
        newPrefix,
      ),
  ])
  if ((results[0]?.meta.changes ?? 0) === 0) {
    return err('conflict', 'unit was modified concurrently', 409)
  }
  const moved = await db.orgUnits.findOne(eq(orgUnits.id, node.id))
  if (!moved) return notFound('unit not found')
  return { ok: true, value: moved }
}

export async function archiveUnit(
  scope: OrgUnitScope,
  unitId: string,
): Promise<Result<OrgUnitRow>> {
  const db = orgDb(scope)
  const activeChild = await db.orgUnits.findOne(
    and(eq(orgUnits.parentUnitId, unitId), eq(orgUnits.status, 'active')),
  )
  if (activeChild) return err('conflict', 'unit has active children', 409)
  const rows = await db.orgUnits.update({ status: 'archived' }, activeUnit(unitId))
  const row = rows[0]
  if (!row) return notFound('unit not found')
  return { ok: true, value: row }
}

export async function listChildren(
  scope: OrgUnitScope,
  parentUnitId?: string | null,
): Promise<OrgUnitRow[]> {
  const db = orgDb(scope)
  const parentWhere =
    parentUnitId === undefined || parentUnitId === null
      ? isNull(orgUnits.parentUnitId)
      : eq(orgUnits.parentUnitId, parentUnitId)
  return db.orgUnits.findMany(and(parentWhere, eq(orgUnits.status, 'active')), {
    orderBy: orgUnits.path,
  })
}

export async function listTree(scope: OrgUnitScope): Promise<OrgUnitRow[]> {
  const db = orgDb(scope)
  return db.orgUnits.findMany(eq(orgUnits.status, 'active'), { orderBy: orgUnits.path })
}

type SubtreeMemberRawRow = {
  id: string
  tenant_id: string
  org_id: string
  unit_id: string
  user_id: string
  is_primary: number
  created_at: number
  updated_at: number
}

// org_units 驱动 + GLOB 走 path 索引 O(子树);join memberships 滤 active,悬挂成员不可见(设计 2.2)。
export async function listSubtreeMembers(
  scope: OrgUnitScope,
  unitId: string,
): Promise<Result<OrgUnitMemberRow[]>> {
  const db = orgDb(scope)
  const unit = await db.orgUnits.findOne(activeUnit(unitId))
  if (!unit) return notFound('unit not found')
  const result = await scope.d1
    .prepare(
      `SELECT m.id, m.tenant_id, m.org_id, m.unit_id, m.user_id, m.is_primary,
              m.created_at, m.updated_at
         FROM org_units AS u
         CROSS JOIN org_unit_members AS m
           ON m.tenant_id = u.tenant_id AND m.unit_id = u.id
         JOIN memberships AS ms
           ON ms.tenant_id = m.tenant_id AND ms.org_id = m.org_id
          AND ms.user_id = m.user_id AND ms.status = 'active'
        WHERE u.tenant_id = ? AND u.org_id = ? AND u.path GLOB ? AND u.status = 'active'
        ORDER BY m.created_at, m.id`,
    )
    .bind(scope.ctx.tenantId, scope.orgId, `${unit.path}*`)
    .all<SubtreeMemberRawRow>()
  const rows = result.results.map(
    (row): OrgUnitMemberRow => ({
      id: row.id,
      tenantId: row.tenant_id,
      orgId: row.org_id,
      unitId: row.unit_id,
      userId: row.user_id,
      isPrimary: row.is_primary === 1,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }),
  )
  return { ok: true, value: rows }
}

// 清主岗语句;与设新主岗同 batch,partial unique 兜底并发(设计 2.2)。
function clearPrimaryStatement(d1: D1Database, tenantId: string, orgId: string, userId: string) {
  return d1
    .prepare(
      `UPDATE org_unit_members
          SET is_primary = 0, updated_at = ?
        WHERE tenant_id = ? AND org_id = ? AND user_id = ? AND is_primary = 1`,
    )
    .bind(Date.now(), tenantId, orgId, userId)
}

// 入 Unit 前须有 active Membership(设计 1);is_primary 时同 batch 清旧主岗。
export async function addUnitMember(
  scope: OrgUnitScope,
  unitId: string,
  userId: string,
  options?: { isPrimary?: boolean },
): Promise<Result<OrgUnitMemberRow>> {
  const db = orgDb(scope)
  const { d1, ctx, orgId } = scope
  const unit = await db.orgUnits.findOne(activeUnit(unitId))
  if (!unit) return notFound('unit not found')
  const membership = await db.memberships.findOne(
    and(eq(memberships.userId, userId), eq(memberships.status, 'active')),
  )
  if (!membership) return err('membership_not_found', 'active membership required', 404)
  try {
    if (options?.isPrimary === true) {
      const id = newUnitMemberId()
      const now = Date.now()
      await d1.batch([
        clearPrimaryStatement(d1, ctx.tenantId, orgId, userId),
        d1
          .prepare(
            `INSERT INTO org_unit_members
               (id, tenant_id, org_id, unit_id, user_id, is_primary, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .bind(id, ctx.tenantId, orgId, unitId, userId, now, now),
      ])
      const row = await db.orgUnitMembers.findOne(eq(orgUnitMembers.id, id))
      if (!row) return notFound('unit member not found')
      return { ok: true, value: row }
    }
    const row = await db.orgUnitMembers.insert({
      id: newUnitMemberId(),
      tenantId: ctx.tenantId,
      orgId,
      unitId,
      userId,
      isPrimary: false,
    })
    return { ok: true, value: row }
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      return err('already_exists', 'user is already a member of this unit', 409)
    }
    throw cause
  }
}

// 成员行物理删除(无保留语义;unit 才是软归档)。
export async function removeUnitMember(
  scope: OrgUnitScope,
  unitId: string,
  userId: string,
): Promise<Result<OrgUnitMemberRow>> {
  const db = orgDb(scope)
  const row = await db.orgUnitMembers.findOne(
    and(eq(orgUnitMembers.unitId, unitId), eq(orgUnitMembers.userId, userId)),
  )
  if (!row) return notFound('unit member not found')
  await db.orgUnitMembers.hardDelete(
    and(eq(orgUnitMembers.unitId, unitId), eq(orgUnitMembers.userId, userId)),
  )
  return { ok: true, value: row }
}

export async function setPrimaryUnit(
  scope: OrgUnitScope,
  unitId: string,
  userId: string,
): Promise<Result<OrgUnitMemberRow>> {
  const db = orgDb(scope)
  const { d1, ctx, orgId } = scope
  const unit = await db.orgUnits.findOne(activeUnit(unitId))
  if (!unit) return notFound('unit not found')
  const member = await db.orgUnitMembers.findOne(
    and(eq(orgUnitMembers.unitId, unitId), eq(orgUnitMembers.userId, userId)),
  )
  if (!member) return notFound('unit member not found')
  const now = Date.now()
  await d1.batch([
    clearPrimaryStatement(d1, ctx.tenantId, orgId, userId),
    d1
      .prepare(
        `UPDATE org_unit_members
            SET is_primary = 1, updated_at = ?
          WHERE tenant_id = ? AND org_id = ? AND unit_id = ? AND user_id = ?`,
      )
      .bind(now, ctx.tenantId, orgId, unitId, userId),
  ])
  const row = await db.orgUnitMembers.findOne(eq(orgUnitMembers.id, member.id))
  if (!row) return notFound('unit member not found')
  return { ok: true, value: row }
}

// 主岗 path 拆祖先后应用层取最近非空 manager;WHERE 不滤 manager,避免误走 manager 全表索引。
// 等于请求者本人时由 P1 顺延,本层只返原始结果(设计 3)。
export async function resolveApproverChain(
  scope: OrgUnitScope,
  userId: string,
): Promise<ApproverResolution | null> {
  const db = orgDb(scope)
  const primary = await db.orgUnitMembers.findOne(
    and(eq(orgUnitMembers.userId, userId), eq(orgUnitMembers.isPrimary, true)),
  )
  if (!primary) return null
  const unit = await db.orgUnits.findOne(eq(orgUnits.id, primary.unitId))
  if (!unit) return null
  const ancestorIds = unit.path.split('/').filter((segment) => segment.length > 0)
  const rows = await db.orgUnits.findMany(
    and(inArray(orgUnits.id, ancestorIds), eq(orgUnits.status, 'active')),
  )
  let nearest: OrgUnitRow | undefined
  for (const row of rows) {
    if (row.managerUserId === null) continue
    if (nearest === undefined || row.depth > nearest.depth) nearest = row
  }
  if (!nearest || nearest.managerUserId === null) return null
  return { managerUserId: nearest.managerUserId, viaUnitId: nearest.id, depth: nearest.depth }
}
