// 组织企业 SSO 连接的 Console 响应形状:IdP 侧要登记的本端地址、可见映射与 legacy 配置。

import type { schema } from '@xid-kit/db'
import type { TenantContext } from '@xid-kit/types'
import { visibleMappingKeys } from '../sso/config-input'
import { legacyConfigView } from '../sso/connection-input'
import { isInboundSsoProtocol } from '../sso/legacy-shared'
import { oidcClientSecretConfigured } from '../sso/oidc-client-secret'
import { inboundPresetDisplayName, presetKeyFromAttributeMapping } from '../sso/provider-presets'
import { acsUrl, sloUrl, spEntityId } from '../sso/saml-connection'
import { toIso } from './org-shared'

// IdP 侧要填写的本端地址。OIDC callback 跟随用户发起登录的 origin(oidc-rp.ts),
// 因此列出实例 issuer、租户主机和 Hosted Auth origin,管理员需要全部登记到 IdP。
function ssoServiceProviderEndpoints(
  tenant: TenantContext,
  row: typeof schema.ssoConnections.$inferSelect,
) {
  if (row.protocol === 'saml') {
    return {
      sp_entity_id: spEntityId(tenant, row.id),
      acs_url: acsUrl(tenant, row.id),
      sp_metadata_url: `${tenant.issuer}/sso/saml/${row.id}/metadata`,
      slo_url: sloUrl(tenant, row.id),
    }
  }
  if (row.protocol !== 'oidc') return {}
  const origins = new Set([
    new URL(tenant.issuer).origin,
    `https://${tenant.rpId}`,
    ...(tenant.hostedAuthOrigin ? [new URL(tenant.hostedAuthOrigin).origin] : []),
  ])
  return {
    oidc_callback_urls: [...origins].map((origin) => `${origin}/sso/oidc/${row.id}/callback`),
  }
}

export function toConsoleSsoConnection(
  tenant: TenantContext,
  row: typeof schema.ssoConnections.$inferSelect,
) {
  const presetName = inboundPresetDisplayName(presetKeyFromAttributeMapping(row.attributeMapping))
  return {
    id: row.id,
    name:
      row.displayName ??
      presetName ??
      row.idpEntityId ??
      row.oidcDiscoveryUrl ??
      row.protocol.toUpperCase(),
    display_name: row.displayName,
    type: isInboundSsoProtocol(row.protocol) ? row.protocol : 'saml',
    domain: row.idpSsoUrl ?? row.oidcDiscoveryUrl ?? '',
    idp_entity_id: row.idpEntityId,
    idp_sso_url: row.idpSsoUrl,
    idp_slo_url: row.idpSloUrl,
    idp_metadata_url: row.idpMetadataUrl,
    idp_metadata_source: row.idpMetadataXml ? 'xml' : row.idpMetadataUrl ? 'url' : null,
    idp_metadata_refreshed_at: toIso(row.idpMetadataRefreshedAt),
    idp_metadata_last_error: row.idpMetadataLastError,
    idp_metadata_last_error_at: toIso(row.idpMetadataLastErrorAt),
    idp_certificates: row.idpCertificates,
    oidc_client_id: row.oidcClientId,
    oidc_discovery_url: row.oidcDiscoveryUrl,
    oidc_client_secret_configured: oidcClientSecretConfigured(row),
    want_authn_response_signed: row.wantAuthnResponseSigned,
    want_assertions_signed: row.wantAssertionsSigned,
    saml_clock_skew_ms: row.samlClockSkewMs,
    attribute_mapping: visibleMappingKeys(row.attributeMapping),
    ...legacyConfigView(row),
    relay_state_url: row.relayStateUrl,
    role_mapping: row.roleMapping,
    jit_enabled: row.jitEnabled,
    status: row.status === 'active' ? 'active' : 'inactive',
    ...ssoServiceProviderEndpoints(tenant, row),
    createdAt: toIso(row.createdAt) ?? '',
  }
}
