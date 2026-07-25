// Enterprise IdP and downstream SaaS preset definitions for console wizards and L3 smoke fixtures.
// Presets pre-fill SP/IdP metadata, attribute mapping, and NameID policy; real admin L4 is still required
// before production-supported claims.

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
  idpSsoUrl?: string
  attributeMapping: Record<string, unknown>
  roleMapping: Record<string, string>
  jitEnabled: boolean
  runbookPath: string
}

export type InboundIdpPreset = {
  key: InboundIdpPresetKey
  displayName: string
  protocol: 'saml' | 'oidc'
  idpEntityId?: string
  idpSsoUrl?: string
  idpMetadataUrl?: string
  oidcDiscoveryUrl?: string
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

export const LEGACY_INBOUND_PRESETS: Record<LegacyInboundPresetKey, LegacyInboundPreset> = {
  ldap: {
    key: 'ldap',
    displayName: 'LDAP direct bind',
    protocol: 'ldap',
    attributeMapping: {
      _legacy: {
        ldapGatewayUrl: 'https://ldap-gw.example.com/bind',
        bindDnTemplate: '{username}',
      },
    },
    roleMapping: DEFAULT_ROLE_MAPPING,
    jitEnabled: true,
    runbookPath: 'docs/protocols/README.md',
  },
  wsfed: {
    key: 'wsfed',
    displayName: 'WS-Federation',
    protocol: 'wsfed',
    idpSsoUrl: 'https://adfs.example.com/adfs/ls/',
    attributeMapping: {
      _legacy: {
        wsfedRealm: 'https://tenant.example.com',
        wsfedReplyUrl: 'https://tenant.example.com/sso/wsfed/{connectionId}/callback',
      },
    },
    roleMapping: DEFAULT_ROLE_MAPPING,
    jitEnabled: true,
    runbookPath: 'docs/protocols/README.md',
  },
  swa: {
    key: 'swa',
    displayName: 'SWA password vaulting',
    protocol: 'swa',
    attributeMapping: {
      _legacy: {
        swaTargetUrl: 'https://app.example.com/login',
        vaultCredentialRef: 'primary',
      },
    },
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
        trustedProxySecret: 'replace-with-proxy-secret',
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

export const INBOUND_IDP_PRESETS: Record<InboundIdpPresetKey, InboundIdpPreset> = {
  okta: {
    key: 'okta',
    displayName: 'Okta',
    protocol: 'saml',
    idpMetadataUrl: 'https://{oktaDomain}/app/{appId}/sso/saml/metadata',
    attributeMapping: {
      email: 'email',
      firstName: 'firstName',
      lastName: 'lastName',
      idpId: 'nameID',
    },
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
    idpMetadataUrl:
      'https://login.microsoftonline.com/{tenantId}/federationmetadata/2007-06/federationmetadata.xml',
    attributeMapping: {
      email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
      firstName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
      lastName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
      idpId: 'http://schemas.microsoft.com/identity/claims/objectidentifier',
    },
    roleMapping: DEFAULT_ROLE_MAPPING,
    jitEnabled: true,
    wantAuthnResponseSigned: true,
    wantAssertionsSigned: true,
    runbookPath: 'docs/protocols/runbooks/microsoft-entra-id.md',
  },
  'google-workspace': {
    key: 'google-workspace',
    displayName: 'Google Workspace',
    protocol: 'saml',
    idpMetadataUrl: 'https://accounts.google.com/o/saml2/idp?idpid={idpId}',
    attributeMapping: {
      email: 'email',
      firstName: 'firstName',
      lastName: 'lastName',
      idpId: 'nameID',
    },
    roleMapping: DEFAULT_ROLE_MAPPING,
    jitEnabled: true,
    wantAuthnResponseSigned: true,
    wantAssertionsSigned: true,
    runbookPath: 'docs/protocols/runbooks/google-workspace.md',
  },
  onelogin: {
    key: 'onelogin',
    displayName: 'OneLogin',
    protocol: 'saml',
    idpMetadataUrl: 'https://app.onelogin.com/saml/metadata/{connectorId}',
    attributeMapping: {
      email: 'User.email',
      firstName: 'User.FirstName',
      lastName: 'User.LastName',
      idpId: 'User.username',
    },
    roleMapping: DEFAULT_ROLE_MAPPING,
    jitEnabled: true,
    wantAuthnResponseSigned: true,
    wantAssertionsSigned: true,
    runbookPath: 'docs/protocols/runbooks/onelogin.md',
  },
  jumpcloud: {
    key: 'jumpcloud',
    displayName: 'JumpCloud',
    protocol: 'saml',
    idpMetadataUrl: 'https://sso.jumpcloud.com/saml2/{appId}',
    attributeMapping: {
      email: 'email',
      firstName: 'firstname',
      lastName: 'lastname',
      idpId: 'nameID',
    },
    roleMapping: DEFAULT_ROLE_MAPPING,
    jitEnabled: true,
    wantAuthnResponseSigned: true,
    wantAssertionsSigned: true,
    runbookPath: 'docs/protocols/runbooks/jumpcloud.md',
  },
  pingone: {
    key: 'pingone',
    displayName: 'PingOne',
    protocol: 'saml',
    idpMetadataUrl: 'https://auth.pingone.com/{envId}/saml20/metadata',
    attributeMapping: {
      email: 'email',
      firstName: 'givenName',
      lastName: 'surname',
      idpId: 'sub',
    },
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
    idpMetadataUrl: 'https://{host}/pf/federation_metadata.ping',
    attributeMapping: {
      email: 'email',
      firstName: 'givenName',
      lastName: 'surname',
      idpId: 'nameID',
    },
    roleMapping: DEFAULT_ROLE_MAPPING,
    jitEnabled: true,
    wantAuthnResponseSigned: true,
    wantAssertionsSigned: true,
    runbookPath: 'docs/protocols/runbooks/pingfederate.md',
  },
  adfs: {
    key: 'adfs',
    displayName: 'AD FS',
    protocol: 'saml',
    idpMetadataUrl: 'https://{host}/FederationMetadata/2007-06/FederationMetadata.xml',
    attributeMapping: {
      email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
      firstName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
      lastName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
      idpId: 'http://schemas.microsoft.com/ws/2008/06/identity/claims/windowsaccountname',
    },
    roleMapping: DEFAULT_ROLE_MAPPING,
    jitEnabled: true,
    wantAuthnResponseSigned: true,
    wantAssertionsSigned: true,
    runbookPath: 'docs/protocols/runbooks/adfs.md',
  },
  shibboleth: {
    key: 'shibboleth',
    displayName: 'Shibboleth',
    protocol: 'saml',
    idpMetadataUrl: 'https://{host}/idp/shibboleth',
    attributeMapping: {
      email: 'mail',
      firstName: 'givenName',
      lastName: 'sn',
      idpId: 'eduPersonPrincipalName',
    },
    roleMapping: DEFAULT_ROLE_MAPPING,
    jitEnabled: true,
    wantAuthnResponseSigned: true,
    wantAssertionsSigned: true,
    runbookPath: 'docs/protocols/runbooks/shibboleth.md',
  },
  keycloak: {
    key: 'keycloak',
    displayName: 'Keycloak',
    protocol: 'saml',
    idpMetadataUrl: 'https://{host}/realms/{realm}/protocol/saml/descriptor',
    attributeMapping: {
      email: 'email',
      firstName: 'firstName',
      lastName: 'lastName',
      idpId: 'nameID',
    },
    roleMapping: DEFAULT_ROLE_MAPPING,
    jitEnabled: true,
    wantAuthnResponseSigned: true,
    wantAssertionsSigned: true,
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
    nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
    runbookPath: 'docs/protocols/runbooks/slack-downstream-saml.md',
  },
  'github-enterprise': {
    key: 'github-enterprise',
    displayName: 'GitHub Enterprise Cloud',
    protocol: 'saml',
    spEntityId: 'https://github.com/enterprises/{enterprise}/saml/metadata',
    acsUrlPlaceholder: 'https://github.com/enterprises/{enterprise}/saml/consume',
    attributeMapping: {
      email: 'email',
      firstName: 'firstName',
      lastName: 'lastName',
      displayName: 'displayName',
    },
    nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
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
    nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
    runbookPath: 'docs/protocols/runbooks/microsoft-enterprise-app-downstream.md',
  },
  atlassian: {
    key: 'atlassian',
    displayName: 'Atlassian Guard',
    protocol: 'saml',
    spEntityId: 'https://{orgId}.atlassian.com',
    acsUrlPlaceholder: 'https://id.atlassian.com/login/saml/acs',
    attributeMapping: {
      email: 'email',
      firstName: 'firstName',
      lastName: 'lastName',
      displayName: 'displayName',
    },
    nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
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
    nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
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
    nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress',
    runbookPath: 'docs/protocols/runbooks/zoom-downstream-saml-oidc.md',
  },
}

export function presetKeyFromAttributeMapping(
  mapping: Record<string, unknown>,
): string | undefined {
  const value = mapping._xidPreset
  return typeof value === 'string' ? value : undefined
}

export function withPresetAttributeMapping(
  presetKey: string,
  mapping: Record<string, string>,
): Record<string, string> {
  return { ...mapping, _xidPreset: presetKey }
}
