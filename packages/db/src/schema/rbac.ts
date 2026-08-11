// RBAC + 成员(08 章 13/14):role/permission key 在 project 内唯一且 tenant_id 打头;Manager 不进业务 token。

import { sql } from 'drizzle-orm'
import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { boolCol, createdAt, numCol, tenantId, timestamps, tsMs } from './common'
import type { ManagerRole, ManagerScopeType, OrganizationMembershipRole } from '@xid-kit/types'

export const roles = sqliteTable(
  'roles',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    projectId: text('project_id').notNull(),
    key: text('key').notNull(),
    displayName: text('display_name').notNull(),
    group: text('group'),
    status: text('status').notNull().default('active'),
    deletedAt: tsMs('deleted_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('roles_tenant_project_key_unq').on(t.tenantId, t.projectId, t.key),
    index('roles_tenant_status_id_idx').on(t.tenantId, t.status, t.id),
    index('roles_tenant_project_status_id_idx').on(t.tenantId, t.projectId, t.status, t.id),
    index('roles_tenant_project_idx').on(t.tenantId, t.projectId),
  ],
)

export const permissions = sqliteTable(
  'permissions',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    projectId: text('project_id').notNull(),
    key: text('key').notNull(),
    description: text('description'),
    status: text('status').notNull().default('active'),
    deletedAt: tsMs('deleted_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('permissions_tenant_project_key_unq').on(t.tenantId, t.projectId, t.key),
    index('permissions_tenant_status_id_idx').on(t.tenantId, t.status, t.id),
    index('permissions_tenant_project_status_id_idx').on(t.tenantId, t.projectId, t.status, t.id),
    index('permissions_tenant_project_idx').on(t.tenantId, t.projectId),
  ],
)

export const rolePermissions = sqliteTable(
  'role_permissions',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    roleId: text('role_id').notNull(),
    permissionId: text('permission_id').notNull(),
    conditionExpression: text('condition_expression', { mode: 'json' }).$type<
      Record<string, unknown>
    >(),
    createdAt: createdAt(),
  },
  (t) => [
    // 旧全局唯一索引保留:migration 只许 additive,滚动部署期间新旧 Workers 共库。
    uniqueIndex('role_permissions_role_perm_unq').on(t.roleId, t.permissionId),
    uniqueIndex('role_permissions_tenant_role_perm_unq').on(t.tenantId, t.roleId, t.permissionId),
    index('role_permissions_tenant_role_idx').on(t.tenantId, t.roleId),
    index('role_permissions_tenant_role_id_idx').on(t.tenantId, t.roleId, t.id),
  ],
)

export const userGrants = sqliteTable(
  'user_grants',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    userId: text('user_id').notNull(),
    projectId: text('project_id').notNull(),
    roleId: text('role_id').notNull(),
    grantedViaGrantId: text('granted_via_grant_id'),
    // 溯源 access_request;与 granted_via_grant_id 互斥(跨 org 走后者)。
    grantedViaRequestId: text('granted_via_request_id'),
    // null = 永久;JIT 过期视同无 grant。
    expiresAt: tsMs('expires_at'),
    revokedAt: tsMs('revoked_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('user_grants_unq').on(t.userId, t.projectId, t.roleId, t.grantedViaGrantId),
    index('user_grants_tenant_user_project_idx').on(t.tenantId, t.userId, t.projectId),
    index('user_grants_tenant_user_project_revoked_id_idx').on(
      t.tenantId,
      t.userId,
      t.projectId,
      t.revokedAt,
      t.id,
    ),
    index('user_grants_via_grant_idx').on(t.grantedViaGrantId),
  ],
)

// 平台管理角色,不进业务 token。
export const managerAssignments = sqliteTable(
  'manager_assignments',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    userId: text('user_id').notNull(),
    managerRole: text('manager_role').$type<ManagerRole>().notNull(),
    scopeType: text('scope_type').$type<ManagerScopeType>().notNull(),
    scopeId: text('scope_id'),
    ...timestamps(),
  },
  (t) => [
    // 旧全局唯一索引保留,滚动部署期间新旧 Workers 共库。
    uniqueIndex('manager_assignments_unq').on(t.userId, t.managerRole, t.scopeType, t.scopeId),
    uniqueIndex('manager_assignments_tenant_scope_unq')
      .on(t.tenantId, t.userId, t.managerRole, t.scopeType, t.scopeId)
      .where(sql`${t.scopeId} IS NOT NULL`),
    uniqueIndex('manager_assignments_instance_unq')
      .on(t.tenantId, t.userId, t.managerRole, t.scopeType)
      .where(
        sql`${t.managerRole} = 'instance_manager'
          AND ${t.scopeType} = 'instance'
          AND ${t.scopeId} IS NULL`,
      ),
    index('manager_assignments_tenant_user_idx').on(t.tenantId, t.userId),
    index('manager_assignments_scope_idx').on(t.scopeType, t.scopeId),
  ],
)

export const memberships = sqliteTable(
  'memberships',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    orgId: text('org_id').notNull(),
    userId: text('user_id').notNull(),
    role: text('role').$type<OrganizationMembershipRole>().notNull().default('member'),
    membershipType: text('membership_type').notNull().default('member'),
    status: text('status').notNull().default('active'),
    isManaged: boolCol('is_managed').notNull().default(false),
    invitedByUserId: text('invited_by_user_id'),
    joinedAt: tsMs('joined_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('memberships_org_user_unq').on(t.orgId, t.userId),
    index('memberships_tenant_user_idx').on(t.tenantId, t.userId),
    index('memberships_tenant_user_status_id_idx').on(t.tenantId, t.userId, t.status, t.id),
    index('memberships_tenant_org_status_id_idx').on(t.tenantId, t.orgId, t.status, t.id),
    index('memberships_tenant_org_status_idx').on(t.tenantId, t.orgId, t.status),
  ],
)

// 邀请 token 只存哈希。
export const invitations = sqliteTable(
  'invitations',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    orgId: text('org_id').notNull(),
    email: text('email').notNull(),
    role: text('role').$type<OrganizationMembershipRole>().notNull().default('member'),
    tokenHash: text('token_hash').notNull(),
    tokenVersion: text('token_version')
      .$type<'legacy' | 'locator_v1'>()
      .notNull()
      .default('legacy'),
    inviteType: text('invite_type').notNull().default('email'),
    maxUses: numCol('max_uses'),
    usedCount: numCol('used_count').notNull().default(0),
    status: text('status').notNull().default('pending'),
    invitedByUserId: text('invited_by_user_id'),
    acceptedByUserId: text('accepted_by_user_id'),
    emailClaimTokenHash: text('email_claim_token_hash'),
    emailClaimEmailHash: text('email_claim_email_hash'),
    emailClaimExpiresAt: tsMs('email_claim_expires_at'),
    emailClaimConsumedAt: tsMs('email_claim_consumed_at'),
    emailClaimConsumptionId: text('email_claim_consumption_id'),
    emailClaimUserId: text('email_claim_user_id'),
    emailClaimRecoveryHash: text('email_claim_recovery_hash'),
    emailClaimSessionId: text('email_claim_session_id'),
    emailClaimSessionReservedAt: tsMs('email_claim_session_reserved_at'),
    emailClaimFinalizationId: text('email_claim_finalization_id'),
    displacedUserId: text('displaced_user_id'),
    displacedEmailId: text('displaced_email_id'),
    expiresAt: tsMs('expires_at').notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('invitations_token_unq').on(t.tokenHash),
    uniqueIndex('invitations_email_claim_token_unq')
      .on(t.emailClaimTokenHash)
      .where(sql`${t.emailClaimTokenHash} IS NOT NULL`),
    uniqueIndex('invitations_email_claim_consumption_unq')
      .on(t.emailClaimConsumptionId)
      .where(sql`${t.emailClaimConsumptionId} IS NOT NULL`),
    uniqueIndex('invitations_email_claim_recovery_unq')
      .on(t.emailClaimRecoveryHash)
      .where(sql`${t.emailClaimRecoveryHash} IS NOT NULL`),
    uniqueIndex('invitations_email_claim_finalization_unq')
      .on(t.emailClaimFinalizationId)
      .where(sql`${t.emailClaimFinalizationId} IS NOT NULL`),
    uniqueIndex('invitations_tenant_org_email_pending_unq')
      .on(t.tenantId, t.orgId, t.email)
      .where(sql`${t.status} IN ('pending', 'claim_verified')`),
    index('invitations_tenant_org_status_id_idx').on(t.tenantId, t.orgId, t.status, t.id),
    index('invitations_tenant_org_status_idx').on(t.tenantId, t.orgId, t.status),
    index('invitations_tenant_email_idx').on(t.tenantId, t.email),
  ],
)

// domain 全局唯一,一域一 org。
export const organizationDomains = sqliteTable(
  'organization_domains',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    orgId: text('org_id').notNull(),
    domain: text('domain').notNull(),
    verificationMethod: text('verification_method').notNull().default('dns_txt'),
    verificationToken: text('verification_token').notNull(),
    verificationStatus: text('verification_status').notNull().default('pending'),
    status: text('status').notNull().default('active'),
    isWildcard: boolCol('is_wildcard').notNull().default(false),
    enrollmentMode: text('enrollment_mode').notNull().default('invite_required'),
    verifiedAt: tsMs('verified_at'),
    deletedAt: tsMs('deleted_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('organization_domains_domain_unq').on(t.domain),
    index('organization_domains_tenant_org_idx').on(t.tenantId, t.orgId),
    index('organization_domains_tenant_org_status_id_idx').on(t.tenantId, t.orgId, t.status, t.id),
    index('organization_domains_status_idx').on(t.verificationStatus),
  ],
)
