// SCIM 目录同步(08 章 16.4+):scim_token 只存哈希;查询须 tenant_id + directory_id(04 章 9.4)。

import { sql } from 'drizzle-orm'
import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { boolCol, createdAt, tenantId, timestamps, tsMs } from './common'

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

// unknown member 幂等占位(OneLogin 投递顺序 quirk)。
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

// 下游 SCIM 资源稳定 identity mapping。
export const scimTargetResources = sqliteTable(
  'scim_target_resources',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    orgId: text('org_id').notNull(),
    targetId: text('target_id').notNull(),
    resourceType: text('resource_type').$type<'User' | 'Group'>().notNull(),
    localResourceId: text('local_resource_id').notNull(),
    externalId: text('external_id').notNull(),
    downstreamId: text('downstream_id').notNull(),
    status: text('status').$type<'active' | 'deprovisioned'>().notNull().default('active'),
    lastSyncedAt: tsMs('last_synced_at').notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('scim_target_resources_local_unq').on(
      t.tenantId,
      t.targetId,
      t.resourceType,
      t.localResourceId,
    ),
    uniqueIndex('scim_target_resources_downstream_unq').on(
      t.tenantId,
      t.targetId,
      t.resourceType,
      t.downstreamId,
    ),
    index('scim_target_resources_tenant_org_target_status_id_idx').on(
      t.tenantId,
      t.orgId,
      t.targetId,
      t.status,
      t.id,
    ),
  ],
)
