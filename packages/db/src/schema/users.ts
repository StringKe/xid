// 用户与身份实体(见 08 章 11):users / user_emails / user_phones / user_identities / gdpr_consents。
// 租户内唯一约束(email/phone/external_id/username + provider+provider_user_id)第一列必为 tenant_id(见 9.5)。

import { sql } from 'drizzle-orm'
import { blob, index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { boolCol, numCol, tenantId, timestamps, tsMs } from './common'

// users.provisioned_by 取值登记:text 字段无枚举,新值在此登记后才允许写入。
// 既有值:hosted_password / hosted_passwordless / hosted_passkey / jit_sso / bootstrap / scim。
// hosted_passkey:guest 转正经 passkey 注册仪式(passkey 无独立建号路径,仅转正使用)。
export const USER_PROVISIONED_BY_ANONYMOUS = 'anonymous'

// 11.1 users(平台级用户主体;即 JWT sub)
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    username: text('username'),
    externalId: text('external_id'),
    primaryEmailId: text('primary_email_id'),
    pendingEmail: text('pending_email'),
    primaryPhoneId: text('primary_phone_id'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    locale: text('locale'),
    timezone: text('timezone'),
    publicMetadata: text('public_metadata', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    privateMetadata: text('private_metadata', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    unsafeMetadata: text('unsafe_metadata', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    customAttributes: text('custom_attributes', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: text('status').notNull().default('active'),
    passwordChangeRequired: boolCol('password_change_required').notNull().default(false),
    isNewUser: boolCol('is_new_user').notNull().default(true),
    profileCompletionStatus: text('profile_completion_status').notNull().default('incomplete'),
    lockoutUntil: tsMs('lockout_until'),
    failedLoginCount: numCol('failed_login_count').notNull().default(0),
    lastLoginAt: tsMs('last_login_at'),
    mergedIntoUserId: text('merged_into_user_id'),
    provisionedBy: text('provisioned_by'),
    deletedAt: tsMs('deleted_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('users_tenant_username_unq')
      .on(t.tenantId, t.username)
      .where(sql`${t.deletedAt} IS NULL AND ${t.status} <> 'deleted'`),
    uniqueIndex('users_tenant_external_id_unq')
      .on(t.tenantId, t.externalId)
      .where(sql`${t.deletedAt} IS NULL AND ${t.status} <> 'deleted'`),
    index('users_username_active_lookup_idx')
      .on(t.username, t.tenantId)
      .where(sql`${t.deletedAt} IS NULL AND ${t.status} = 'active'`),
    index('users_external_id_active_lookup_idx')
      .on(t.externalId, t.tenantId)
      .where(sql`${t.deletedAt} IS NULL AND ${t.status} = 'active'`),
    index('users_active_cursor_idx')
      .on(t.tenantId, t.id)
      .where(sql`${t.deletedAt} IS NULL AND ${t.status} <> 'deleted'`),
    index('users_active_global_idx')
      .on(t.id)
      .where(sql`${t.deletedAt} IS NULL AND ${t.status} <> 'deleted'`),
    index('users_tenant_status_idx').on(t.tenantId, t.status),
    index('users_tenant_created_idx').on(t.tenantId, t.createdAt),
    index('users_primary_email_idx').on(t.primaryEmailId),
    index('users_merged_into_idx').on(t.mergedIntoUserId),
  ],
)

// 11.2 user_emails(多值邮箱,租户内唯一)
export const userEmails = sqliteTable(
  'user_emails',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    userId: text('user_id').notNull(),
    email: text('email').notNull(),
    verified: boolCol('verified').notNull().default(false),
    verificationStatus: text('verification_status').notNull().default('unverified'),
    isPrimary: boolCol('is_primary').notNull().default(false),
    verifiedAt: tsMs('verified_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('user_emails_tenant_email_unq').on(t.tenantId, t.email),
    index('user_emails_email_lookup_idx').on(t.email, t.userId, t.tenantId),
    index('user_emails_user_primary_idx').on(t.userId, t.isPrimary),
    index('user_emails_tenant_user_primary_created_idx').on(
      t.tenantId,
      t.userId,
      t.isPrimary,
      t.createdAt,
      t.id,
    ),
    index('user_emails_tenant_user_idx').on(t.tenantId, t.userId),
  ],
)

// 11.3 user_phones(多值手机,E.164,租户内唯一)
export const userPhones = sqliteTable(
  'user_phones',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    userId: text('user_id').notNull(),
    phone: text('phone').notNull(),
    verified: boolCol('verified').notNull().default(false),
    verificationStatus: text('verification_status').notNull().default('unverified'),
    isPrimary: boolCol('is_primary').notNull().default(false),
    verifiedAt: tsMs('verified_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('user_phones_tenant_phone_unq').on(t.tenantId, t.phone),
    index('user_phones_phone_lookup_idx').on(t.phone, t.userId, t.tenantId),
    index('user_phones_tenant_user_idx').on(t.tenantId, t.userId),
  ],
)

// 11.4 user_identities(登录方式关联 + 社交绑定;token 信封加密存 blob)
export const userIdentities = sqliteTable(
  'user_identities',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    userId: text('user_id').notNull(),
    identityType: text('identity_type').notNull(),
    provider: text('provider'),
    providerUserId: text('provider_user_id'),
    accessTokenCiphertext: blob('access_token_ciphertext', { mode: 'buffer' }),
    refreshTokenCiphertext: blob('refresh_token_ciphertext', { mode: 'buffer' }),
    tokenExpiresAt: tsMs('token_expires_at'),
    scopes: text('scopes', { mode: 'json' }).$type<string[]>(),
    profileRaw: text('profile_raw', { mode: 'json' }).$type<Record<string, unknown>>(),
    lastUsedAt: tsMs('last_used_at'),
    revokedAt: tsMs('revoked_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('user_identities_provider_unq').on(t.tenantId, t.provider, t.providerUserId),
    index('user_identities_tenant_user_idx').on(t.tenantId, t.userId),
    index('user_identities_tenant_user_type_active_idx')
      .on(t.tenantId, t.userId, t.identityType, t.id)
      .where(sql`${t.revokedAt} IS NULL`),
    index('user_identities_tenant_type_idx').on(t.tenantId, t.identityType),
  ],
)

// 11.5 gdpr_consents(GDPR 数据处理同意,与 oauth_consents 区分)
export const gdprConsents = sqliteTable(
  'gdpr_consents',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    userId: text('user_id').notNull(),
    consentType: text('consent_type').notNull(),
    granted: boolCol('granted').notNull(),
    sourceIp: text('source_ip'),
    grantedAt: tsMs('granted_at').notNull(),
    ...timestamps(),
  },
  (t) => [index('gdpr_consents_tenant_user_type_idx').on(t.tenantId, t.userId, t.consentType)],
)
