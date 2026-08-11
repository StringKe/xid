// OIDC/OAuth D1 实体(08 章 15);device_codes/PAR 走 DO 不建表;token 明文不入库,只存 hash。

import type { AmrValue, AuthorizationDetails } from '@xid-kit/types'
import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { createdAt, numCol, tenantId, timestamps, tsMs } from './common'

// code 即主键,一次性。
export const authorizationCodes = sqliteTable(
  'authorization_codes',
  {
    code: text('code').primaryKey(),
    tenantId: tenantId(),
    clientId: text('client_id').notNull(),
    userId: text('user_id').notNull(),
    // ID token sid 来源;非 session 链路签发留空(03 章 9.1)。
    sessionId: text('session_id'),
    redirectUri: text('redirect_uri'),
    scope: text('scope').notNull(),
    nonce: text('nonce'),
    codeChallenge: text('code_challenge'),
    codeChallengeMethod: text('code_challenge_method'),
    dpopJkt: text('dpop_jkt'),
    authTime: tsMs('auth_time').notNull(),
    acr: text('acr'),
    amr: text('amr', { mode: 'json' }).$type<AmrValue[]>(),
    resource: text('resource', { mode: 'json' }).$type<string[]>(),
    authorizationDetails: text('authorization_details', {
      mode: 'json',
    }).$type<AuthorizationDetails[]>(),
    activeOrgId: text('active_org_id'),
    projectGrantId: text('project_grant_id'),
    consumedAt: tsMs('consumed_at'),
    replayDetectedAt: tsMs('replay_detected_at'),
    expiresAt: tsMs('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('authorization_codes_tenant_client_idx').on(t.tenantId, t.clientId),
    index('authorization_codes_active_org_idx').on(t.activeOrgId),
    index('authorization_codes_project_grant_idx').on(t.projectGrantId),
    index('authorization_codes_expires_idx').on(t.expiresAt),
  ],
)

// 轮换 + family;token_hash 全局 UNIQUE。
export const refreshTokens = sqliteTable(
  'refresh_tokens',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    tokenHash: text('token_hash').notNull(),
    familyId: text('family_id').notNull(),
    parentTokenId: text('parent_token_id'),
    authorizationCode: text('authorization_code'),
    userId: text('user_id').notNull(),
    // 首发继承 authorization_code.session_id,轮换顺延(03 章 9.3)。
    sessionId: text('session_id'),
    clientId: text('client_id').notNull(),
    scope: text('scope').notNull(),
    jkt: text('jkt'),
    activeOrgId: text('active_org_id'),
    projectGrantId: text('project_grant_id'),
    resource: text('resource', { mode: 'json' }).$type<string[]>(),
    authorizationDetails: text('authorization_details', {
      mode: 'json',
    }).$type<AuthorizationDetails[]>(),
    authTime: numCol('auth_time'),
    acr: text('acr'),
    amr: text('amr', { mode: 'json' }).$type<AmrValue[]>(),
    revokedAt: tsMs('revoked_at'),
    familyRevokedAt: tsMs('family_revoked_at'),
    expiresAt: tsMs('expires_at').notNull(),
    absoluteExpiresAt: tsMs('absolute_expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_hash_unq').on(t.tokenHash),
    index('refresh_tokens_tenant_family_idx').on(t.tenantId, t.familyId),
    index('refresh_tokens_tenant_authorization_code_idx').on(t.tenantId, t.authorizationCode),
    index('refresh_tokens_tenant_user_idx').on(t.tenantId, t.userId),
    index('refresh_tokens_active_org_idx').on(t.activeOrgId),
    index('refresh_tokens_project_grant_idx').on(t.projectGrantId),
    index('refresh_tokens_expires_idx').on(t.expiresAt),
  ],
)

// 即时撤销 denylist,只存 jti。
export const accessTokenRevocations = sqliteTable(
  'access_token_revocations',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    jti: text('jti').notNull(),
    clientId: text('client_id').notNull(),
    subject: text('subject'),
    expiresAt: tsMs('expires_at').notNull(),
    revokedAt: tsMs('revoked_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('access_token_revocations_tenant_jti_unq').on(t.tenantId, t.jti),
    index('access_token_revocations_tenant_client_idx').on(t.tenantId, t.clientId),
    index('access_token_revocations_expires_idx').on(t.expiresAt),
  ],
)

// 可被 replay 连锁撤销的 access JWT 元数据;靠 code/family 定位 jti。
export const accessTokenIssuances = sqliteTable(
  'access_token_issuances',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    jti: text('jti').notNull(),
    clientId: text('client_id').notNull(),
    subject: text('subject').notNull(),
    authorizationCode: text('authorization_code'),
    refreshFamilyId: text('refresh_family_id'),
    expiresAt: tsMs('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('access_token_issuances_tenant_jti_unq').on(t.tenantId, t.jti),
    index('access_token_issuances_tenant_code_idx').on(t.tenantId, t.authorizationCode),
    index('access_token_issuances_tenant_family_idx').on(t.tenantId, t.refreshFamilyId),
    index('access_token_issuances_expires_idx').on(t.expiresAt),
  ],
)

export const oauthConsents = sqliteTable(
  'oauth_consents',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    userId: text('user_id').notNull(),
    clientId: text('client_id').notNull(),
    grantedScopes: text('granted_scopes', { mode: 'json' }).$type<string[]>().notNull().default([]),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('oauth_consents_unq').on(t.tenantId, t.userId, t.clientId),
    index('oauth_consents_tenant_user_idx').on(t.tenantId, t.userId),
  ],
)

export const resourceServers = sqliteTable(
  'resource_servers',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    audience: text('audience').notNull(),
    scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull().default([]),
    accessTokenFormat: text('access_token_format').notNull().default('jwt'),
    signingAlg: text('signing_alg').notNull().default('ES256'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('resource_servers_tenant_audience_unq').on(t.tenantId, t.audience),
    index('resource_servers_tenant_idx').on(t.tenantId),
  ],
)
