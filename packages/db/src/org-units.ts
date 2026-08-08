// OrgUnit 树核心服务(见 docs/design/org-structure-access/design-org-structure.md 第 3 节)。
// 全部单表读写走 createTenantDb 租户层(tenant_id + org_id 双注入,见 tenant-isolation rule);
// raw SQL 仅用于 scoped accessor 无法表达的三处:子树 path/depth 批量重写、主岗清旧设新的原子
// batch、listSubtreeMembers 的多表 join,均显式绑定 tenant_id(与 apps/server 的 env.DB.batch
// 先例一致;D1 无交互事务,原子多写一律 d1.batch)。
// 树一致性(path 生成、深度上限 8、移动子树)集中在本模块(设计 2.3)。可预期失败返回 Result,
// 意外错误抛出(见 error-handling rule)。
// 子树匹配一律 `path GLOB node.path || '*'`(完整 pattern 单参数绑定):SQLite 默认
// case_sensitive_like=OFF,`? || '%'` 是 CONCAT 表达式,LIKE 前缀对 BINARY collation 列不走
// 索引;path 段全是 base62 id([A-Za-z0-9]),不含 GLOB 元字符 *?[],GLOB 走
// org_units_tenant_path_idx(tenant_id, org_id, path) 范围扫描。
// moveUnit/createUnit 的 TOCTOU 自防卫:校验读与 batch 写非原子,写语句在 WHERE/EXISTS 中
// 绑定校验时读到的快照(path),并发改动导致 0 行 -> 409 conflict,不允许半重写落库。

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

// 所有函数的统一作用域:D1 binding + TenantContext + 目标 org(tenant_id/org_id 双注入的来源)。
export type OrgUnitScope = {
  d1: D1Database
  ctx: TenantContext
  orgId: string
}

// 树深度上限(设计 2.1:根 = 1,上限 8,应用层检查)。
export const ORG_UNIT_MAX_DEPTH = 8

// 持久化 id 契约与 apps/server/worker/lib/persisted-id.ts 一致:前缀 + 21 位 base62,
// crypto.getRandomValues 拒绝采样保证等概率(不复用该模块:packages 不依赖 apps)。
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

// D1/SQLite 唯一冲突判定:命中唯一索引是预期失败(Result),其余错误原样抛出。
// drizzle 会把底层错误包进 "Failed query" Error,原始错误在 cause 链上。
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

// 创建节点:查 parent(同 tenant+org 且 active)-> depth+1 <= 8 -> 生成 id/path -> INSERT。
// 同级 slug 撞唯一索引返回 already_exists(根节点 slug 重名 v1 接受,见设计 2.1)。
// TOCTOU 自防卫:有 parent 时 INSERT ... SELECT ... WHERE EXISTS 绑定校验时读到的 parent
// 快照(status='active' 且 path 未变);parent 在读后被并发 move/path 改写 -> 0 行 -> 409,
// 避免把新节点挂到已失效的 path 前缀下。
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

// 改 name/slug/manager:slug 改动撞同级唯一返回 already_exists。
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

// 移动子树:目标 parent 同 org 且 active;拒绝移动到自身或自身后代;移动后子树最深节点
// depth 不得超上限。path/depth 重写 + parent 指针更新放进一个 d1.batch(原子;raw SQL 显式
// 绑定 tenant_id)。TOCTOU 自防卫:校验读与 batch 写非原子,语句 1 在 WHERE 绑定校验时读到的
// 旧 path,语句 2 以 EXISTS 引用语句 1 的落点;并发改动(如互逆移动)导致语句 1 零行 ->
// 语句 2 必然零行 -> 409 conflict,不会出现半重写的树(并发成环不可能落库)。
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
  // 子树含自身:GLOB `node.path*` 同时匹配 node.path 自身(* 匹配零字符)与全部后代。
  const subtree = await db.orgUnits.findMany(sql`${orgUnits.path} GLOB ${`${node.path}*`}`)
  const subtreeMaxDepth = subtree.reduce((max, row) => Math.max(max, row.depth), node.depth)
  const depthDelta = target.depth + 1 - node.depth
  if (subtreeMaxDepth + depthDelta > ORG_UNIT_MAX_DEPTH) {
    return err('unprocessable_entity', 'org unit depth limit exceeded', 422)
  }
  const now = Date.now()
  const newPrefix = `${target.path}/${node.id}`
  const results = await d1.batch([
    // 语句 1:本节点 parent 指针 + 新 path/depth;WHERE 绑定校验时读到的旧 path 做乐观并发
    // 控制,path 已被并发改动时零行。
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
    // 语句 2:重写全部后代的 path/depth(GLOB 旧前缀;语句 1 已把本节点 path 改掉,故只命中
    // 后代)。EXISTS 引用语句 1 的落点:语句 1 失败时本句必然零行,子树不会被半重写。
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

// 软归档:有 active 子节点时拒绝;归档后节点由查询路径排除(status='active' 过滤)。
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

// 直接子节点(active);parentUnitId 省略或 null 时列根节点。
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

// 整树:status='active' ORDER BY path(物化路径字典序 = 先根遍历)。
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

// 节点及后代成员:从 org_units 驱动(SQLite CROSS JOIN 固定连接顺序),u.path GLOB 前缀走
// org_units_tenant_path_idx(tenant_id, org_id, path) 范围扫描,成本 = O(子树成员数) 而非
// O(org 总成员数);再 join org_unit_members 取成员、join memberships 过滤 status='active'
// (设计 2.2:悬挂成员行不可见)。archived 节点被排除。
// 多表 join 超出 scoped accessor 表达力,raw SQL 显式绑定 tenant_id。
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

// 清旧主岗 + 设新主岗的原子 pair(partial unique index 兜底并发,见设计 2.2)。
// raw SQL 显式绑定 tenant_id;statements 由调用方组装进 d1.batch。
function clearPrimaryStatement(d1: D1Database, tenantId: string, orgId: string, userId: string) {
  return d1
    .prepare(
      `UPDATE org_unit_members
          SET is_primary = 0, updated_at = ?
        WHERE tenant_id = ? AND org_id = ? AND user_id = ? AND is_primary = 1`,
    )
    .bind(Date.now(), tenantId, orgId, userId)
}

// 加入成员:前置校验用户有该 org 的 active Membership;is_primary=true 时在同一 batch 内
// 清旧主岗(与 setPrimaryUnit 同语义)。同 unit 重复加入撞唯一索引返回 already_exists。
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
  // 前置校验:用户必须先有该 org 的 active Membership 才能入 Unit(设计 1 不变式)。
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

// 移出成员(物理删除成员行;unit 本身是软归档,成员行无保留语义)。
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

// 设主岗:清旧设新一个 batch 完成(partial unique index 兜底并发双主岗)。
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

// 经理解析(P1 审批路由数据源):主岗 unit -> path 拆祖先 id 序列(含自身)-> 一次查询取
// 祖先链(<= 8 行),应用层取 depth 最大且 manager 非空的节点。链上全空返回 null(P1 回落
// project/org manager)。
// manager 非空过滤不放进 WHERE:祖先链按主键 IN 取行后,`manager_user_id IS NOT NULL` 只
// 会误导优化器在无统计时选择 manager 索引扫全租户行;链上最多 8 行,应用层过滤代价为零。
// 解析结果等于请求者本人时由 P1 顺延,P0 只返回原始结果(设计 3 排除规则)。
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
