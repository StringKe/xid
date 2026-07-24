// Console-safe outbound SaaS preset metadata shared by OrgOutboundSso and worker provider-presets.

export type OutboundConsolePreset = {
  key: string
  label: string
  entityId: string
  acsUrl: string
  protocol: 'saml' | 'saml-oidc'
  oidcRedirectPlaceholder?: string
}

export const OUTBOUND_CONSOLE_PRESETS: readonly OutboundConsolePreset[] = [
  {
    key: 'slack',
    label: 'Slack',
    entityId: 'https://slack.com',
    acsUrl: 'https://{workspace}.slack.com/sso/saml',
    protocol: 'saml',
  },
  {
    key: 'github-enterprise',
    label: 'GitHub Enterprise',
    entityId: 'https://github.com/enterprises/{enterprise}/saml/metadata',
    acsUrl: 'https://github.com/enterprises/{enterprise}/saml/consume',
    protocol: 'saml',
  },
  {
    key: 'microsoft-enterprise-app',
    label: 'Microsoft enterprise app',
    entityId: 'https://sts.windows.net/{tenantId}/',
    acsUrl: 'https://login.microsoftonline.com/{tenantId}/saml2',
    protocol: 'saml-oidc',
    oidcRedirectPlaceholder: 'https://login.microsoftonline.com/{tenantId}/oauth2/nativeclient',
  },
  {
    key: 'atlassian',
    label: 'Atlassian Guard',
    entityId: 'https://{orgId}.atlassian.com',
    acsUrl: 'https://id.atlassian.com/login/saml/acs',
    protocol: 'saml',
  },
  {
    key: 'salesforce',
    label: 'Salesforce',
    entityId: 'https://{myDomain}.my.salesforce.com',
    acsUrl: 'https://{myDomain}.my.salesforce.com',
    protocol: 'saml-oidc',
    oidcRedirectPlaceholder:
      'https://{myDomain}.my.salesforce.com/services/authcallback/{connectedApp}',
  },
  {
    key: 'zoom',
    label: 'Zoom',
    entityId: 'https://{vanityUrl}.zoom.us',
    acsUrl: 'https://{vanityUrl}.zoom.us/saml/SSO',
    protocol: 'saml-oidc',
    oidcRedirectPlaceholder: 'https://{vanityUrl}.zoom.us/oauth/callback',
  },
] as const
