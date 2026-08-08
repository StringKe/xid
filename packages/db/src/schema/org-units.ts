// 企业组织架构(见 docs/design/org-structure-access/design-org-structure.md 第 2 节):
// org_units(org 内层级节点,物化路径,深度 <= 8 由应用层保证)/ org_unit_members(主岗/兼岗放置)。
// OrgUnit 是纯业务结构:不参与 TenantContext 解析、不进 token claim。全部表无 FK,树一致性由
// packages/db/src/org-units.ts 应用层维护(见设计 2.3)。

import { sql } from 'drizzle-orm'
import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { boolCol, numCol, tenantId, timestamps } from './common'

// org_units(设计 2.1):path 物化路径含自身,根 "/<id>";depth 根 = 1。
// UNIQUE(tenant_id, org_id, parent_unit_id, slug):SQLite 中 parent_unit_id 为 NULL 的行不参与
// 唯一比较,根节点 slug 重名 v1 接受(设计 2.1 说明)。
export const orgUnits = sqliteTable(
  'org_units',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    orgId: text('org_id').notNull(),
    parentUnitId: text('parent_unit_id'),
    path: text('path').notNull(),
    depth: numCol('depth').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    managerUserId: text('manager_user_id'),
    status: text('status').notNull().default('active'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('org_units_tenant_org_parent_slug_unq').on(
      t.tenantId,
      t.orgId,
      t.parentUnitId,
      t.slug,
    ),
    uniqueIndex('org_units_tenant_path_unq').on(t.tenantId, t.path),
    index('org_units_tenant_org_idx').on(t.tenantId, t.orgId),
    index('org_units_tenant_org_parent_idx').on(t.tenantId, t.orgId, t.parentUnitId),
    index('org_units_tenant_path_idx').on(t.tenantId, t.path),
    // (tenant_id, org_id, path):同时服务 listTree(tenant+org+path 有序)与子树 GLOB
    // 前缀范围扫描(path 段为 base62 id,无 GLOB 元字符;SQLite LIKE 对 BINARY 列不走索引)。
    // 旧 org_units_tenant_path_idx 保留:migration 只许 additive(0014 说明),DROP 留待单独废弃迁移。
    index('org_units_tenant_org_path_idx').on(t.tenantId, t.orgId, t.path),
    index('org_units_manager_idx').on(t.tenantId, t.managerUserId),
  ],
)

// org_unit_members(设计 2.2):org_id 冗余自 unit 免 join;主岗唯一走 partial unique index 兜底并发,
// 兼岗(is_primary=false)只参与按节点查成员,不参与经理解析。
export const orgUnitMembers = sqliteTable(
  'org_unit_members',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    orgId: text('org_id').notNull(),
    unitId: text('unit_id').notNull(),
    userId: text('user_id').notNull(),
    isPrimary: boolCol('is_primary').notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('org_unit_members_unq').on(t.unitId, t.userId),
    // 首列 tenant_id(tenant-isolation rule:租户内唯一约束一律 tenant_id 打头);
    // unit_id 本身是全局唯一 id,(tenant_id, unit_id, user_id) 与 (unit_id, user_id) 语义等价。
    // 旧 (unit_id, user_id) 唯一索引保留:更严格的约束仍成立,migration 只许 additive(0014 说明)。
    uniqueIndex('org_unit_members_tenant_unq').on(t.tenantId, t.unitId, t.userId),
    uniqueIndex('org_unit_members_primary_unq')
      .on(t.tenantId, t.orgId, t.userId)
      .where(sql`${t.isPrimary} = 1`),
    index('org_unit_members_tenant_user_idx').on(t.tenantId, t.userId),
    index('org_unit_members_tenant_org_user_idx').on(t.tenantId, t.orgId, t.userId),
    index('org_unit_members_unit_idx').on(t.tenantId, t.unitId),
  ],
)
