// 企业 SSO + 密钥实体(见 08 章 16):sso_connections / cert_store / instance_signing_keys /
// saml_service_providers。证书/签名私钥信封加密(iv/ciphertext/tag 拆三 blob,见 16.2/16.3 决策)。
// 私钥明文永不入库(见 signing-keys rule)。

import { sql } from 'drizzle-orm'
import { blob, index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { boolCol, numCol, tenantId, timestamps, tsMs } from './common'

// 16.1 sso_connections(per-org 上游 IdP 连接,1:1 org)
export const ssoConnections = sqliteTable(
  'sso_connections',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    orgId: text('org_id').notNull(),
    protocol: text('protocol').notNull(),
    idpEntityId: text('idp_entity_id'),
    idpSsoUrl: text('idp_sso_url'),
    idpSloUrl: text('idp_slo_url'),
    idpMetadataUrl: text('idp_metadata_url'),
    idpCertificates: text('idp_certificates', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    oidcClientId: text('oidc_client_id'),
    oidcClientSecretCiphertext: blob('oidc_client_secret_ciphertext', { mode: 'buffer' }),
    oidcDiscoveryUrl: text('oidc_discovery_url'),
    spCertId: text('sp_cert_id'),
    wantAuthnResponseSigned: boolCol('want_authn_response_signed').notNull().default(true),
    wantAssertionsSigned: boolCol('want_assertions_signed').notNull().default(true),
    attributeMapping: text('attribute_mapping', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    roleMapping: text('role_mapping', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    jitEnabled: boolCol('jit_enabled').notNull().default(true),
    relayStateUrl: text('relay_state_url'),
    status: text('status').notNull().default('active'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('sso_connections_org_unq').on(t.orgId),
    index('sso_connections_tenant_idx').on(t.tenantId),
    index('sso_connections_tenant_status_id_idx').on(t.tenantId, t.status, t.id),
    index('sso_connections_tenant_org_status_id_idx').on(t.tenantId, t.orgId, t.status, t.id),
    index('sso_connections_tenant_status_idx').on(t.tenantId, t.status),
  ],
)

// 16.2 cert_store(SAML 证书/私钥,信封加密,iv/ciphertext/tag 拆三字段)
export const certStore = sqliteTable(
  'cert_store',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    usage: text('usage').notNull(),
    certificate: text('certificate').notNull(),
    privateKeyIv: blob('private_key_iv', { mode: 'buffer' }).notNull(),
    privateKeyCiphertext: blob('private_key_ciphertext', { mode: 'buffer' }).notNull(),
    privateKeyTag: blob('private_key_tag', { mode: 'buffer' }).notNull(),
    kekVersion: numCol('kek_version').notNull(),
    status: text('status').notNull().default('active'),
    notBefore: tsMs('not_before'),
    notAfter: tsMs('not_after'),
    fingerprint: text('fingerprint').notNull(),
    ...timestamps(),
  },
  (t) => [
    index('cert_store_tenant_usage_status_idx').on(t.tenantId, t.usage, t.status),
    index('cert_store_tenant_usage_status_id_idx').on(t.tenantId, t.usage, t.status, t.id),
  ],
)

// 16.3 instance_signing_keys(instance issuer 默认签发密钥;私钥信封加密拆三 blob)
export const instanceSigningKeys = sqliteTable(
  'instance_signing_keys',
  {
    id: text('id').primaryKey(),
    instanceId: text('instance_id').notNull(),
    kid: text('kid').notNull(),
    alg: text('alg').notNull().default('ES256'),
    publicKeyJwk: text('public_key_jwk', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    privateKeyIv: blob('private_key_iv', { mode: 'buffer' }).notNull(),
    privateKeyCiphertext: blob('private_key_ciphertext', { mode: 'buffer' }).notNull(),
    privateKeyTag: blob('private_key_tag', { mode: 'buffer' }).notNull(),
    kekVersion: numCol('kek_version').notNull(),
    status: text('status').notNull().default('active'),
    activatedAt: tsMs('activated_at'),
    retireAfter: tsMs('retire_after'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('instance_signing_keys_instance_kid_unq').on(t.instanceId, t.kid),
    uniqueIndex('instance_signing_keys_instance_next_unq')
      .on(t.instanceId)
      .where(sql`${t.status} = 'next'`),
    index('instance_signing_keys_instance_status_idx').on(t.instanceId, t.status),
  ],
)

// 16.8 saml_service_providers(XID 作 IdP 时下游 SP 注册,P2)
export const samlServiceProviders = sqliteTable(
  'saml_service_providers',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    orgId: text('org_id').notNull(),
    spEntityId: text('sp_entity_id').notNull(),
    acsUrl: text('acs_url').notNull(),
    sloUrl: text('slo_url'),
    sloBinding: text('slo_binding').notNull().default('redirect'),
    spCertificates: text('sp_certificates', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    attributeMapping: text('attribute_mapping', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    nameIdFormat: text('name_id_format')
      .notNull()
      .default('urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress'),
    idpSigningCertId: text('idp_signing_cert_id'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('saml_service_providers_entity_unq').on(t.tenantId, t.orgId, t.spEntityId),
    index('saml_service_providers_org_idx').on(t.tenantId, t.orgId),
  ],
)

// SAML SLO SessionIndex / NameID -> session 映射(寿命对齐 session,不走 ChallengeStore 10min TTL)。
export const samlSessionBindings = sqliteTable(
  'saml_session_bindings',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    direction: text('direction').notNull(),
    scopeId: text('scope_id').notNull(),
    sessionIndex: text('session_index').notNull(),
    userId: text('user_id').notNull(),
    sessionId: text('session_id').notNull(),
    nameId: text('name_id'),
    nameIdFormat: text('name_id_format'),
    expiresAt: tsMs('expires_at').notNull(),
    consumedAt: tsMs('consumed_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('saml_session_bindings_lookup_unq').on(
      t.tenantId,
      t.direction,
      t.scopeId,
      t.sessionIndex,
    ),
    index('saml_session_bindings_user_session_idx').on(
      t.tenantId,
      t.userId,
      t.sessionId,
      t.direction,
    ),
    index('saml_session_bindings_tenant_user_session_direction_id_idx').on(
      t.tenantId,
      t.userId,
      t.sessionId,
      t.direction,
      t.id,
    ),
    index('saml_session_bindings_name_idx').on(t.tenantId, t.direction, t.scopeId, t.nameId),
  ],
)
