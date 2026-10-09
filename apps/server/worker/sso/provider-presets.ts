// Enterprise IdP and downstream SaaS preset definitions for console wizards and L3 smoke fixtures.
// Values follow each vendor's public documentation. `{...}` segments are templates shown to the
// admin; they are never stored, and every write path rejects a value that still contains one.
// Real admin L4 is still required before production-supported claims.

export type InboundIdpPresetKey =
  | 'okta'
  | 'microsoft-entra'
  | 'google-workspace'
  | 'onelogin'
  | 'jumpcloud'
  | 'pingone'
  | 'pingfederate'
  | 'adfs'
  | 'shibboleth'
  | 'keycloak'

export type LegacyInboundPresetKey = 'ldap' | 'wsfed' | 'swa' | 'header'

export type OutboundSaasPresetKey =
  | 'slack'
  | 'github-enterprise'
  | 'microsoft-enterprise-app'
  | 'atlassian'
  | 'salesforce'
  | 'zoom'

export type LegacyInboundPreset = {
  key: LegacyInboundPresetKey
  displayName: string
  protocol: LegacyInboundPresetKey
  attributeMapping: Record<string, unknown>
  roleMapping: Record<string, string>
  jitEnabled: boolean
  runbookPath: string
}

// Every inbound preset is SAML only. OIDC connections use the generic discovery flow.
export type InboundIdpPreset = {
  key: InboundIdpPresetKey
  displayName: string
  protocol: 'saml'
  // Undefined when the vendor only offers a metadata file download; the admin uploads the XML.
  idpMetadataUrlTemplate?: string
  attributeMapping: Record<string, string>
  roleMapping: Record<string, string>
  jitEnabled: boolean
  wantAuthnResponseSigned: boolean
  wantAssertionsSigned: boolean
  runbookPath: string
}

export type OutboundSaasPreset = {
  key: OutboundSaasPresetKey
  displayName: string
  protocol: 'saml' | 'oidc' | 'saml-oidc'
  spEntityId: string
  acsUrlPlaceholder: string
  sloUrl?: string | null
  attributeMapping: Record<string, string>
  nameIdFormat: string
  oidcRedirectPlaceholder?: string
  runbookPath: string
}

const DEFAULT_ROLE_MAPPING: Record<string, string> = {}

const EMAIL_ADDRESS_NAMEID = 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress'

const WS_CLAIMS = {
  email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  firstName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
  lastName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
} as const

// Legacy presets carry only non-secret defaults; gateway, target and realm URLs must be entered.
export const LEGACY_INBOUND_PRESETS: Record<LegacyInboundPresetKey, LegacyInboundPreset> = {
  ldap: {
    key: 'ldap',
    displayName: 'LDAP direct bind',
    protocol: 'ldap',
    attributeMapping: { _legacy: { bindDnTemplate: '{username}' } },
    roleMapping: DEFAULT_ROLE_MAPPING,
    jitEnabled: true,
    runbookPath: 'docs/protocols/README.md',
  },
  wsfed: {
    key: 'wsfed',
    displayName: 'WS-Federation',
    protocol: 'wsfed',
    attributeMapping: { _legacy: {} },
    roleMapping: DEFAULT_ROLE_MAPPING,
    jitEnabled: true,
    runbookPath: 'docs/protocols/README.md',
  },
  swa: {
    key: 'swa',
    displayName: 'SWA password vaulting',
    protocol: 'swa',
    attributeMapping: { _legacy: { swaUsernameField: 'username', swaPasswordField: 'password' } },
    roleMapping: DEFAULT_ROLE_MAPPING,
    jitEnabled: true,
    runbookPath: 'docs/protocols/README.md',
  },
  header: {
    key: 'header',
    displayName: 'Header-based SSO',
    protocol: 'header',
    attributeMapping: {
      _legacy: {
        headerEmail: 'X-Remote-Email',
        headerUser: 'X-Remote-User',
        headerGroups: 'X-Remote-Groups',
      },
    },
    roleMapping: DEFAULT_ROLE_MAPPING,
    jitEnabled: true,
    runbookPath: 'docs/protocols/README.md',
  },
}

// Signature layers follow each IdP's default: most sign only the Assertion, Keycloak signs only
// the document (Response). Okta and PingOne keep both flags, which accepts a valid signature on
// either layer, until a live tenant confirms their defaults.
export const INBOUND_IDP_PRESETS: Record<InboundIdpPresetKey, InboundIdpPreset> = {
  okta: {
    key: 'okta',
    displayName: 'Okta',
    protocol: 'saml',
    idpMetadataUrlTemplate: 'https://{oktaDomain}/app/{appId}/sso/saml/metadata',
    attributeMapping: { email: 'email', firstName: 'firstName', lastName: 'lastName' },
    roleMapping: DEFAULT_ROLE_MAPPING,
    jitEnabled: true,
    wantAuthnResponseSigned: true,
    wantAssertionsSigned: true,
    runbookPath: 'docs/protocols/runbooks/okta.md',
  },
  'microsoft-entra': {
    key: 'microsoft-entra',
    displayName: 'Microsoft Entra ID',
    protocol: 'saml',
    // App-scoped metadata: the enterprise application signing certificate is configured per app.
    idpMetadataUrlTemplate:
      'https://login.microsoftonline.com/{tenantId}/federationmetadata/2007-06/federationmetadata.xml?appid={appId}',
    attributeMapping: {
      ...WS_CLAIMS,
      idpId: 'http://schemas.microsoft.com/identity/claims/objectidentifier',
    },
    roleMapping: DEFAULT_ROLE_MAPPING,
    jitEnabled: true,
    wantAuthnResponseSigned: false,
    wantAssertionsSigned: true,
    runbookPath: 'docs/protocols/runbooks/microsoft-entra-id.md',
  },
  'google-workspace': {
    key: 'google-workspace',
    displayName: 'Google Workspace',
    protocol: 'saml',
    attributeMapping: { email: 'email', firstName: 'firstName', lastName: 'lastName' },
    roleMapping: DEFAULT_ROLE_MAPPING,
    jitEnabled: true,
    wantAuthnResponseSigned: false,
    wantAssertionsSigned: true,
    runbookPath: 'docs/protocols/runbooks/google-workspace.md',
  },
  onelogin: {
    key: 'onelogin',
    displayName: 'OneLogin',
    protocol: 'saml',
    idpMetadataUrlTemplate: 'https://app.onelogin.com/saml/metadata/{appId}',
    attributeMapping: {
      email: 'User.email',
      firstName: 'User.FirstName',
      lastName: 'User.LastName',
    },
    roleMapping: DEFAULT_ROLE_MAPPING,
    jitEnabled: true,
    wantAuthnResponseSigned: false,
    wantAssertionsSigned: true,
    runbookPath: 'docs/protocols/runbooks/onelogin.md',
  },
  jumpcloud: {
    key: 'jumpcloud',
    displayName: 'JumpCloud',
    protocol: 'saml',
    attributeMapping: { email: 'email', firstName: 'firstname', lastName: 'lastname' },
    roleMapping: DEFAULT_ROLE_MAPPING,
    jitEnabled: true,
    wantAuthnResponseSigned: false,
    wantAssertionsSigned: true,
    runbookPath: 'docs/protocols/runbooks/jumpcloud.md',
  },
  pingone: {
    key: 'pingone',
    displayName: 'PingOne',
    protocol: 'saml',
    idpMetadataUrlTemplate: 'https://auth.pingone.com/{envId}/saml20/metadata/{appId}',
    attributeMapping: { email: 'email', firstName: 'givenName', lastName: 'surname' },
    roleMapping: DEFAULT_ROLE_MAPPING,
    jitEnabled: true,
    wantAuthnResponseSigned: true,
    wantAssertionsSigned: true,
    runbookPath: 'docs/protocols/runbooks/pingone.md',
  },
  pingfederate: {
    key: 'pingfederate',
    displayName: 'PingFederate',
    protocol: 'saml',
    idpMetadataUrlTemplate: 'https://{host}/pf/federation_metadata.ping',
    attributeMapping: { email: 'email', firstName: 'givenName', lastName: 'surname' },
    roleMapping: DEFAULT_ROLE_MAPPING,
    jitEnabled: true,
    wantAuthnResponseSigned: false,
    wantAssertionsSigned: true,
    runbookPath: 'docs/protocols/runbooks/pingfederate.md',
  },
  adfs: {
    key: 'adfs',
    displayName: 'AD FS',
    protocol: 'saml',
    idpMetadataUrlTemplate: 'https://{host}/FederationMetadata/2007-06/FederationMetadata.xml',
    attributeMapping: { ...WS_CLAIMS },
    roleMapping: DEFAULT_ROLE_MAPPING,
    jitEnabled: true,
    wantAuthnResponseSigned: false,
    wantAssertionsSigned: true,
    runbookPath: 'docs/protocols/runbooks/adfs.md',
  },
  shibboleth: {
    key: 'shibboleth',
    displayName: 'Shibboleth',
    protocol: 'saml',
    idpMetadataUrlTemplate: 'https://{host}/idp/shibboleth',
    attributeMapping: { email: 'mail', firstName: 'givenName', lastName: 'sn' },
    roleMapping: DEFAULT_ROLE_MAPPING,
    jitEnabled: true,
    wantAuthnResponseSigned: false,
    wantAssertionsSigned: true,
    runbookPath: 'docs/protocols/runbooks/shibboleth.md',
  },
  keycloak: {
    key: 'keycloak',
    displayName: 'Keycloak',
    protocol: 'saml',
    idpMetadataUrlTemplate: 'https://{host}/realms/{realm}/protocol/saml/descriptor',
    attributeMapping: { email: 'email', firstName: 'firstName', lastName: 'lastName' },
    roleMapping: DEFAULT_ROLE_MAPPING,
    jitEnabled: true,
    wantAuthnResponseSigned: true,
    wantAssertionsSigned: false,
    runbookPath: 'docs/protocols/runbooks/keycloak.md',
  },
}

export const OUTBOUND_SAAS_PRESETS: Record<OutboundSaasPresetKey, OutboundSaasPreset> = {
  slack: {
    key: 'slack',
    displayName: 'Slack',
    protocol: 'saml',
    spEntityId: 'https://slack.com',
    acsUrlPlaceholder: 'https://{workspace}.slack.com/sso/saml',
    sloUrl: null,
    attributeMapping: {
      email: 'email',
      userEmail: 'User.Email',
      firstName: 'first_name',
      lastName: 'last_name',
      displayName: 'display_name',
    },
    nameIdFormat: EMAIL_ADDRESS_NAMEID,
    runbookPath: 'docs/protocols/runbooks/slack-downstream-saml.md',
  },
  'github-enterprise': {
    key: 'github-enterprise',
    displayName: 'GitHub Enterprise Cloud',
    protocol: 'saml',
    spEntityId: 'https://github.com/enterprises/{enterprise}',
    acsUrlPlaceholder: 'https://github.com/enterprises/{enterprise}/saml/consume',
    attributeMapping: { email: 'emails', displayName: 'full_name' },
    nameIdFormat: EMAIL_ADDRESS_NAMEID,
    runbookPath: 'docs/protocols/runbooks/github-enterprise-downstream-saml.md',
  },
  'microsoft-enterprise-app': {
    key: 'microsoft-enterprise-app',
    displayName: 'Microsoft custom enterprise app',
    protocol: 'saml-oidc',
    spEntityId: 'https://sts.windows.net/{tenantId}/',
    acsUrlPlaceholder: 'https://login.microsoftonline.com/{tenantId}/saml2',
    oidcRedirectPlaceholder: 'https://login.microsoftonline.com/{tenantId}/oauth2/nativeclient',
    attributeMapping: {
      email: 'email',
      firstName: 'given_name',
      lastName: 'family_name',
      displayName: 'name',
    },
    nameIdFormat: EMAIL_ADDRESS_NAMEID,
    runbookPath: 'docs/protocols/runbooks/microsoft-enterprise-app-downstream.md',
  },
  atlassian: {
    key: 'atlassian',
    displayName: 'Atlassian Guard',
    protocol: 'saml',
    spEntityId: 'https://auth.atlassian.com/saml/{connectionId}',
    acsUrlPlaceholder: 'https://auth.atlassian.com/login/callback?connection=saml-{connectionId}',
    attributeMapping: {
      email: WS_CLAIMS.email,
      firstName: WS_CLAIMS.firstName,
      lastName: WS_CLAIMS.lastName,
      userId: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
    },
    nameIdFormat: EMAIL_ADDRESS_NAMEID,
    runbookPath: 'docs/protocols/runbooks/atlassian-downstream-saml.md',
  },
  salesforce: {
    key: 'salesforce',
    displayName: 'Salesforce',
    protocol: 'saml-oidc',
    spEntityId: 'https://{myDomain}.my.salesforce.com',
    acsUrlPlaceholder: 'https://{myDomain}.my.salesforce.com',
    oidcRedirectPlaceholder:
      'https://{myDomain}.my.salesforce.com/services/authcallback/{connectedApp}',
    attributeMapping: {
      email: 'email',
      firstName: 'firstName',
      lastName: 'lastName',
      displayName: 'displayName',
    },
    nameIdFormat: EMAIL_ADDRESS_NAMEID,
    runbookPath: 'docs/protocols/runbooks/salesforce-downstream-saml-oidc.md',
  },
  zoom: {
    key: 'zoom',
    displayName: 'Zoom',
    protocol: 'saml-oidc',
    spEntityId: 'https://{vanityUrl}.zoom.us',
    acsUrlPlaceholder: 'https://{vanityUrl}.zoom.us/saml/SSO',
    oidcRedirectPlaceholder: 'https://{vanityUrl}.zoom.us/oauth/callback',
    attributeMapping: {
      email: 'email',
      firstName: 'firstName',
      lastName: 'lastName',
      displayName: 'displayName',
    },
    nameIdFormat: EMAIL_ADDRESS_NAMEID,
    runbookPath: 'docs/protocols/runbooks/zoom-downstream-saml-oidc.md',
  },
}

export function presetKeyFromAttributeMapping(
  mapping: Record<string, unknown>,
): string | undefined {
  const value = mapping._xidPreset
  return typeof value === 'string' ? value : undefined
}

export function inboundPresetDisplayName(presetKey: string | undefined): string | undefined {
  if (!presetKey) return undefined
  if (Object.hasOwn(INBOUND_IDP_PRESETS, presetKey)) {
    return INBOUND_IDP_PRESETS[presetKey as InboundIdpPresetKey].displayName
  }
  if (Object.hasOwn(LEGACY_INBOUND_PRESETS, presetKey)) {
    return LEGACY_INBOUND_PRESETS[presetKey as LegacyInboundPresetKey].displayName
  }
  return undefined
}

export function withPresetAttributeMapping(
  presetKey: string,
  mapping: Record<string, string>,
): Record<string, string> {
  return { ...mapping, _xidPreset: presetKey }
}
