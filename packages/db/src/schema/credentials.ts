// 凭证与认证实体(见 08 章 12):passwords / password_history / password_reset_tokens /
// verification_tokens / passkey_credentials / mfa_factors / backup_codes / trusted_devices /
// metering_outbox。
// 所有 token/secret 类一律只存哈希/密文,明文展示一次(见 18 决策、各 rule)。私钥永不入库。

import { sql } from 'drizzle-orm'
import { blob, index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { boolCol, createdAt, numCol, tenantId, timestamps, tsMs } from './common'

// 12.1 passwords(密码哈希,1:1 当前密码)
export const passwords = sqliteTable(
  'passwords',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    userId: text('user_id').notNull(),
    hash: text('hash').notNull(),
    algo: text('algo').notNull().default('argon2id'),
    pepperVersion: numCol('pepper_version').notNull(),
    reuseTag: text('reuse_tag'),
    breached: boolCol('breached').notNull().default(false),
    breachCheckedAt: tsMs('breach_checked_at'),
    ...timestamps(),
  },
  (t) => [uniqueIndex('passwords_user_unq').on(t.userId)],
)

// 12.2 password_history(密码历史,拒绝重用)
export const passwordHistory = sqliteTable(
  'password_history',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    userId: text('user_id').notNull(),
    hash: text('hash').notNull(),
    reuseTag: text('reuse_tag'),
    createdAt: createdAt(),
  },
  (t) => [index('password_history_tenant_user_idx').on(t.tenantId, t.userId, t.createdAt)],
)

// 12.3 password_reset_tokens(重置令牌,仅存哈希)
export const passwordResetTokens = sqliteTable(
  'password_reset_tokens',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    userId: text('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    purpose: text('purpose').notNull().default('password_reset'),
    consumedAt: tsMs('consumed_at'),
    expiresAt: tsMs('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('password_reset_tokens_hash_unq').on(t.tokenHash),
    index('password_reset_tokens_tenant_user_idx').on(t.tenantId, t.userId),
  ],
)

// 12.3 注:verification_tokens(magic link / OTP 共用短期 token 表;OtpCode/MagicLinkToken)
export const verificationTokens = sqliteTable(
  'verification_tokens',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    userId: text('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    codeHash: text('code_hash'),
    flowContext: text('flow_context'),
    channel: text('channel'),
    purpose: text('purpose').notNull(),
    attemptCount: numCol('attempt_count').notNull().default(0),
    consumedAt: tsMs('consumed_at'),
    expiresAt: tsMs('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('verification_tokens_hash_unq').on(t.tokenHash),
    index('verification_tokens_tenant_user_idx').on(t.tenantId, t.userId),
    uniqueIndex('verification_tokens_active_credential_unq')
      .on(t.tenantId, t.userId, t.purpose, sql`coalesce(${t.channel}, '')`)
      .where(sql`${t.consumedAt} IS NULL AND ${t.purpose} IN ('magic_link', 'otp')`),
  ],
)

// 12.4 passkey_credentials(WebAuthn 凭证,COSE 原始字节存 blob,私钥永不入库)
export const passkeyCredentials = sqliteTable(
  'passkey_credentials',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    userId: text('user_id').notNull(),
    credentialId: text('credential_id').notNull(),
    publicKey: blob('public_key', { mode: 'buffer' }).notNull(),
    coseAlg: numCol('cose_alg').notNull(),
    aaguid: blob('aaguid', { mode: 'buffer' }).notNull(),
    signCount: numCol('sign_count').notNull().default(0),
    transports: text('transports', { mode: 'json' }).$type<string[]>().notNull().default([]),
    credentialDeviceType: text('credential_device_type').notNull(),
    backedUp: boolCol('backed_up').notNull().default(false),
    deviceName: text('device_name'),
    attestationFmt: text('attestation_fmt').notNull().default('none'),
    enterpriseAttestationVerified: boolCol('enterprise_attestation_verified')
      .notNull()
      .default(false),
    lastUsedAt: tsMs('last_used_at'),
    revokedAt: tsMs('revoked_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('passkey_credentials_tenant_cred_unq').on(t.tenantId, t.credentialId),
    index('passkey_credentials_tenant_user_idx').on(t.tenantId, t.userId),
    index('passkey_credentials_tenant_user_active_idx')
      .on(t.tenantId, t.userId, t.id)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
)

// 12.5 mfa_factors(MFA 因子;TOTP secret 信封加密存 blob)
export const mfaFactors = sqliteTable(
  'mfa_factors',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    userId: text('user_id').notNull(),
    factorType: text('factor_type').notNull(),
    status: text('status').notNull().default('pending'),
    secretCiphertext: blob('secret_ciphertext', { mode: 'buffer' }),
    target: text('target'),
    passkeyCredentialId: text('passkey_credential_id'),
    isDefault: boolCol('is_default').notNull().default(false),
    lastUsedAt: tsMs('last_used_at'),
    activatedAt: tsMs('activated_at'),
    ...timestamps(),
  },
  (t) => [
    index('mfa_factors_tenant_user_idx').on(t.tenantId, t.userId),
    index('mfa_factors_tenant_user_type_idx').on(t.tenantId, t.userId, t.factorType),
  ],
)

// 12.6 backup_codes(一次性恢复码,批次管理)
export const backupCodes = sqliteTable(
  'backup_codes',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    userId: text('user_id').notNull(),
    batchId: text('batch_id').notNull(),
    codeHash: text('code_hash').notNull(),
    used: boolCol('used').notNull().default(false),
    usedAt: tsMs('used_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('backup_codes_tenant_user_batch_idx').on(t.tenantId, t.userId, t.batchId),
    index('backup_codes_tenant_user_used_idx').on(t.tenantId, t.userId, t.used),
    index('backup_codes_tenant_code_idx').on(t.tenantId, t.codeHash),
  ],
)

// 12.7 trusted_devices(记住的设备,token/指纹存哈希)
export const trustedDevices = sqliteTable(
  'trusted_devices',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    userId: text('user_id').notNull(),
    deviceTokenHash: text('device_token_hash').notNull(),
    fingerprintHash: text('fingerprint_hash').notNull(),
    deviceName: text('device_name'),
    lastSeenIp: text('last_seen_ip'),
    lastSeenAt: tsMs('last_seen_at'),
    expiresAt: tsMs('expires_at').notNull(),
    revokedAt: tsMs('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('trusted_devices_tenant_user_idx').on(t.tenantId, t.userId),
    index('trusted_devices_tenant_user_active_idx')
      .on(t.tenantId, t.userId, t.expiresAt, t.id)
      .where(sql`${t.revokedAt} IS NULL`),
    index('trusted_devices_tenant_token_idx').on(t.tenantId, t.deviceTokenHash),
  ],
)

// 12.8 metering_outbox:认证成功计量的持久恢复队列。
// 同一租户用户同日只保留一个待恢复事件，Queue 至少一次投递不会放大 DAU 事实。
export const meteringOutbox = sqliteTable(
  'metering_outbox',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    userId: text('user_id').notNull(),
    day: text('day').notNull(),
    occurredAt: tsMs('occurred_at').notNull(),
    attemptCount: numCol('attempt_count').notNull().default(0),
    lastErrorCode: text('last_error_code'),
    deliveredAt: tsMs('delivered_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('metering_outbox_tenant_user_day_unq').on(t.tenantId, t.userId, t.day),
    index('metering_outbox_recovery_idx').on(t.deliveredAt, t.createdAt),
  ],
)
