// SCIM 目录同步实体(见 08 章 16.4-16.7):directories / directory_users / directory_groups /
// directory_group_members / directory_pending_members。
// scim_token 存哈希(明文展示一次);SCIM 查询强制 WHERE tenant_id=? AND directory_id=?(见 04 章 9.4)。

import { sql } from 'drizzle-orm'
import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { boolCol, createdAt, tenantId, timestamps, tsMs } from './common'

// 16.4 directories(SCIM 目录连接)
export const directories = sqliteTable(
  'directories',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    orgId: text('org_id').notNull(),
    provider: text('provider').notNull(),
    scimTokenHash: text('scim_token_hash').notNull(),
    scimTokenHashPrev: text('scim_token_hash_prev'),
    scimTokenPrevExpires: tsMs('scim_token_prev_expires'),
    syncStatus: text('sync_status').notNull().default('idle'),
    status: text('status').notNull().default('active'),
    lastSyncAt: tsMs('last_sync_at'),
    deletedAt: tsMs('deleted_at'),
    ...timestamps(),
  },
  (t) => [
    index('directories_tenant_org_status_id_idx').on(t.tenantId, t.orgId, t.status, t.id),
    index('directories_tenant_status_id_idx').on(t.tenantId, t.status, t.id),
    index('directories_tenant_org_idx').on(t.tenantId, t.orgId),
    index('directories_tenant_token_hash_idx').on(t.tenantId, t.scimTokenHash),
    index('directories_tenant_token_hash_prev_idx').on(t.tenantId, t.scimTokenHashPrev),
  ],
)

// 16.5 directory_users(SCIM 同步用户,双向绑定)
export const directoryUsers = sqliteTable(
  'directory_users',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    directoryId: text('directory_id').notNull(),
    userId: text('user_id'),
    externalId: text('external_id'),
    userName: text('user_name').notNull(),
    scimRaw: text('scim_raw', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    active: boolCol('active').notNull().default(true),
    status: text('status').notNull().default('active'),
    deletedAt: tsMs('deleted_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('directory_users_dir_username_unq').on(t.directoryId, t.userName),
    uniqueIndex('directory_users_dir_external_unq').on(t.directoryId, t.externalId),
    index('directory_users_tenant_dir_id_idx')
      .on(t.tenantId, t.directoryId, t.id)
      .where(sql`${t.status} <> 'deleted' AND ${t.deletedAt} IS NULL`),
    index('directory_users_tenant_dir_active_id_idx').on(t.tenantId, t.directoryId, t.active, t.id),
    index('directory_users_tenant_dir_created_id_idx').on(
      t.tenantId,
      t.directoryId,
      t.createdAt,
      t.id,
    ),
    index('directory_users_tenant_dir_updated_id_idx').on(
      t.tenantId,
      t.directoryId,
      t.updatedAt,
      t.id,
    ),
    index('directory_users_tenant_dir_idx').on(t.tenantId, t.directoryId),
    index('directory_users_user_idx').on(t.userId),
  ],
)

// 16.6 directory_groups(SCIM 同步组 + group->role 映射)
export const directoryGroups = sqliteTable(
  'directory_groups',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    directoryId: text('directory_id').notNull(),
    displayName: text('display_name').notNull(),
    mappedRole: text('mapped_role'),
    status: text('status').notNull().default('active'),
    deletedAt: tsMs('deleted_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('directory_groups_dir_name_unq').on(t.directoryId, t.displayName),
    index('directory_groups_tenant_dir_id_idx')
      .on(t.tenantId, t.directoryId, t.id)
      .where(sql`${t.status} <> 'deleted' AND ${t.deletedAt} IS NULL`),
    index('directory_groups_tenant_dir_created_id_idx').on(
      t.tenantId,
      t.directoryId,
      t.createdAt,
      t.id,
    ),
    index('directory_groups_tenant_dir_updated_id_idx').on(
      t.tenantId,
      t.directoryId,
      t.updatedAt,
      t.id,
    ),
    index('directory_groups_tenant_dir_idx').on(t.tenantId, t.directoryId),
  ],
)

// 16.7 directory_group_members(已解析成员)
export const directoryGroupMembers = sqliteTable(
  'directory_group_members',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    groupId: text('group_id').notNull(),
    directoryUserId: text('directory_user_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('directory_group_members_unq').on(t.groupId, t.directoryUserId),
    index('directory_group_members_tenant_group_id_idx').on(t.tenantId, t.groupId, t.id),
  ],
)

// 16.7 directory_pending_members(unknown member 幂等占位,OneLogin quirk)
export const directoryPendingMembers = sqliteTable(
  'directory_pending_members',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    groupId: text('group_id').notNull(),
    ref: text('ref').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('directory_pending_members_unq').on(t.groupId, t.ref),
    index('directory_pending_members_tenant_ref_id_idx').on(t.tenantId, t.ref, t.id),
  ],
)

// 16.9 scim_targets(XID 作为 SCIM client 向下游 SaaS 推送用户和组)
export const scimTargets = sqliteTable(
  'scim_targets',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    orgId: text('org_id').notNull(),
    provider: text('provider').notNull(),
    baseUrl: text('base_url').notNull(),
    tokenSecretRef: text('token_secret_ref').notNull(),
    userFilter: text('user_filter', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: text('status').notNull().default('active'),
    lastSyncAt: tsMs('last_sync_at'),
    ...timestamps(),
  },
  (t) => [
    index('scim_targets_tenant_org_idx').on(t.tenantId, t.orgId),
    index('scim_targets_tenant_status_idx').on(t.tenantId, t.status),
  ],
)
