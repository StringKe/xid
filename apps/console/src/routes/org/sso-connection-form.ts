// 入站 SSO 连接表单状态与请求体之间的转换,以及旧协议在 `_legacy` 下的配置字段。

import { msg } from '@lingui/core/macro'
import type { CreateSsoConnectionInput, SsoConnection, UpdateSsoConnectionInput } from './types'

export type SsoProtocol = CreateSsoConnectionInput['protocol']

// 服务端在连接响应里附带的字段;`legacy_config` 不含密钥,只报告密钥是否已配置。
export type SsoConnectionExtras = {
  legacy_config?: Record<string, unknown>
  trusted_proxy_secret_configured?: boolean
  ldap_gateway_secret_configured?: boolean
  relay_state_url?: string | null
  idp_metadata_source?: 'url' | 'xml' | null
  idp_metadata_refreshed_at?: string | null
  idp_metadata_last_error?: string | null
  idp_metadata_last_error_at?: string | null
}

type ConnectionPayloadExtras = {
  idp_metadata_xml?: string
  relay_state_url?: string | null
}

export type ConnectionCreatePayload = CreateSsoConnectionInput & ConnectionPayloadExtras
export type ConnectionUpdatePayload = UpdateSsoConnectionInput & ConnectionPayloadExtras

export type ConnectionForm = {
  protocol: SsoProtocol
  displayName: string
  idpEntityId: string
  idpSsoUrl: string
  idpSloUrl: string
  idpMetadataUrl: string
  idpMetadataXml: string
  idpCertificate: string
  idpIdAttribute: string
  relayStateUrl: string
  oidcClientId: string
  oidcClientSecret: string
  oidcClientSecretConfigured: boolean
  oidcDiscoveryUrl: string
  jitEnabled: boolean
  wantAuthnResponseSigned: boolean
  wantAssertionsSigned: boolean
  samlClockSkewMs: number
  attributeMapping: string
  roleMapping: string
  legacy: Record<string, unknown>
  legacySecret: string
  legacySecretConfigured: boolean
}

const EMPTY_JSON = '{}'

export const INBOUND_PRESETS = [
  { key: 'okta', label: 'Okta' },
  { key: 'microsoft-entra', label: 'Microsoft Entra ID' },
  { key: 'google-workspace', label: 'Google Workspace' },
  { key: 'onelogin', label: 'OneLogin' },
  { key: 'jumpcloud', label: 'JumpCloud' },
  { key: 'pingone', label: 'PingOne' },
  { key: 'pingfederate', label: 'PingFederate' },
  { key: 'adfs', label: 'AD FS' },
  { key: 'shibboleth', label: 'Shibboleth' },
  { key: 'keycloak', label: 'Keycloak' },
] as const

// legacy 协议是描述文案非产品名,需 lingui。
export const LEGACY_PRESETS = [
  { key: 'ldap', label: msg`LDAP direct bind` },
  { key: 'wsfed', label: msg`WS-Federation` },
  { key: 'swa', label: msg`SWA password vaulting` },
  { key: 'header', label: msg`Header-based SSO` },
] as const

export const LEGACY_PROTOCOLS = new Set<SsoProtocol>(['ldap', 'wsfed', 'swa', 'header'])

// 切换到旧协议时的非密钥默认值;地址类字段没有默认值,必须由管理员填写真实地址。
export const LEGACY_DEFAULTS: Partial<Record<SsoProtocol, Record<string, string>>> = {
  ldap: { ldapGatewayUrl: '', bindDnTemplate: '{username}' },
  wsfed: { wsfedRealm: '', wsfedReplyUrl: '' },
  swa: { swaTargetUrl: '', swaUsernameField: 'username', swaPasswordField: 'password' },
  header: {
    headerEmail: 'X-Remote-Email',
    headerUser: 'X-Remote-User',
    headerGroups: 'X-Remote-Groups',
  },
}

// 只写不回显的密钥在 `_legacy` 下的键名。
export const LEGACY_SECRET_KEY: Partial<Record<SsoProtocol, string>> = {
  ldap: 'ldapGatewaySecret',
  header: 'trustedProxySecret',
}

export const EMPTY_FORM: ConnectionForm = {
  protocol: 'saml',
  displayName: '',
  idpEntityId: '',
  idpSsoUrl: '',
  idpSloUrl: '',
  idpMetadataUrl: '',
  idpMetadataXml: '',
  idpCertificate: '',
  idpIdAttribute: '',
  relayStateUrl: '',
  oidcClientId: '',
  oidcClientSecret: '',
  oidcClientSecretConfigured: false,
  oidcDiscoveryUrl: '',
  jitEnabled: false,
  wantAuthnResponseSigned: false,
  wantAssertionsSigned: true,
  samlClockSkewMs: 180_000,
  attributeMapping: EMPTY_JSON,
  roleMapping: EMPTY_JSON,
  legacy: {},
  legacySecret: '',
  legacySecretConfigured: false,
}

function jsonText(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2)
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value || EMPTY_JSON) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function withLegacyDefaults(form: ConnectionForm, protocol: SsoProtocol): ConnectionForm {
  return {
    ...form,
    protocol,
    legacy: { ...LEGACY_DEFAULTS[protocol] },
    legacySecret: '',
    legacySecretConfigured: false,
  }
}

function legacySecretConfigured(connection: SsoConnection & SsoConnectionExtras): boolean {
  if (connection.type === 'ldap') return connection.ldap_gateway_secret_configured === true
  if (connection.type === 'header') return connection.trusted_proxy_secret_configured === true
  return false
}

export function connectionToForm(connection: SsoConnection & SsoConnectionExtras): ConnectionForm {
  const { idpId, ...mapping } = connection.attribute_mapping
  return {
    protocol: connection.type,
    displayName: connection.display_name ?? '',
    idpEntityId: connection.idp_entity_id ?? '',
    idpSsoUrl: connection.idp_sso_url ?? '',
    idpSloUrl: connection.idp_slo_url ?? '',
    idpMetadataUrl: connection.idp_metadata_url ?? '',
    idpMetadataXml: '',
    idpCertificate: connection.idp_certificates.join('\n'),
    idpIdAttribute: typeof idpId === 'string' ? idpId : '',
    relayStateUrl: connection.relay_state_url ?? '',
    oidcClientId: connection.oidc_client_id ?? '',
    oidcClientSecret: '',
    oidcClientSecretConfigured: connection.oidc_client_secret_configured === true,
    oidcDiscoveryUrl: connection.oidc_discovery_url ?? '',
    jitEnabled: connection.jit_enabled,
    wantAuthnResponseSigned: connection.want_authn_response_signed,
    wantAssertionsSigned: connection.want_assertions_signed,
    samlClockSkewMs: connection.saml_clock_skew_ms,
    attributeMapping: jsonText(mapping),
    roleMapping: jsonText(connection.role_mapping),
    legacy: { ...connection.legacy_config },
    legacySecret: '',
    legacySecretConfigured: legacySecretConfigured(connection),
  }
}

function legacyPayload(form: ConnectionForm): Record<string, unknown> {
  const legacy = Object.fromEntries(Object.entries(form.legacy).filter(([, value]) => value !== ''))
  const secretKey = LEGACY_SECRET_KEY[form.protocol]
  if (secretKey && form.legacySecret) legacy[secretKey] = form.legacySecret
  return legacy
}

function mappingPayload(
  form: ConnectionForm,
  mapping: Record<string, unknown>,
): Record<string, unknown> {
  const visible = Object.fromEntries(
    Object.entries(mapping).filter(([key]) => !key.startsWith('_') && key !== 'idpId'),
  )
  if (LEGACY_PROTOCOLS.has(form.protocol)) return { ...visible, _legacy: legacyPayload(form) }
  const idpId = form.idpIdAttribute.trim()
  return idpId && form.protocol === 'saml' ? { ...visible, idpId } : visible
}

function protocolPayload(
  form: ConnectionForm,
): Omit<
  ConnectionCreatePayload,
  'protocol' | 'display_name' | 'attribute_mapping' | 'role_mapping' | 'jit_enabled'
> {
  if (LEGACY_PROTOCOLS.has(form.protocol)) return { idp_sso_url: form.idpSsoUrl || undefined }
  if (form.protocol === 'saml') {
    const metadataXml = form.idpMetadataXml.trim()
    return {
      idp_entity_id: form.idpEntityId || undefined,
      idp_sso_url: form.idpSsoUrl || undefined,
      idp_slo_url: form.idpSloUrl || null,
      ...(metadataXml
        ? { idp_metadata_xml: metadataXml }
        : { idp_metadata_url: form.idpMetadataUrl || undefined }),
      idp_certificates: form.idpCertificate
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean),
      want_authn_response_signed: form.wantAuthnResponseSigned,
      want_assertions_signed: form.wantAssertionsSigned,
      saml_clock_skew_ms: form.samlClockSkewMs,
      relay_state_url: form.relayStateUrl.trim() || null,
    }
  }
  return {
    oidc_client_id: form.oidcClientId || undefined,
    oidc_client_secret: form.oidcClientSecret || undefined,
    oidc_discovery_url: form.oidcDiscoveryUrl || undefined,
  }
}

export function createPayload(form: ConnectionForm): ConnectionCreatePayload | null {
  const attributeMapping = parseJsonObject(form.attributeMapping)
  const roleMapping = parseJsonObject(form.roleMapping)
  if (!attributeMapping || !roleMapping) return null
  return {
    protocol: form.protocol,
    display_name: form.displayName.trim() || undefined,
    ...protocolPayload(form),
    jit_enabled: form.jitEnabled,
    attribute_mapping: mappingPayload(form, attributeMapping),
    role_mapping: roleMapping,
  }
}

export function updatePayload(form: ConnectionForm): ConnectionUpdatePayload | null {
  const payload = createPayload(form)
  if (!payload) return null
  const { protocol: _protocol, ...rest } = payload
  return { ...rest, display_name: form.displayName.trim() || null }
}

// 列表里显示 IdP 主机名而非完整 URL;非法值原样显示。
export function connectionHost(connection: SsoConnection): string {
  const value = connection.idp_sso_url ?? connection.oidc_discovery_url ?? connection.domain
  if (!value) return ''
  try {
    return new URL(value).host
  } catch {
    return value
  }
}
