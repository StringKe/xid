// 企业组织架构:纯业务结构,不参与 TenantContext/token;无 FK,树一致性由 org-units.ts 维护。

import { sql } from 'drizzle-orm'
import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { boolCol, numCol, tenantId, timestamps } from './common'

// path 含自身,根 "/<id>";parent_unit_id NULL 不参与唯一比较,根 slug 重名 v1 接受。
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
    // (tenant,org,path) 服务 listTree 与 GLOB 范围扫描;旧 path 索引 additive 保留,DROP 另迁移。
    index('org_units_tenant_org_path_idx').on(t.tenantId, t.orgId, t.path),
    index('org_units_manager_idx').on(t.tenantId, t.managerUserId),
  ],
)

// org_id 冗余免 join;主岗 partial unique 兜底并发;兼岗不参与经理解析。
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
    // tenant_id 打头索引 + 旧 (unit_id,user_id) additive 保留。
    uniqueIndex('org_unit_members_tenant_unq').on(t.tenantId, t.unitId, t.userId),
    uniqueIndex('org_unit_members_primary_unq')
      .on(t.tenantId, t.orgId, t.userId)
      .where(sql`${t.isPrimary} = 1`),
    index('org_unit_members_tenant_user_idx').on(t.tenantId, t.userId),
    index('org_unit_members_tenant_org_user_idx').on(t.tenantId, t.orgId, t.userId),
    index('org_unit_members_unit_idx').on(t.tenantId, t.unitId),
  ],
)
