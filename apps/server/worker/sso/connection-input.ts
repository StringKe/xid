// 入站 SSO 连接写入(组织路由与 /v1/connections 共用):占位符、内部键、metadata 同步导入与落地页。

import type { schema } from '@xid-kit/db'
import { DEFAULT_SAML_CLOCK_SKEW_MS } from '@xid-kit/saml'
import * as v from 'valibot'
import {
  assertClientMappingKeys,
  assertNoTemplatePlaceholders,
  normalizeRelayStateUrl,
} from './config-input'
import { trustedProxySecretConfigured } from './header-proxy-secret'
import { importIdpMetadata } from './idp-metadata-import'
import { ldapGatewaySecretConfigured } from './ldap-gateway-secret'
import { legacyObject } from './legacy-config'
import { isLegacySsoProtocol } from './legacy-protocols'
import { SAML_METADATA_MAX_BYTES } from './metadata-source'

type ConnectionPatch = Partial<typeof schema.ssoConnections.$inferInsert>

export const idpMetadataXmlSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(SAML_METADATA_MAX_BYTES),
)

export const relayStateUrlSchema = v.nullable(v.pipe(v.string(), v.maxLength(2048)))

export type ConnectionInput = {
  idp_entity_id?: string | undefined
  idp_sso_url?: string | undefined
  idp_slo_url?: string | null | undefined
  idp_metadata_url?: string | undefined
  idp_metadata_xml?: string | undefined
  idp_certificates?: string[] | undefined
  oidc_discovery_url?: string | undefined
  attribute_mapping?: Record<string, unknown> | undefined
  relay_state_url?: string | null | undefined
}

// 每个组织只有一行连接,删除后再新建会复用该行;未在新请求中给出的列一律回到新建时的值,
// 旧连接的 metadata、刷新错误、证书保留记录、密钥与落地页不能延续到新连接。
const FRESH_CONNECTION_COLUMNS = {
  displayName: null,
  idpEntityId: null,
  idpSsoUrl: null,
  idpSloUrl: null,
  idpMetadataUrl: null,
  idpMetadataXml: null,
  idpMetadataRefreshedAt: null,
  idpMetadataLastError: null,
  idpMetadataLastErrorAt: null,
  idpCertificates: [],
  idpCertificateRetirements: null,
  oidcClientId: null,
  oidcClientSecretCiphertext: null,
  oidcDiscoveryUrl: null,
  spCertId: null,
  wantAuthnResponseSigned: true,
  wantAssertionsSigned: true,
  samlClockSkewMs: DEFAULT_SAML_CLOCK_SKEW_MS,
  attributeMapping: {},
  roleMapping: {},
  jitEnabled: true,
  relayStateUrl: null,
} satisfies ConnectionPatch

export function reusedConnectionColumns(patch: ConnectionPatch): ConnectionPatch {
  const given = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
  return { ...FRESH_CONNECTION_COLUMNS, ...given }
}

// `_legacy` 是 legacy 协议的配置容器;其余 `_` 前缀键(预设标记、信封密文)只由服务端写入。
export function assertConnectionInput(body: ConnectionInput): void {
  assertNoTemplatePlaceholders({
    idp_entity_id: body.idp_entity_id,
    idp_sso_url: body.idp_sso_url,
    idp_slo_url: body.idp_slo_url,
    idp_metadata_url: body.idp_metadata_url,
    oidc_discovery_url: body.oidc_discovery_url,
  })
  assertClientMappingKeys(body.attribute_mapping, ['_legacy'])
}

// SAML 连接提交 metadata URL 或 XML 时当场拉取解析,请求体里显式给出的字段优先于 metadata。
export async function samlMetadataPatch(
  protocol: string,
  body: ConnectionInput,
): Promise<ConnectionPatch> {
  if (protocol !== 'saml') return {}
  const imported = await importIdpMetadata({
    url: body.idp_metadata_url,
    xml: body.idp_metadata_xml,
  })
  if (!imported) return {}
  // 上传的 XML 与 metadata URL 二选一:换成 XML 后不再按旧 URL 刷新,换成 URL 后丢弃旧 XML。
  const source =
    body.idp_metadata_xml !== undefined
      ? { idpMetadataXml: body.idp_metadata_xml, idpMetadataUrl: null }
      : { idpMetadataXml: null }
  return {
    ...source,
    idpMetadataRefreshedAt: new Date(),
    idpMetadataLastError: null,
    idpMetadataLastErrorAt: null,
    idpEntityId: body.idp_entity_id ?? imported.idpEntityId,
    idpSsoUrl: body.idp_sso_url ?? imported.idpSsoUrl,
    idpSloUrl: body.idp_slo_url !== undefined ? body.idp_slo_url : imported.idpSloUrl,
    idpCertificates: body.idp_certificates?.length
      ? body.idp_certificates
      : imported.idpCertificates,
  }
}

const LEGACY_SECRET_FIELDS = new Set([
  'trustedProxySecret',
  'trustedProxySecretDigest',
  'ldapGatewaySecret',
])

// 管理响应里的 legacy 配置:去掉密钥与摘要,只回报密钥是否已配置。
export function legacyConfigView(row: typeof schema.ssoConnections.$inferSelect): {
  legacy_config?: Record<string, unknown>
  trusted_proxy_secret_configured?: boolean
  ldap_gateway_secret_configured?: boolean
} {
  if (!isLegacySsoProtocol(row.protocol)) return {}
  const legacy = legacyObject(row.attributeMapping)
  return {
    legacy_config: Object.fromEntries(
      Object.entries(legacy).filter(([key]) => !LEGACY_SECRET_FIELDS.has(key)),
    ),
    trusted_proxy_secret_configured: trustedProxySecretConfigured(row.attributeMapping),
    ldap_gateway_secret_configured: ldapGatewaySecretConfigured(row.attributeMapping),
  }
}

export function relayStatePatch(issuer: string, body: ConnectionInput): ConnectionPatch {
  if (body.relay_state_url === undefined) return {}
  return { relayStateUrl: normalizeRelayStateUrl(issuer, body.relay_state_url) }
}
