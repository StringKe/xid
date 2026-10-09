// Legacy SSO connection settings live in sso_connections.attributeMapping._legacy.
// Secrets never appear here: header secrets are stored as a digest, LDAP gateway secrets as a KEK
// envelope under a top-level internal key, and SWA member credentials in swa_credentials.

export type LegacyConfig = {
  redirectAfterLogin?: string
  trustedProxySecret?: string
  trustedProxySecretDigest?: string
  headerEmail?: string
  headerUser?: string
  headerGroups?: string
  ldapGatewayUrl?: string
  bindDnTemplate?: string
  wsfedRealm?: string
  wsfedReplyUrl?: string
  wsfedAllowIdpInitiated?: boolean
  swaTargetUrl?: string
  swaUsernameField: string
  swaPasswordField: string
}

export const DEFAULT_SWA_USERNAME_FIELD = 'username'
export const DEFAULT_SWA_PASSWORD_FIELD = 'password'

export function legacyObject(
  mapping: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const value = mapping?.['_legacy']
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
}

function optionalString(legacy: Record<string, unknown>, key: string): string | undefined {
  const value = legacy[key]
  return typeof value === 'string' ? value : undefined
}

export function readLegacyConfigFromMapping(
  attributeMapping: Record<string, unknown> | null | undefined,
): LegacyConfig {
  const legacy = legacyObject(attributeMapping)
  return {
    redirectAfterLogin: optionalString(legacy, 'redirectAfterLogin'),
    trustedProxySecret: optionalString(legacy, 'trustedProxySecret'),
    trustedProxySecretDigest: optionalString(legacy, 'trustedProxySecretDigest'),
    headerEmail: optionalString(legacy, 'headerEmail') ?? 'X-Remote-Email',
    headerUser: optionalString(legacy, 'headerUser') ?? 'X-Remote-User',
    headerGroups: optionalString(legacy, 'headerGroups') ?? 'X-Remote-Groups',
    ldapGatewayUrl: optionalString(legacy, 'ldapGatewayUrl'),
    bindDnTemplate: optionalString(legacy, 'bindDnTemplate'),
    wsfedRealm: optionalString(legacy, 'wsfedRealm'),
    wsfedReplyUrl: optionalString(legacy, 'wsfedReplyUrl'),
    wsfedAllowIdpInitiated:
      typeof legacy['wsfedAllowIdpInitiated'] === 'boolean'
        ? legacy['wsfedAllowIdpInitiated']
        : false,
    swaTargetUrl: optionalString(legacy, 'swaTargetUrl'),
    swaUsernameField: optionalString(legacy, 'swaUsernameField') || DEFAULT_SWA_USERNAME_FIELD,
    swaPasswordField: optionalString(legacy, 'swaPasswordField') || DEFAULT_SWA_PASSWORD_FIELD,
  }
}
