// 租户层级(08 章 10):instances 无 tenant_id;org 级带 tenant_id;唯一约束第一列 tenant_id。

import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { boolCol, numCol, tenantId, timestamps, tsMs } from './common'

// 平台级,无 tenant_id。
export const instances = sqliteTable(
  'instances',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    primaryDomain: text('primary_domain').notNull(),
    mode: text('mode').notNull().default('multi_tenant'),
    defaultLocale: text('default_locale').notNull().default('en'),
    dataResidency: text('data_residency').notNull().default('us'),
    mfaPolicy: text('mfa_policy').notNull().default('optional'),
    passwordPolicy: text('password_policy', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    sessionPolicy: text('session_policy', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    tokenPolicy: text('token_policy', { mode: 'json' }).$type<Record<string, unknown>>(),
    status: text('status').notNull().default('active'),
    ...timestamps(),
  },
  (t) => [uniqueIndex('instances_primary_domain_unq').on(t.primaryDomain)],
)

// 顶层 org 的 tenant_id = 自身 id。
export const organizations = sqliteTable(
  'organizations',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    instanceId: text('instance_id').notNull(),
    parentOrgId: text('parent_org_id'),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    logoUrl: text('logo_url'),
    publicMetadata: text('public_metadata', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    privateMetadata: text('private_metadata', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    seatLimit: numCol('seat_limit'),
    seatUsed: numCol('seat_used').notNull().default(0),
    enrollmentMode: text('enrollment_mode').notNull().default('invite_required'),
    allowOrgSelfService: boolCol('allow_org_self_service').notNull().default(true),
    status: text('status').notNull().default('active'),
    deletedAt: tsMs('deleted_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('organizations_tenant_slug_unq').on(t.tenantId, t.slug),
    uniqueIndex('organizations_instance_slug_unq').on(t.instanceId, t.slug),
    index('organizations_instance_slug_idx').on(t.instanceId, t.slug),
    index('organizations_top_level_id_idx')
      .on(t.id)
      .where(sql`${t.parentOrgId} IS NULL`),
    index('organizations_active_id_idx')
      .on(t.id)
      .where(sql`${t.status} = 'active'`),
    index('organizations_tenant_status_id_idx').on(t.tenantId, t.status, t.id),
    index('organizations_instance_idx').on(t.instanceId),
    index('organizations_parent_idx').on(t.parentOrgId),
    index('organizations_parent_id_idx').on(t.parentOrgId, t.id),
    index('organizations_tenant_status_idx').on(t.tenantId, t.status),
  ],
)

// hostname 全局唯一(一 DNS 名只能绑一 org);删除后 tombstone 防陈旧 CNAME 被他租户抢占。
export type CustomHostnameDcvDelegationRecord = {
  cname: string
  cnameTarget: string
}

export type CustomHostnameValidationRecord = {
  status?: string
  txtName?: string
  txtValue?: string
  cname?: string
  cnameTarget?: string
}

export const customHostnames = sqliteTable(
  'custom_hostnames',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    orgId: text('org_id').notNull(),
    instanceId: text('instance_id').notNull(),
    hostname: text('hostname').notNull(),
    cloudflareHostnameId: text('cloudflare_hostname_id'),
    status: text('status').notNull().default('provisioning'),
    hostnameStatus: text('hostname_status').notNull().default('pending'),
    sslStatus: text('ssl_status'),
    ownershipVerificationType: text('ownership_verification_type'),
    ownershipVerificationName: text('ownership_verification_name'),
    ownershipVerificationValue: text('ownership_verification_value'),
    ownershipExpiresAt: tsMs('ownership_expires_at'),
    dcvDelegationRecords: text('dcv_delegation_records', { mode: 'json' })
      .$type<CustomHostnameDcvDelegationRecord[]>()
      .notNull()
      .default([]),
    validationRecords: text('validation_records', { mode: 'json' })
      .$type<CustomHostnameValidationRecord[]>()
      .notNull()
      .default([]),
    trafficCnameTarget: text('traffic_cname_target').notNull(),
    verificationErrors: text('verification_errors', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    requiresPasskeyReregistration: boolCol('requires_passkey_reregistration')
      .notNull()
      .default(true),
    activatedAt: tsMs('activated_at'),
    lastPolledAt: tsMs('last_polled_at'),
    deletedAt: tsMs('deleted_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('custom_hostnames_hostname_unq').on(t.hostname),
    uniqueIndex('custom_hostnames_cloudflare_id_unq').on(t.cloudflareHostnameId),
    index('custom_hostnames_tenant_org_status_id_idx').on(t.tenantId, t.orgId, t.status, t.id),
    index('custom_hostnames_status_expiry_id_idx').on(t.status, t.ownershipExpiresAt, t.id),
    index('custom_hostnames_instance_status_id_idx').on(t.instanceId, t.status, t.id),
  ],
)

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    orgId: text('org_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').notNull().default('active'),
    // 默认 open = 存量行为;restricted / approval_required 见 design-access-request 1.1。
    accessPolicy: text('access_policy').notNull().default('open'),
    deletedAt: tsMs('deleted_at'),
    ...timestamps(),
  },
  (t) => [
    index('projects_tenant_org_idx').on(t.tenantId, t.orgId),
    index('projects_tenant_status_id_idx').on(t.tenantId, t.status, t.id),
    index('projects_tenant_org_status_id_idx').on(t.tenantId, t.orgId, t.status, t.id),
  ],
)

export const applications = sqliteTable(
  'applications',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    projectId: text('project_id'),
    clientId: text('client_id').notNull(),
    clientSecretHash: text('client_secret_hash'),
    clientType: text('client_type').notNull().default('confidential'),
    tokenEndpointAuthMethod: text('token_endpoint_auth_method')
      .notNull()
      .default('client_secret_basic'),
    jwks: text('jwks', { mode: 'json' }).$type<Record<string, unknown>>(),
    redirectUris: text('redirect_uris', { mode: 'json' }).$type<string[]>().notNull().default([]),
    postLogoutRedirectUris: text('post_logout_redirect_uris', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    frontchannelLogoutUri: text('frontchannel_logout_uri'),
    backchannelLogoutUri: text('backchannel_logout_uri'),
    backchannelLogoutSessionRequired: boolCol('backchannel_logout_session_required')
      .notNull()
      .default(false),
    allowedGrantTypes: text('allowed_grant_types', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(['authorization_code', 'refresh_token']),
    allowedResponseTypes: text('allowed_response_types', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(['code']),
    allowedScopes: text('allowed_scopes', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(['openid', 'profile', 'email', 'offline_access']),
    requirePkce: boolCol('require_pkce').notNull().default(true),
    dpopBoundAccessTokens: boolCol('dpop_bound_access_tokens').notNull().default(false),
    accessTokenFormat: text('access_token_format').notNull().default('jwt'),
    // NULL 才继承 application->org->instance;列默认值会让 policy 层永远轮不到。
    accessTokenTtlSec: numCol('access_token_ttl_sec'),
    idTokenSignedAlg: text('id_token_signed_alg').notNull().default('ES256'),
    firstParty: boolCol('first_party').notNull().default(false),
    requireOrgContext: boolCol('require_org_context').notNull().default(false),
    customClaimsConfig: text('custom_claims_config', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    registrationAccessTokenHash: text('registration_access_token_hash'),
    status: text('status').notNull().default('active'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('applications_client_id_unq').on(t.clientId),
    index('applications_tenant_project_idx').on(t.tenantId, t.projectId),
    index('applications_tenant_status_id_idx').on(t.tenantId, t.status, t.id),
    index('applications_tenant_status_idx').on(t.tenantId, t.status),
  ],
)

export const projectGrants = sqliteTable(
  'project_grants',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    grantedProjectId: text('granted_project_id').notNull(),
    grantedByOrgId: text('granted_by_org_id').notNull(),
    grantedToOrgId: text('granted_to_org_id').notNull(),
    status: text('status').notNull().default('active'),
    revokedAt: tsMs('revoked_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('project_grants_project_org_unq').on(t.grantedProjectId, t.grantedToOrgId),
    index('project_grants_tenant_status_id_idx').on(t.tenantId, t.status, t.id),
    index('project_grants_tenant_project_status_id_idx').on(
      t.tenantId,
      t.grantedProjectId,
      t.status,
      t.id,
    ),
    index('project_grants_tenant_to_org_status_id_idx').on(
      t.tenantId,
      t.grantedToOrgId,
      t.status,
      t.id,
    ),
    index('project_grants_to_org_idx').on(t.grantedToOrgId),
    index('project_grants_tenant_idx').on(t.tenantId),
  ],
)

// 未设字段 null 回退 instance 默认。
export const orgPolicies = sqliteTable(
  'org_policies',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    orgId: text('org_id').notNull(),
    mfaPolicy: text('mfa_policy'),
    mfaAllowedMethods: text('mfa_allowed_methods', { mode: 'json' }).$type<string[]>(),
    passwordPolicy: text('password_policy', { mode: 'json' }).$type<Record<string, unknown>>(),
    tokenPolicy: text('token_policy', { mode: 'json' }).$type<Record<string, unknown>>(),
    sessionIdleTimeoutMin: integer('session_idle_timeout_min', { mode: 'number' }),
    sessionAbsoluteTimeoutDays: integer('session_absolute_timeout_days', { mode: 'number' }),
    forceSso: boolCol('force_sso').notNull().default(false),
    allowPasswordLogin: boolCol('allow_password_login').notNull().default(true),
    ...timestamps(),
  },
  (t) => [uniqueIndex('org_policies_org_unq').on(t.orgId)],
)
