// 入站 SSO 连接表单状态与请求体之间的转换,以及模板与旧协议的默认 attribute mapping。

import { msg } from '@lingui/core/macro'
import type { CreateSsoConnectionInput, SsoConnection, UpdateSsoConnectionInput } from './types'

export type SsoProtocol = CreateSsoConnectionInput['protocol']

export type ConnectionForm = {
  protocol: SsoProtocol
  displayName: string
  idpEntityId: string
  idpSsoUrl: string
  idpSloUrl: string
  idpMetadataUrl: string
  idpCertificate: string
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

// 切换到旧协议时预填的 `_legacy` 字段骨架,管理员在 attribute mapping 里改成真实值。
export const LEGACY_ATTRIBUTE_TEMPLATES: Partial<Record<SsoProtocol, Record<string, string>>> = {
  ldap: {
    ldapGatewayUrl: 'https://ldap-gw.example.com/bind',
    bindDnTemplate: '{username}',
  },
  wsfed: {
    wsfedRealm: 'https://tenant.example.com',
    wsfedReplyUrl: 'https://tenant.example.com/sso/wsfed/{connectionId}/callback',
  },
  swa: {
    swaTargetUrl: 'https://app.example.com/login',
    vaultCredentialRef: 'primary',
  },
  header: {
    trustedProxySecret: '',
    headerEmail: 'X-Remote-Email',
    headerUser: 'X-Remote-User',
    headerGroups: 'X-Remote-Groups',
  },
}

export const EMPTY_FORM: ConnectionForm = {
  protocol: 'saml',
  displayName: '',
  idpEntityId: '',
  idpSsoUrl: '',
  idpSloUrl: '',
  idpMetadataUrl: '',
  idpCertificate: '',
  oidcClientId: '',
  oidcClientSecret: '',
  oidcClientSecretConfigured: false,
  oidcDiscoveryUrl: '',
  jitEnabled: false,
  wantAuthnResponseSigned: true,
  wantAssertionsSigned: true,
  samlClockSkewMs: 180_000,
  attributeMapping: EMPTY_JSON,
  roleMapping: EMPTY_JSON,
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

export function connectionToForm(connection: SsoConnection): ConnectionForm {
  return {
    protocol: connection.type,
    displayName: connection.display_name ?? '',
    idpEntityId: connection.idp_entity_id ?? '',
    idpSsoUrl: connection.idp_sso_url ?? '',
    idpSloUrl: connection.idp_slo_url ?? '',
    idpMetadataUrl: connection.idp_metadata_url ?? '',
    idpCertificate: connection.idp_certificates.join('\n'),
    oidcClientId: connection.oidc_client_id ?? '',
    oidcClientSecret: '',
    oidcClientSecretConfigured: connection.oidc_client_secret_configured === true,
    oidcDiscoveryUrl: connection.oidc_discovery_url ?? '',
    jitEnabled: connection.jit_enabled,
    wantAuthnResponseSigned: connection.want_authn_response_signed,
    wantAssertionsSigned: connection.want_assertions_signed,
    samlClockSkewMs: connection.saml_clock_skew_ms,
    attributeMapping: jsonText(connection.attribute_mapping),
    roleMapping: jsonText(connection.role_mapping),
  }
}

function protocolPayload(
  form: ConnectionForm,
): Omit<
  CreateSsoConnectionInput,
  'protocol' | 'display_name' | 'attribute_mapping' | 'role_mapping' | 'jit_enabled'
> {
  if (LEGACY_PROTOCOLS.has(form.protocol)) return { idp_sso_url: form.idpSsoUrl || undefined }
  if (form.protocol === 'saml') {
    return {
      idp_entity_id: form.idpEntityId || undefined,
      idp_sso_url: form.idpSsoUrl || undefined,
      idp_slo_url: form.idpSloUrl || null,
      idp_metadata_url: form.idpMetadataUrl || undefined,
      idp_certificates: form.idpCertificate
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean),
      want_authn_response_signed: form.wantAuthnResponseSigned,
      want_assertions_signed: form.wantAssertionsSigned,
      saml_clock_skew_ms: form.samlClockSkewMs,
    }
  }
  return {
    oidc_client_id: form.oidcClientId || undefined,
    oidc_client_secret: form.oidcClientSecret || undefined,
    oidc_discovery_url: form.oidcDiscoveryUrl || undefined,
  }
}

export function createPayload(form: ConnectionForm): CreateSsoConnectionInput | null {
  const attributeMapping = parseJsonObject(form.attributeMapping)
  const roleMapping = parseJsonObject(form.roleMapping)
  if (!attributeMapping || !roleMapping) return null
  return {
    protocol: form.protocol,
    display_name: form.displayName.trim() || undefined,
    ...protocolPayload(form),
    jit_enabled: form.jitEnabled,
    attribute_mapping: attributeMapping,
    role_mapping: roleMapping,
  }
}

export function updatePayload(form: ConnectionForm): UpdateSsoConnectionInput | null {
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
