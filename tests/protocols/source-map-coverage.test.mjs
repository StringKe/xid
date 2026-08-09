import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const protocolsDir = 'docs/protocols'
const conformancePlanPath = 'docs/protocols/conformance-plan.md'
const gapAuditPath = 'docs/protocols/gap-audit.md'
const sourceMapPath = 'docs/protocols/source-map.md'
const protocolGoalPath = 'docs/standards-sources.md'
const protocolReadmePath = 'docs/protocols/README.md'
const providerCompatibilityPath = 'docs/protocols/provider-compatibility.md'
// docs/design/** is the English source of truth; docs/zh-Hans/design/** is a one-to-one mirror.
const oidcDesignPath = 'docs/design/03-oidc-oauth.md'
const enterpriseSsoDesignPath = 'docs/design/04-enterprise-sso.md'
const overviewDesignPath = 'docs/design/00-overview.md'
const authDesignPath = 'docs/design/01-authentication.md'
const overviewDesignZhPath = 'docs/zh-Hans/design/00-overview.md'
const authDesignZhPath = 'docs/zh-Hans/design/01-authentication.md'
const oidcDesignZhPath = 'docs/zh-Hans/design/03-oidc-oauth.md'
const enterpriseSsoDesignZhPath = 'docs/zh-Hans/design/04-enterprise-sso.md'

// The English chapters are hard-wrapped at ~100 columns, so a boundary sentence routinely spans
// several source lines. Collapsing whitespace keeps these assertions anchored to the wording rather
// than to the current wrap points.
const collapseWhitespace = (text) => text.replace(/\s+/gu, ' ')
const apiContractsPath = 'docs/api-contracts.md'
const publicDocsRegistryPath = 'packages/types/src/public-docs.ts'
const publicDocsRegistryTestPath = 'apps/site/src/lib/docs-registry.test.ts'
const publicDocsGenerationTestPath = 'apps/site/scripts/generate-localized-content.test.mjs'
const siteWorkerTestPath = 'apps/site/worker/index.test.ts'
const siteDistAuditPath = 'apps/site/scripts/audit-dist-routes.mjs'
const publicDocsContentPath = 'apps/site/src/content-source/docs/documents.json'

const expectedProtocolDocs = [
  'README.md',
  'conformance-plan.md',
  'gap-audit.md',
  'oauth.md',
  'oidc.md',
  'provider-compatibility.md',
  'saml.md',
  'scim.md',
  'security-profiles.md',
  'source-map.md',
  'tokens-sessions.md',
  'webauthn-passkeys.md',
]

const expectedProviderCompatibilityRows = [
  'AD FS',
  'Apple',
  'Atlassian',
  'GitHub',
  'GitHub Enterprise Cloud',
  'Google',
  'Google Workspace',
  'Infobip',
  'JumpCloud',
  'Keycloak',
  'MessageBird',
  'Meta WhatsApp',
  'Microsoft Entra ID',
  'Microsoft account',
  'Microsoft custom enterprise app',
  'Okta',
  'OneLogin',
  'PingFederate',
  'PingOne',
  'Salesforce',
  'Shibboleth',
  'Slack',
  'Twilio',
  'Vonage',
  'Zoom',
]

const expectedRoleLineTerms = [
  'XID as OIDC/OAuth IdP',
  'XID as enterprise upstream IdP SAML SP/OIDC RP',
  'XID as downstream SaaS SAML/OIDC IdP',
  'XID as SCIM Service Provider',
  'XID as Social OAuth RP',
]

const expectedSupportDefinitionTerms = [
  'Critical paths covering sign-in, token, SCIM, SAML, and WebAuthn have at least L2 or L3',
  'A production-supported claim still MUST have L4',
  '`provider-ready` is not a completion state',
  'Downstream SaaS SSO such as Slack, GitHub Enterprise Cloud, Microsoft custom enterprise app, Atlassian, Salesforce, and Zoom already has an outbound SAML IdP baseline and local fake SaaS SP L3',
  'Downstream SaaS SCIM target clients such as Slack, GitHub Enterprise Cloud, Atlassian, Salesforce, and Zoom already have an outbound SCIM client baseline and local fake SaaS SCIM L3',
  'GitHub Social OAuth MUST NOT substitute for GitHub Enterprise SAML/SCIM',
  'Microsoft account MUST NOT substitute for Microsoft Entra ID or Microsoft custom enterprise app',
]

const expectedReadmeScimDirectionTerms = [
  'Downstream SaaS SCIM target clients run in the opposite direction',
  'XID pushes users and groups into SaaS SCIM APIs such as Slack, GitHub Enterprise Cloud, Atlassian, Salesforce, and Zoom',
  'The outbound SCIM client baseline currently has local fake SaaS SCIM L3',
  'MUST NOT reuse inbound SCIM Service Provider evidence',
  'production supported MUST NOT be claimed while real SaaS L4 is missing',
  'fake SaaS SCIM L3',
]

const expectedGoalOfficialBoundaryTerms = [
  'Auth0 Inbound SCIM is the XID role 4 counterpart',
  'it does not support a full `/groups` endpoint',
  'Auth0 outbound SSO and the outbound SAML IdP for GitHub Enterprise Cloud are the XID role 3 counterpart',
  'the official outbound SSO documentation covers IdP-initiated marketplace integrations such as Slack and Zoom plus custom SAML/OIDC',
  'Clerk EASIE OIDC is a multi-tenant IdP path for Google Workspace and Microsoft Entra ID',
  'Sign in with Other App is Clerk acting as a Social OAuth RP',
  'Sign in with Your App is Clerk acting as an OAuth 2.0/OIDC IdP',
  'cannot be automatically equated with a Slack/GitHub/Microsoft/Atlassian/Salesforce/Zoom SaaS-specific app catalog',
  'Zitadel Okta SCIM is Okta provisioning into the ZITADEL SCIM endpoint',
  'the SCIM base URL is `https://${ZITADEL_DOMAIN}/scim/v2/{orgId}`',
  'Entra SCIM provisioning synchronizes assigned users and groups to the target app SCIM endpoint',
  'Test Connection queries a non-existent user and expects an HTTP 200 empty ListResponse',
  'later sync cycles run about every 40 minutes',
  'an OIDC integration currently cannot add SCIM provisioning',
  'Okta OIDC upstream login and Okta SCIM provisioning must be verified separately',
  'ACS `https://yourdomain.slack.com/sso/saml`',
  'Entity ID `https://slack.com`',
  'a Bearer OAuth token with the `admin` scope',
  'the Enterprise org token is obtained by installing the SCIM app on the Enterprise organization',
  'Organization SCIM supported IdPs are Entra ID, Okta and OneLogin',
  'REST API SCIM is not supported for enterprises with OIDC enabled',
  'Real XID L4 must come from real IdP provisioning into XID',
  'Clerk generic OAuth/OIDC IdP evidence must not be treated as SaaS app catalog completion',
  'Inbound SCIM L3 or real IdP provisioning L4 cannot be reused as downstream SaaS SCIM target L4',
]

const expectedDownstreamSaaSFeatures = [
  'Outbound SAML IdP metadata',
  'Outbound SAML IdP SSO endpoint',
  'Slack downstream SAML template',
  'GitHub Enterprise downstream SAML template',
  'Downstream OIDC app catalog',
  'Microsoft custom enterprise app downstream SSO',
  'Atlassian downstream SAML template',
  'Salesforce downstream SAML/OIDC template',
  'Zoom downstream SAML/OIDC template',
  'Outbound SAML SLO',
]

const expectedOpenP0BlockedTerms = [
  'Real SaaS L4 is missing for outbound SaaS SSO',
  'Real SaaS L4 is missing for downstream SaaS SCIM target clients',
  'real Slack Enterprise or GitHub Enterprise Cloud admin permission',
  'real Microsoft Entra custom enterprise app admin permission',
  'real Atlassian Guard org admin permission',
  'real Salesforce admin permission',
  'real Zoom admin permission and approved vanity URL',
  'real SaaS L4',
]

const expectedGoalCompletionGateTerms = [
  'Local protocol implementation can be proven complete with L1/L2/L3 and fake provider or fake SaaS evidence',
  'L4 is the gate for production-supported claims, not the gate for local implementation completion',
  'Role 3 XID as downstream SaaS SAML/OIDC IdP: the local baseline has landed',
  'Downstream SaaS SCIM target clients: the local baseline has landed',
  'Real Slack/GitHub Enterprise Cloud/Atlassian/Salesforce/Zoom admin L4 is still missing',
]

const expectedP0LandedRoleSplitTerms = [
  'Provider compatibility matrix previously mixed product roles by brand',
  'Provider rows are now split by protocol role',
  'downstream SaaS rows are provider-ready or implemented based on local baseline evidence',
  'GitHub Social OAuth separate from GitHub Enterprise SAML/SCIM',
  'Microsoft account separate from Microsoft Entra ID and Microsoft custom enterprise app',
  'Slack/Atlassian/Salesforce/Zoom as downstream SaaS SP or SCIM target rows',
  'docs/protocols/provider-compatibility.md',
  'tests/protocols/source-map-coverage.test.mjs',
]

const expectedOfficialSourceUrls = [
  'https://auth0.com/docs/authenticate/enterprise-connections',
  'https://auth0.com/docs/authenticate/identity-providers/enterprise-identity-providers',
  'https://auth0.com/docs/authenticate/protocols/ws-fed-protocol',
  'https://auth0.com/docs/authenticate/identity-providers/social-identity-providers',
  'https://auth0.com/docs/authenticate/identity-providers/social-identity-providers/google',
  'https://auth0.com/docs/authenticate/identity-providers/social-identity-providers/github',
  'https://auth0.com/docs/authenticate/identity-providers/social-identity-providers/oauth2',
  'https://auth0.com/docs/authenticate/protocols/scim/configure-inbound-scim',
  'https://auth0.com/docs/authenticate/single-sign-on/outbound-single-sign-on/configure-auth0-saml-identity-provider/configure-saml2-web-app-addon-for-github-enterprise-cloud',
  'https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/overview',
  'https://clerk.com/docs/nextjs/guides/configure/auth-strategies/social-connections/overview',
  'https://clerk.com/docs/guides/configure/auth-strategies/oauth/single-sign-on',
  'https://clerk.com/docs/guides/configure/auth-strategies/social-connections/google',
  'https://clerk.com/docs/guides/configure/auth-strategies/social-connections/github',
  'https://clerk.com/docs/guides/configure/auth-strategies/social-connections/apple',
  'https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/directory-sync',
  'https://zitadel.com/docs/guides/integrate/identity-providers/introduction',
  'https://zitadel.com/docs/concepts/features/identity-brokering',
  'https://zitadel.com/docs/guides/integrate/identity-providers/google',
  'https://zitadel.com/docs/guides/integrate/identity-providers/apple',
  'https://zitadel.com/docs/guides/integrate/identity-providers/okta-oidc',
  'https://zitadel.com/docs/guides/integrate/identity-providers/okta_saml',
  'https://zitadel.com/docs/guides/integrate/identity-providers/openldap',
  'https://zitadel.com/docs/guides/integrate/scim-okta-guide',
  'https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/what-is-single-sign-on',
  'https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/plan-sso-deployment',
  'https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/add-application-portal-setup-sso',
  'https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/add-application-portal-setup-oidc-sso',
  'https://learn.microsoft.com/en-us/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups',
  'https://learn.microsoft.com/en-us/entra/identity/app-provisioning/user-provisioning',
  'https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/overview-application-gallery',
  'https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/plan-an-application-integration',
  'https://developer.okta.com/docs/guides/create-an-app-integration/-/main/',
  'https://help.okta.com/oie/en-us/Content/Topics/Apps/Apps_App_Integration_Wizard_SCIM.htm',
  'https://docs.pingidentity.com/pingoneforenterprise/pingone_for_enterprise/p14e_add_update_saml_application.html',
  'https://docs.pingidentity.com/pingoneforenterprise/pingone_for_enterprise/p14e_integrate_oidc_application.html',
  'https://docs.pingidentity.com/pingfederate/13.0/administrators_reference_guide/pf_oidc_relying_party_support.html',
  'https://docs.pingidentity.com/pingfederate/13.0/administrators_reference_guide/help_idpconnectionconfigtasklet_idpbrowserssostate.html',
  'https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-adfsod/7fc51569-b46d-4aba-8ae6-bad19cb9951b',
  'https://learn.microsoft.com/en-us/windows-server/identity/ad-fs/operations/create-a-relying-party-trust',
  'https://shibboleth.atlassian.net/wiki/spaces/IDPPLUGINS/pages/1376878976/OIDC+OP',
  'https://shibboleth.atlassian.net/wiki/spaces/IDPPLUGINS/pages/1376878976/OIDC%20OP',
  'https://www.keycloak.org/docs/latest/server_admin/',
  'https://slack.com/help/articles/205168057-Custom-SAML-single-sign-on',
  'https://api.slack.com/scim',
  'https://docs.github.com/en/enterprise-cloud@latest/organizations/managing-saml-single-sign-on-for-your-organization/connecting-your-identity-provider-to-your-organization',
  'https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/configuring-authentication-for-enterprise-managed-users/configuring-saml-single-sign-on-for-enterprise-managed-users',
  'https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/provisioning-user-accounts-with-scim/configuring-scim-provisioning-for-users',
  'https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps',
  'https://support.atlassian.com/provisioning-users/docs/what-are-setup-options-for-provisioning-and-single-sign-on/',
  'https://support.atlassian.com/security-and-access-policies/docs/configure-saml-single-sign-on-with-an-identity-provider/',
  'https://support.atlassian.com/provisioning-users/docs/configure-user-provisioning-with-an-identity-provider/',
  'https://help.salesforce.com/s/articleView?id=xcloud.sso_saml.htm&type=5',
  'https://developer.salesforce.com/docs/platform/mobile-sdk/guide/sso-provider-openid-connect.html',
  'https://help.salesforce.com/s/articleView?id=xcloud.identity_scim_overview.htm&language=en_US&type=5',
  'https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0065487',
  'https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0083701',
  'https://developers.zoom.us/docs/api/scim2/',
  'https://developers.google.com/identity/openid-connect/openid-connect',
  'https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc',
  'https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow',
  'https://developer.apple.com/documentation/signinwithapplerestapi',
  'https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web/',
]

const expectedOfficialBoundaryTerms = [
  'Clerk Directory Sync is SCIM 2.0 generally available',
  'Auth0 Inbound SCIM supports SAML, OpenID Connect, Okta Workforce Identity, and Microsoft Azure AD / Entra ID enterprise connection types',
  'Auth0 documents that it does not support a `/groups` endpoint for full group objects and group memberships',
  'Auth0 SCIM deactivation blocks the user, terminates Auth0 sessions, revokes refresh tokens, and can trigger OIDC Back-Channel Logout when configured',
  'Auth0 outbound SSO documents IdP-initiated marketplace integrations for services like Dropbox, Slack, and Zoom',
  'This is role 3 evidence that downstream SaaS SSO is a distinct product surface from inbound enterprise connections',
  'Clerk Enterprise SSO supports SAML and OIDC, including Microsoft Azure AD, Google Workspace, Okta Workforce, generic SAML IdPs, and OIDC-compatible providers',
  'Clerk EASIE OIDC is a multi-tenant IdP path for Google Workspace and Microsoft Entra ID',
  'Clerk Directory Sync is SCIM 2.0 Service Provider behavior',
  'the IdP pushes create, update, delete, and disable events into Clerk',
  'SCIM `emails` must contain email for each user',
  'Okta custom SCIM provisioning is not currently supported on OIDC app integrations',
  'Okta OIDC upstream login and Okta SCIM provisioning as separate evidence inputs',
  'Okta AIW SCIM provisioning requires first creating a SAML or SWA SSO integration that supports SCIM',
  'authentication modes include Basic Auth, HTTP Header bearer token, and OAuth 2.0 Client Credentials or Authorization Code',
  "Microsoft Entra SCIM provisioning targets an application's SCIM endpoint",
  'runs synchronization for assigned users and groups',
  'performs Test Connection by querying a non-existent user and expecting HTTP 200 with an empty ListResponse',
  'later sync cycles run about every 40 minutes',
  'expects a SCIM 2.0 user and group endpoint, schema discovery, PATCH group membership updates, public SCIM documentation, and OAuth 2.0 client credentials for new gallery connectors',
  'Zitadel SCIM from Okta requires an existing SAML app between Okta and ZITADEL',
  'ZITADEL service-account authentication by PAT or client credentials',
  'SCIM connector base URL `https://${ZITADEL_DOMAIN}/scim/v2/{orgId}`',
  'GitHub Enterprise Managed Users can use OIDC only on the Microsoft Entra ID partner path',
  'not generic downstream OIDC support for XID',
  'Auth0, Clerk, and Zitadel all document social or external identity provider login',
  'Clerk OAuth SSO documents both directions',
  'XID role 1 covers generic OAuth/OIDC clients',
  'GitHub OAuth apps support OAuth 2.0 authorization code flow',
  'Microsoft identity platform OIDC and authorization code flow support Microsoft account login',
  'Apple Sign in with Apple requires web Services ID/private key setup',
  'Auth0 Enterprise Identity Providers lists Active Directory/LDAP',
  'Auth0 WS-Fed docs cover WS-Fed application endpoints',
  'LDAP direct bind, WS-Federation, SWA password vaulting, and header-based SSO have local legacy baseline routes',
  'Okta app integrations include OIDC, SAML, SWA, WS-Fed, and SCIM',
  'XID implements SWA/password vaulting and WS-Federation with fake harness L3',
  'Microsoft Entra SSO options include SAML 2.0, WS-Federation, OpenID Connect, password-based SSO, linked sign-on, Integrated Windows Authentication, and header-based SSO',
  'XID implements SAML/OIDC federation plus legacy WS-Fed, SWA/password vaulting, and header-based SSO baseline; linked sign-on and native IWA/Kerberos remain out of scope',
  'Microsoft Entra app provisioning covers SCIM plus LDAP, SQL, REST, SOAP, flat-file, PowerShell, and custom ECMA connectors',
  'XID role 4 is SCIM Service Provider with directory connector registry stubs for non-SCIM connectors',
  'Zitadel identity brokering documents OIDC, SAML2, and LDAP external IdPs',
  'LDAP direct bind is implemented locally via HTTP gateway or fake LDAP harness',
  'Slack custom SAML confirms Slack is the SP',
  'ACS URL `https://yourdomain.slack.com/sso/saml`',
  'Entity ID `https://slack.com`',
  'HTTP POST binding only',
  'signed SAML Response',
  'required NameID and User.Email',
  'no Single Logout',
  'Slack SCIM is a downstream target API with SCIM 2.0 base path `/scim/v2`',
  'Bearer OAuth token with `admin` scope',
  'Enterprise org token obtained by installing the SCIM app on the Enterprise organization',
  'GitHub organization SAML SSO connects an external IdP to a GitHub Enterprise Cloud organization',
  'Organization SCIM supported IdPs are Entra ID, Okta, and OneLogin',
  'GitHub Enterprise Managed Users SCIM is IdP-to-GitHub lifecycle management',
  'non-partner provisioning can use GitHub REST API endpoints for SCIM',
  'REST API SCIM is not supported with enterprises enabled for OIDC',
  'PingOne for Enterprise documents SAML applications with metadata, ACS URL, Entity ID, signing certificate, assertion encryption, and optional SLO',
  'XID role 2 is implemented for PingOne SAML/OIDC upstream presets',
  'PingFederate documents SAML 2.0, WS-Federation, and OpenID Connect browser SSO configuration',
  'XID role 2 covers PingFederate SAML/OIDC implemented presets and fake IdP L3',
  'AD FS documents relying party trusts for SAML 2.0 WebSSO and WS-Federation Passive protocol',
  'XID role 2 covers AD FS SAML/OIDC implemented presets and fake IdP L3',
  'Shibboleth documents native SAML IdP behavior and official OIDC OP/RP plugins',
  'Keycloak documents OIDC, OAuth 2.0, SAML, identity brokering for external OIDC/SAML IdPs, Social Login, LDAP/AD user federation, and Kerberos bridge',
  'Keycloak LDAP/AD user federation has a separate XID LDAP direct bind baseline; native Kerberos bridge remains documented-only',
  'Atlassian Cloud uses Atlassian Guard identity provider setup for SAML single sign-on and SCIM provisioning',
  'Atlassian is implemented locally through outbound SAML console presets',
  'Salesforce Help was browser/manual verified when direct fetch returned only Loading',
  'Salesforce SCIM supports REST API create, read, update, and disable user operations, deactivate/reactivate behavior, and group member management',
  'Salesforce is implemented locally through outbound SAML/OIDC presets',
  'Zoom official docs state Zoom acts as the Service Provider for SAML SSO',
  'Zoom is implemented locally through outbound SAML/OIDC presets',
]

const expectedCompetitorBaselineTerms = [
  '## Competitor Baseline',
  'role 3 already has outbound SAML IdP baseline',
  'Social Identity Providers cover Google, GitHub, and generic OAuth2 social connections',
  'Social Connections OAuth covers Google, GitHub, Apple, Microsoft-style providers',
  'OAuth SSO also documents Clerk as OAuth 2.0/OIDC IdP for third-party clients',
  'real SaaS L4 and SaaS-specific presets are still missing',
  'Directory Sync is SCIM 2.0 generally available',
  'Zitadel can connect external identity providers for social login and enterprise SSO',
  'LDAP direct bind, WS-Federation, and SWA/password vaulting are implemented locally with fake harness L3',
  'LDAP direct bind is current XID role 2 local baseline support',
  'SCIM v2.0 service provider endpoint',
]

const expectedReadmeCompetitorTerms = [
  '## Competitor Alignment Baseline',
  'Auth0: the official docs cover Enterprise Connections, Social Identity Providers, and Inbound SCIM, plus an outbound SAML IdP for GitHub Enterprise Cloud',
  'XID role 3 currently has an outbound SAML IdP baseline',
  'Auth0: the official docs also cover Active Directory/LDAP, ADFS, and WS-Fed',
  'XID currently has local baselines for LDAP direct bind, WS-Federation, and SWA/password vaulting',
  'Auth0 Inbound SCIM: the official docs cover SAML, OpenID Connect, Okta Workforce Identity, and Microsoft Azure AD / Entra ID enterprise connection types',
  'do not support a full `/groups` endpoint',
  'Auth0 SCIM deactivate/block terminates Auth0 sessions, revokes refresh tokens',
  'Auth0 outbound SSO: the official docs cover IdP-initiated marketplace integrations',
  'including Dropbox, Slack, and Zoom',
  'Clerk OAuth SSO: the official docs state two explicit directions',
  'Sign in with Other App is Clerk acting as a Social OAuth RP',
  'Sign in with Your App is Clerk acting as an OAuth 2.0/OIDC IdP',
  'it does not prove that the Slack/GitHub/Microsoft custom enterprise app SaaS catalog is production-supported',
  'Clerk Directory Sync: the official docs state that Directory Sync is SCIM 2.0 Service Provider behavior',
  'Clerk revokes active sessions on deprovisioning',
  'Clerk: the official docs cover Enterprise SSO (SAML/OIDC), Social Connections OAuth, Clerk as OAuth/OIDC IdP, and Directory Sync SCIM 2.0 GA',
  'Zitadel: the official docs cover external identity providers, identity brokering, Google/Apple social login, Okta OIDC/SAML identity provider, LDAP external IdP, and Okta SCIM provisioning',
  'XID also has an LDAP direct bind baseline, which is not downstream SaaS SSO',
  'Zitadel SCIM: the official Okta guide is Okta provisioning into ZITADEL',
  'SCIM base URL `https://${ZITADEL_DOMAIN}/scim/v2/{orgId}`',
  'Okta and Microsoft Entra: the official docs cover WS-Fed, SWA/password vaulting, linked sign-on, IWA/Kerberos, header-based SSO, and non-SCIM provisioning connectors',
  'XID currently implements local baselines for WS-Fed, SWA/password vaulting, header-based SSO, and the directory connector framework',
  'Okta SCIM: the official docs state that adding SCIM provisioning to a custom app in the AIW requires first creating a SAML or SWA SSO integration that supports SCIM',
  'an OIDC integration currently cannot add SCIM provisioning',
  'Microsoft Entra SCIM: the official docs state that Entra provisioning synchronizes assigned users and groups to the target app SCIM endpoint',
  'Test Connection queries a non-existent user and expects HTTP 200 with an empty ListResponse',
  'later sync cycles run about every 40 minutes',
  'PingOne, PingFederate, AD FS, Shibboleth, and Keycloak: the official docs all cover SAML/OIDC or OIDC/OAuth upstream IdP capabilities',
  'XID lists these as SAML/OIDC upstream implemented with a legacy WS-Fed/LDAP/header baseline',
  'does not commit to linked sign-on or a native Kerberos bridge',
  'Slack: the official custom SAML docs confirm Slack is the downstream SP',
  'ACS URL `https://yourdomain.slack.com/sso/saml`',
  'Entity ID `https://slack.com`',
  'HTTP POST binding only',
  'a required signed SAML Response, NameID and User.Email',
  'no Single Logout support',
  'Slack SCIM: the official SCIM API is a downstream target API',
  'SCIM 2.0 base path `/scim/v2`',
  'a Bearer OAuth token carrying the `admin` scope',
  'an Enterprise org token obtained by installing the SCIM app on the Enterprise organization',
  'GitHub Enterprise Cloud: the official SAML docs confirm a GitHub organization connects an external IdP',
  'Organization SCIM supported IdPs are Entra ID, Okta, and OneLogin',
  'Enterprise Managed Users SCIM is IdP-to-GitHub user lifecycle management',
  'non-partner setups can use GitHub REST API endpoints for SCIM',
  'REST API SCIM is not supported for enterprises enabled for OIDC',
  'Atlassian, Salesforce, and Zoom: the official docs cover the SAML, OIDC, or SCIM capabilities of these SaaS as downstream SP or SCIM target',
  'Salesforce Help pages were browser/manual verified down to the SAML Service Provider and SCIM body text',
  'a Salesforce org or Experience Cloud site can act as a SAML SP',
  'SCIM supports user create/read/update/disable, deactivate/reactivate, and group member management',
  'XID currently has a generic outbound SAML and outbound SCIM baseline',
]

const expectedSourceMapSlackGitHubBoundaryTerms = [
  'Auth0 Enterprise Connections, Clerk Enterprise SSO, and Zitadel identity brokering confirm this role class',
  'LDAP direct bind, WS-Federation, SWA password vaulting, header-based SSO, and directory connector framework are implemented locally; linked sign-on and native IWA/Kerberos remain outside XID support',
  'Auth0 outbound SSO confirms this is a separate product surface with IdP-initiated marketplace integrations like Slack and Zoom plus custom SAML or OIDC',
  'Clerk OAuth SSO as Clerk acting as OAuth 2.0/OIDC IdP proves generic IdP role only, not SaaS app catalog production support',
  'Auth0 Inbound SCIM and Clerk Directory Sync are inbound SCIM Service Provider evidence',
  'Auth0 Inbound SCIM does not support a full `/groups` endpoint',
  'Auth0 SCIM deactivation terminates Auth0 sessions, revokes refresh tokens, and can trigger OIDC Back-Channel Logout when configured',
  'Clerk Directory Sync also revokes active sessions on deprovisioning',
  'Okta AIW SCIM provisioning requires SAML or SWA, not OIDC',
  'Microsoft Entra SCIM Test Connection expects HTTP 200 with an empty ListResponse for a non-existent user',
  'assigned user/group sync cycles run about every 40 minutes',
  'Zitadel Okta SCIM is Okta-to-ZITADEL inbound provisioning with service-account authentication and `https://${ZITADEL_DOMAIN}/scim/v2/{orgId}`',
  'Slack requires ACS URL `https://yourdomain.slack.com/sso/saml`, Entity ID `https://slack.com`, HTTP POST binding only, signed SAML Response, NameID, User.Email, and no Single Logout',
  'GitHub Enterprise Cloud requires an external IdP connected to a GitHub Enterprise Cloud organization',
  'GitHub Enterprise Managed Users OIDC is an Entra ID partner path and is not generic downstream OIDC support for XID',
  'Slack SCIM is a downstream target API at `/scim/v2` with an `admin` scope Bearer OAuth token and Enterprise org install requirements',
  'GitHub Enterprise Managed Users SCIM is IdP-to-GitHub lifecycle management',
  'REST API SCIM is not supported with enterprises enabled for OIDC',
  'XID outbound SCIM client baseline has fake SaaS SCIM target L3',
]

const expectedOidcDesignBoundaryTerms = [
  'Downstream SaaS OIDC IdP is a separate capability',
  'Microsoft Entra custom OIDC app',
  'Salesforce OIDC app',
  'Zoom OIDC app',
  'GitHub Enterprise Managed Users OIDC is an Entra ID partner path, not generic downstream OIDC support for XID',
  'Generic OIDC client evidence MUST NOT be interpreted directly as Slack, GitHub, Microsoft custom enterprise app, Atlassian, Salesforce, or Zoom being production-supported',
]

// The Chinese mirror carries the same boundary statements. Without these the whole boundary section
// could be deleted from docs/zh-Hans/design/03-*.md while the gate stayed green.
const expectedOidcDesignZhBoundaryTerms = [
  '下游 SaaS OIDC IdP 是独立能力',
  'Microsoft Entra custom OIDC app',
  'Salesforce OIDC app',
  'Zoom OIDC app',
  'GitHub Enterprise Managed Users OIDC 是 Entra ID partner path,不是 generic downstream OIDC support for XID',
  '不得把 generic OIDC client 证据直接解释为 Slack/GitHub/Microsoft custom enterprise app/Atlassian/Salesforce/Zoom production-supported',
]

const expectedOidcProtocolBoundaryTerms = [
  '## Outbound SaaS OIDC IdP',
  'XID acting as an OIDC Provider that issues ID tokens / access tokens to a downstream SaaS or to a Microsoft Entra custom enterprise app is a separate capability',
  'The generic OIDC/OAuth IdP baseline already has local L1/L2/L3',
  "Clerk OAuth SSO's Sign in with Your App proves generic OAuth 2.0/OIDC IdP capability",
  'it does not prove Slack/GitHub Enterprise/Microsoft custom enterprise app/Atlassian/Salesforce/Zoom are production-supported',
  'Downstream OIDC app catalog',
  'Fake SaaS OIDC RP callback L3 verifies authorize redirect, state, issuer, code delivery, token exchange, and DPoP userinfo',
  'Microsoft custom OIDC enterprise app template',
  'Keep separate from Microsoft account Social OAuth and Microsoft Entra inbound SSO',
  'Salesforce OIDC app template',
  'Salesforce developer docs confirm Salesforce can be configured as a relying party for a third-party OpenID provider',
  'Zoom OIDC app template',
  'GitHub Enterprise Managed Users OIDC boundary',
  'not generic downstream OIDC support for XID',
  'tests/protocols/source-map-coverage.test.mjs',
]

const expectedScimProtocolBoundaryTerms = [
  'Competitor SCIM boundary',
  'Auth0 Inbound SCIM',
  'Clerk Directory Sync SCIM 2.0 GA',
  'Zitadel Okta SCIM',
  'Okta AIW SCIM provisioning',
  'Microsoft Entra SCIM provisioning',
  'XID as SCIM Service Provider',
  'Auth0 does not support a full `/groups` endpoint',
  'Auth0 SCIM deactivation terminates Auth0 sessions, revokes refresh tokens, and can trigger OIDC Back-Channel Logout when configured',
  'Clerk Directory Sync deprovisions users by disabling/deleting from the IdP and revoking active sessions in Clerk',
  'Zitadel Okta SCIM uses `https://${ZITADEL_DOMAIN}/scim/v2/{orgId}` with service-account authentication',
  'Okta AIW SCIM provisioning requires SAML or SWA, not OIDC',
  'Microsoft Entra Test Connection expects HTTP 200 empty ListResponse for a non-existent user',
  'assigned user/group sync cycles run about every 40 minutes',
  'real IdP provisioning config/callback and production L4 are missing',
  'Downstream SaaS SCIM target clients',
  'Slack, GitHub Enterprise Cloud, Atlassian, Salesforce, and Zoom expose SCIM target APIs',
  'Browser/manual verified Salesforce SCIM docs confirm REST API create/read/update/disable user operations, deactivate/reactivate behavior, and group member management',
  'Slack SCIM uses `/scim/v2` and an `admin` scope Bearer OAuth token',
  'GitHub Enterprise Managed Users SCIM is IdP-to-GitHub lifecycle management',
  'REST API SCIM is not supported with enterprises enabled for OIDC',
  'XID has a local outbound SCIM client baseline',
  'fake SaaS SCIM target L3',
]

const expectedEnterpriseSsoDesignBoundaryTerms = [
  '## 2. Downstream SaaS SSO (XID as the IdP)',
  'the outbound SAML IdP has shipped (local L1-L3)',
  'The `saml_service_providers` schema is already in use as the downstream SP registry',
  'Real Slack, GitHub, Microsoft, Atlassian, Salesforce, and Zoom admin L4 evidence is still missing',
  'SAML Single Logout MUST NOT currently be claimed as production-supported for Slack',
  '## 7.1 Enterprise legacy protocols (local baseline)',
  'LDAP direct bind',
  'WS-Federation passive sign-in',
  'SWA/password vaulting',
  'header-based SSO',
  'directory connector framework',
  '## 7.2 Kerberos / IWA deployment patterns (documentation only)',
]

const expectedSamlOutboundBoundaryTerms = [
  'Auth0 outbound SSO marketplace and custom SAML/OIDC docs prove this is a distinct downstream product surface',
  'it MUST NOT be substituted by inbound SAML SP, generic OAuth/OIDC IdP, Social OAuth, or Clerk OAuth SSO comparison',
  'Generic outbound SAML can emit Slack-required signed Response, POST binding, NameID, and User.Email',
  'GitHub Enterprise Managed Users OIDC is an Entra ID partner path, not generic downstream OIDC support for XID',
]

const expectedGapAuditOpenBoundaryTerms = [
  'Auth0 outbound SSO marketplace and custom SAML/OIDC docs prove this is a distinct downstream product surface',
  'Clerk OAuth SSO only proves generic OAuth/OIDC IdP role',
  'Slack requires signed SAML Response, HTTP POST binding, ACS `https://yourdomain.slack.com/sso/saml`, Entity ID `https://slack.com`, NameID, User.Email, and no SLO',
  'Enterprise Managed Users OIDC remains an Entra ID partner path',
  'Auth0 Inbound SCIM, Clerk Directory Sync, Zitadel Okta SCIM, Okta AIW SCIM, and Microsoft Entra SCIM provisioning are inbound Service Provider comparison evidence only',
  'Slack SCIM uses `/scim/v2` with `admin` scope Bearer token',
  'REST API SCIM is not supported with enterprises enabled for OIDC',
  'Generic OIDC client tests, Social OAuth callbacks, Clerk OAuth SSO comparison, and inbound enterprise SSO callbacks are not evidence for SaaS-specific production support',
  'Real Microsoft Entra, Okta, Auth0, Clerk, or Zitadel provisioning into XID can close inbound SCIM L4 only',
]

const expectedEnterpriseSsoDesignScimTargetTerms = [
  '## 3. Downstream SaaS SCIM target clients',
  'This role is the inverse of section 6',
  'XID acting as an outbound SCIM client pushing users and groups to a SaaS target',
  'the downstream SaaS SCIM target client has shipped (local L1-L3)',
  'Inbound SCIM Service Provider evidence, local inbound SCIM CRUD L3, and real IdP provisioning L4 MUST NOT be reused as outbound SCIM target L4',
  'Target registration',
  'Token storage',
  'Sync endpoint',
  'fake SaaS SCIM at L3',
  'Real Slack, GitHub Enterprise, Atlassian, Salesforce, and Zoom admin L4 evidence is still missing',
]

// Chinese mirror of expectedEnterpriseSsoDesignBoundaryTerms plus
// expectedEnterpriseSsoDesignScimTargetTerms, so section 2 / 3 / 7.1 / 7.2 cannot be rewritten into
// a production-supported claim in one language only.
const expectedEnterpriseSsoDesignZhBoundaryTerms = [
  '## 2. 下游 SaaS SSO(我们作为 IdP)',
  'outbound SAML IdP 已落地(本地 L1-L3)',
  '`saml_service_providers` schema 已作为下游 SP 注册表使用',
  '真实 Slack/GitHub/Microsoft/Atlassian/Salesforce/Zoom admin L4 仍缺',
  'SAML Single Logout 当前不支持对 Slack production-supported 声称',
  '## 7.1 企业 legacy 协议(本地 baseline)',
  'LDAP direct bind',
  'WS-Federation passive sign-in',
  'SWA/password vaulting',
  'header-based SSO',
  'directory connector framework',
  '## 7.2 Kerberos / IWA 部署模式(文档-only)',
]

const expectedEnterpriseSsoDesignZhScimTargetTerms = [
  '## 3. 下游 SaaS SCIM target clients',
  '此角色与第 6 节相反',
  'XID 作为 outbound SCIM client 向 SaaS target 推送用户和组',
  'downstream SaaS SCIM target client 已落地(本地 L1-L3)',
  '不能把 inbound SCIM Service Provider 证据、local inbound SCIM CRUD L3 或真实 IdP provisioning L4 复用为 outbound SCIM target L4',
  'Target 注册',
  'Token 存储',
  'Sync endpoint',
  'fake SaaS SCIM L3',
  '真实 Slack/GitHub Enterprise/Atlassian/Salesforce/Zoom admin L4 仍缺',
]

// Anti-overclaim guards.
//
// Scope, stated precisely because an overstated guard is the exact failure mode these exist to
// prevent: each entry matches a small enumerated set of *claim shapes* (adverb plus support verb,
// one-shot plus no-phasing) within a single sentence. That covers the canonical phrasings and the
// common rewordings of them, and it does NOT cover arbitrary paraphrase. A sufficiently novel
// wording ("wall-to-wall support") escapes, by construction -- a whitelist of shapes cannot be
// closed. Treat these as regression guards over known overclaim shapes, not as a general-purpose
// overclaim detector. The load-bearing honesty control is the per-cell support matrix in
// `docs/protocols/**`, which is asserted exactly; this is a secondary net over prose.
//
// Matching is deliberately biased toward false negatives. A false positive here turns `pnpm check`
// red, which blocks the production build, and it does so on *honest* wording -- which would teach
// the next writer to soften a truthful denial or delete the guard. An escape only costs one round of
// prose review.
//
// Hence `denialAware`: for support claims, a sentence carrying any denial marker is skipped rather
// than parsed, so "does not provide full support for X" stays green. It is off for the one-shot
// family, where "no phasing" is *part of the claim* rather than a denial of it -- skipping on "no"
// there would disarm the guard against the very sentence it exists to catch.
const SENTENCE_SPLIT = /[.。!?！？]+/u
const DENIAL_EN =
  /\b(?:not|never|no|without|lacks?|lacking|missing|absent|cannot|can't|isn't|aren't|doesn't|don't|won't|yet to|far from|short of|rather than|instead of)\b/iu
// Bare 无 is deliberately absent: it occurs inside 无密码 (passwordless) and 无状态 (stateless), so
// treating it as a denial marker would skip the exact sentences these guards must inspect.
const DENIAL_ZH = /[不未没缺]|并非|无法|并无|尚待|谈不上|算不上/u

// A claim is a set of patterns that must all appear in one sentence. Co-occurrence rather than
// ordering, because either language lets the subject precede or follow the support verb, and
// enumerating the permutations was how the previous version let "supports passwordless fully" slip.
const overclaim = (label, patterns, { denialAware = true } = {}) => ({
  label,
  patterns,
  denialAware,
})

const matchesOverclaim = (text, claim) =>
  text.split(SENTENCE_SPLIT).some((sentence) => {
    if (claim.denialAware && (DENIAL_EN.test(sentence) || DENIAL_ZH.test(sentence))) return false
    return claim.patterns.every((pattern) => pattern.test(sentence))
  })

// An adverb can sit several words from its verb ("fully, and in production, supports"), so the two
// halves of a support shape get a short gap. Sentences are already split, so it cannot cross one.
const ADVERB_VERB_GAP = String.raw`[^.]{0,40}?`

// "full support matrix" / "支持矩阵" name an artifact, they do not claim a support level.
const NOT_AN_ARTIFACT_EN = String.raw`(?!\s+(?:matrix|matrices|level|levels|table|tables|status|tier|tiers|claim|claims))`
const NOT_AN_ARTIFACT_ZH = String.raw`(?!(?:矩阵|等级|级别|层级|表|状态))`

// "fully / completely / entirely / comprehensively supported", in either order, plus the
// noun-with-predicate-adjective shape ("passwordless support is complete").
const SCOPE_ADVERB_EN = String.raw`\b(?:full|fully|complete|completely|comprehensive|comprehensively|entire|entirely|total|totally)\b`
const FULL_SUPPORT_EN = String.raw`(?:${SCOPE_ADVERB_EN}${ADVERB_VERB_GAP}\bsupport(?:s|ed|ing)?\b${NOT_AN_ARTIFACT_EN}|\bsupport(?:s|ed|ing)?${ADVERB_VERB_GAP}${SCOPE_ADVERB_EN}|\bsupport\b${ADVERB_VERB_GAP}\b(?:is|are|was|were)\s+(?:now\s+|already\s+)?${SCOPE_ADVERB_EN})`
// 全功能支持 / 完全支持 / 全面支持 / 均已支持 / 支持全部, plus the 地 adverbial infix.
const FULL_SUPPORT_ZH = String.raw`(?:(?:全功能|完全|完整|全面|全部|悉数|统统|均已|都已|已全部|已完全)地?支持${NOT_AN_ARTIFACT_ZH}|支持(?:全部|所有|全量))`

// "delivered in one shot" paired with "no phased / pre-launch / post-launch split".
const ONE_SHOT_EN = String.raw`(?:\ball at once\b|\bin one (?:shot|go|pass|release|batch)\b|\bone[-\s]shot\b|\bsingle[-\s](?:shot|release|phase|batch|drop)\b|\bbig[-\s]bang\b)`
const NO_PHASING_EN = String.raw`(?:\bno\s+(?:pre[-\s/]?(?:launch|post)|phase|phases|phased|phasing|staged|staging|sequencing)\b|\bnot\s+phased\b|\bwithout\s+(?:phases|phasing|a\s+phased\s+rollout|staging|staged\s+rollout)\b)`
const ONE_SHOT_ZH = String.raw`(?:一次性?(?:做全|做完|交付|上线|完成|全量|全部)|一步到位|一把梭|一轮(?:做完|交付))`
const NO_PHASING_ZH = String.raw`(?:无(?:前置|后置|分期|分阶段|阶段|灰度)|不分(?:阶段|期|前后)|没有(?:前置|后置|分期|阶段|灰度)|不做(?:分期|灰度|分阶段))`

// "the whole scope is delivered in one shot, with no pre-launch/post-launch split". Both halves are
// required, which is what keeps an honest "ships in one go, and no stage blocks login" green.
const forbiddenOverviewScopeClaims = [
  overclaim(
    'one-shot delivery with no phasing (en)',
    [new RegExp(ONE_SHOT_EN, 'iu'), new RegExp(NO_PHASING_EN, 'iu')],
    { denialAware: false },
  ),
  overclaim(
    'one-shot delivery with no phasing (zh)',
    [new RegExp(ONE_SHOT_ZH, 'iu'), new RegExp(NO_PHASING_ZH, 'iu')],
    { denialAware: false },
  ),
]

// "fully supports password, social, passwordless, MFA, and enterprise SSO"
const forbiddenAuthSupportClaims = [
  overclaim('full auth support (en)', [new RegExp(FULL_SUPPORT_EN, 'iu'), /\bpasswordless\b/iu]),
  overclaim('full auth support (zh)', [new RegExp(FULL_SUPPORT_ZH, 'iu'), /passwordless|无密码/iu]),
]

// Inbound SCIM prose overclaims. The table-cell guard below only sees `| SCIM users and groups |
// production L4`, so an overclaim written as a sentence anywhere else in the file escapes it.
// Boundary text that denies the claim ("MUST NOT promise production-supported") carries a denial
// marker, so `matchesOverclaim` drops its sentence before these patterns ever run.
const forbiddenInboundScimProseClaims = [
  overclaim('inbound SCIM is production-supported', [
    /\binbound SCIM\b/iu,
    /\b(?:is|are|has|have)\s+(?:now\s+|already\s+)?(?:production[-\s](?:supported|ready|proven)|generally available)\b/iu,
  ]),
  overclaim('production-supported inbound SCIM', [
    /\b(?:production[-\s](?:supported|ready|proven)|generally available)\s+inbound SCIM\b/iu,
  ]),
  overclaim('inbound SCIM fully supported', [
    new RegExp(FULL_SUPPORT_EN, 'iu'),
    /\binbound SCIM\b/iu,
  ]),
  overclaim('inbound SCIM has reached L4', [
    /\binbound SCIM\b/iu,
    /\b(?:has|have|carries|carry|holds|hold|reached|reaches)\s+(?:real\s+)?(?:IdP\s+)?(?:provisioning\s+)?L4\b/iu,
  ]),
]

const expectedSecurityProfileRows = [
  'ACR URIs',
  'AMR vocabulary',
  'Browser-Based Apps draft',
  'FAPI 2.0',
  'GNAP, UMA, HEART, OID4VP, OID4VCI',
  'NIST AAL1',
  'NIST AAL2',
  'NIST AAL3',
  'OAuth 2.1 baseline',
  'OAuth Security BCP',
  'Shared Signals, CAEP, RISC',
]

const expectedPublicDocSlugs = [
  'branding',
  'enterprise-sso',
  'getting-started',
  'hosted-auth',
  'management-api',
  'oidc-oauth',
  'organizations',
  'saml',
  'scim',
  'sdks',
  'sdks/android',
  'sdks/angular',
  'sdks/astro',
  'sdks/backend',
  'sdks/core',
  'sdks/dotnet',
  'sdks/electron',
  'sdks/expo',
  'sdks/flutter',
  'sdks/go',
  'sdks/ios',
  'sdks/java',
  'sdks/linux',
  'sdks/macos',
  'sdks/nextjs',
  'sdks/nuxt',
  'sdks/php',
  'sdks/python',
  'sdks/react',
  'sdks/react-native',
  'sdks/remix',
  'sdks/ruby',
  'sdks/rust',
  'sdks/solid',
  'sdks/svelte',
  'sdks/tauri',
  'sdks/vue',
  'sdks/windows',
  'self-hosting',
  'social-login',
  'webhooks',
]

const forbiddenPublicDocSlugs = ['goal', 'design', 'verification', 'protocols', 'gap-audit']

const publicDocsGuardTestPaths = [
  publicDocsRegistryTestPath,
  publicDocsGenerationTestPath,
  siteWorkerTestPath,
  siteDistAuditPath,
]

const internalDocSlugsRequiredInGuard = [
  'design',
  'goal',
  'verification',
  'api-contracts',
  'deployment',
]

const standardsRefreshRequiredTerms = [
  'draft-ietf-oauth-v2-1-15',
  '2026-03-02',
  'draft-ietf-oauth-browser-based-apps-26',
  'RFC Ed Queue',
  '2026-05-20',
  'W3C Candidate Recommendation Snapshot',
  '2026-05-26',
  'NIST SP 800-63-4 final',
  '2025-07',
  'OpenID Shared Signals Framework 1.0, CAEP 1.0, and RISC 1.0 are Final',
]

const expectedL3TestPaths = [
  'apps/server/tests/smoke/l3-passkey-browser.test.mjs',
  'apps/server/tests/smoke/l3-password-browser.test.mjs',
  'apps/server/tests/smoke/l3-protocol-client.test.mjs',
  'apps/server/tests/smoke/l3-password-reset-browser.test.mjs',
]

const expectedL3ProtocolClientFeatures = [
  'Authorization code',
  'PAR',
  'DPoP',
  'OIDC userinfo',
  'SCIM Users',
  'SCIM Groups',
  'SCIM PATCH and error model',
]

const expectedOutboundSaaSConformanceTerms = [
  'fake SP L3',
  'outbound IdP metadata',
  'SP-initiated SAMLRequest handling',
  'IdP-initiated launch',
  'signed Response',
  'ACS POST',
  'NameID/email mapping',
  'RelayState guard',
  'org membership gate',
  'Generic customer-app OAuth/OIDC L3 evidence',
  'Clerk-style OAuth SSO comparison evidence',
  'Social OAuth provider callback evidence',
  'SaaS app catalog behavior',
  'claim-mapping contract',
  'Fake SP L3 is a local implementation gate only',
  'Slack template',
  'GitHub Enterprise template',
  'Microsoft custom enterprise app template',
  'Atlassian template',
  'Salesforce template',
  'Zoom template',
  'real Slack Enterprise, GitHub Enterprise Cloud, Microsoft Entra custom enterprise app, Atlassian, Salesforce, and Zoom admin runs',
  'real Slack Enterprise, GitHub Enterprise Cloud, Microsoft Entra custom enterprise app, Atlassian, Salesforce, and Zoom admin runs',
  'Outbound SaaS SSO L4 evidence must be recorded per SaaS role',
  'Slack Enterprise',
  'GitHub Enterprise Cloud',
  'Microsoft custom enterprise app',
  'Atlassian',
  'Salesforce',
  'Zoom',
  'Generic OIDC client L4',
  'cannot be reused as outbound SaaS SSO L4',
]

const expectedDownstreamScimConformanceTerms = [
  'Inbound SCIM Service Provider L3 is only a provider-ready gate',
  'must not claim Auth0, Clerk, Zitadel, Okta, Microsoft Entra, or other real IdP provisioning completion',
  'real IdP provisioning run proves Users/Groups, schema, PATCH, active deprovisioning, token handling, and audit behavior',
  'Inbound SCIM Service Provider',
  'real directory/IdP provisioning app configured against XID `/scim/v2`',
  'Okta SCIM must use SAML or SWA integration rather than OIDC',
  'Microsoft Entra Test Connection must return HTTP 200 empty ListResponse for a non-existent user',
  'Auth0/Clerk/Zitadel comparisons remain role evidence, not XID L4',
  'Downstream SaaS SCIM target clients have left `planned` for the local baseline',
  'fake SaaS SCIM L3',
  'outbound SCIM target config',
  'secret ref lookup',
  'user create',
  'active=false PATCH mapping',
  'group create',
  'membership push',
  'retry/audit behavior',
  'Inbound SCIM Service Provider L3 evidence does not prove SCIM push-to-SaaS',
  'Downstream SaaS SCIM target clients',
  'outbound SCIM client implementation',
  'per-SaaS endpoint templates',
  'encrypted token storage or secret refs',
  'Slack template',
  'GitHub Enterprise Cloud template',
  'Atlassian template',
  'Salesforce template',
  'Zoom template',
  'real Slack Enterprise, GitHub Enterprise Cloud, Atlassian, Salesforce, and Zoom admin runs',
  'Downstream SaaS SCIM target L4 evidence must be recorded per SaaS role',
  'Business+ or Enterprise plan',
  '`/scim/v2` Users/Groups create/update/deactivate',
  'Enterprise Managed Users setup',
  'Atlassian Guard org admin setup',
  'SCIM user identity management configuration',
  'SCIM2 Users/Groups create/update/deactivate',
  'cannot be reused as downstream SaaS SCIM target L4',
]

const expectedFakeSaaSOidcRpTerms = [
  'configure fake OIDC RP redirect URI',
  'fake SaaS OIDC RP callback',
  'fake OIDC RP did not receive callback',
]

const expectedProviderScimTargetRows = [
  'Atlassian',
  'GitHub Enterprise Cloud',
  'Salesforce',
  'Slack',
  'Zoom',
]

const packageFilterRoots = {
  '@xid-kit/protocol': 'packages/protocol',
  '@xid-kit/saml': 'packages/saml',
  '@xid-kit/server': 'apps/server',
  '@xid-kit/webauthn': 'packages/webauthn',
}

const allowedSupports = new Set([
  'implemented',
  'provider-ready',
  'guarded-disabled',
  'planned',
  'not-supported',
  'deprecated-rejected',
])

const supportRequiringCoverage = new Set([
  'implemented',
  'provider-ready',
  'guarded-disabled',
  'not-supported',
  'deprecated-rejected',
])

const p0SourceMapFeatures = [
  'Authorization code',
  'PKCE S256',
  'Redirect URI exact match',
  'State nonce and mix-up protection',
  'Authorization code one-time use',
  'Refresh rotation and replay detection',
  'OAuth discovery metadata',
  'JWT issuer audience kid alg allowlist',
  'OIDC ID token',
  'OIDC userinfo',
  'OIDC ACR/AMR/auth_time and max_age',
  'DPoP',
  'PAR',
  'Protected resource metadata',
  'Introspection',
  'Revocation',
  'SAML ACS',
  'SAML Destination and bearer SubjectConfirmation',
  'SAML XML security precheck and signature structure whitelist',
  'SAML JIT',
  'OIDC enterprise JIT',
  'SCIM Users',
  'SCIM Groups',
  'SCIM PATCH and error model',
  'WebAuthn registration',
  'WebAuthn authentication',
  'Session cookie and /v1/me',
  'Soft deleted and revoked subject gates',
  'Webhook delivery',
  'Public docs whitelist',
]

const criticalRuntimeFeatures = new Set([
  'OAuth discovery metadata',
  'JWKS',
  'JWKS cache',
  'Authorization code',
  'Client credentials',
  'PKCE S256',
  'Redirect URI exact match',
  'State nonce and mix-up protection',
  'Authorization code one-time use',
  'Refresh rotation and replay detection',
  'Refresh token hash storage',
  'RFC9207 issuer response',
  'Form post response mode',
  'Token endpoint duplicate parameter rejection',
  'DPoP',
  'Resource Indicators',
  'Protected resource metadata',
  'JWT issuer audience kid alg allowlist',
  'PAR',
  'Token exchange access token',
  'DCR',
  'Introspection',
  'Revocation',
  'OIDC ID token',
  'OIDC userinfo',
  'RP-initiated logout',
  'OIDC ACR/AMR/auth_time and max_age',
  'NIST AAL1',
  'NIST AAL2',
  'ACR URIs',
  'AMR vocabulary',
  'SAML metadata',
  'SP metadata',
  'SP-initiated login',
  'SAML ACS',
  'SAML Destination and bearer SubjectConfirmation',
  'SAML EncryptedAssertion',
  'SAML JIT',
  'OIDC enterprise JIT',
  'SCIM ServiceProviderConfig',
  'Directory bearer token',
  'SCIM Schemas and ResourceTypes',
  'SCIM Users',
  'SCIM Groups',
  'ListResponse pagination',
  'SCIM simple filters and invalidFilter guard',
  'SCIM attributes projection',
  'SCIM PATCH and error model',
  'Registration options',
  'WebAuthn registration',
  'WebAuthn authentication',
  'WebAuthn malformed input normalization',
  'Discoverable credentials',
  'Backup eligibility/state storage',
  'TOTP MFA',
  'Backup codes',
  'SMS MFA',
  'Session cookie and /v1/me',
  'Pending MFA session',
  'Soft deleted and revoked subject gates',
  'Public docs whitelist',
])

const providerReadyRequiredTerms = /\b(real|production)\b/i
const providerReadyExternalInputTerms =
  /\b(secret|config|callback|OTP|metadata|SAMLResponse|user_code|E2E)\b/i

const matrixSourceMapAliases = {
  'docs/protocols/oauth.md::Assertion grants': 'Assertion grants',
  'docs/protocols/oauth.md::Client credentials': 'Client credentials',
  'docs/protocols/oauth.md::Device authorization grant': 'Device flow',
  'docs/protocols/oauth.md::Dynamic client registration': 'DCR',
  'docs/protocols/oauth.md::Implicit and password grant': 'Implicit and password grant',
  'docs/protocols/oauth.md::Protected resource metadata': 'Protected resource metadata',
  'docs/protocols/oauth.md::RFC9207 authorization response issuer': 'RFC9207 issuer response',
  'docs/protocols/oauth.md::Refresh rotation': 'Refresh rotation and replay detection',
  'docs/protocols/oidc.md::ACR/AMR/auth_time': 'OIDC ACR/AMR/auth_time and max_age',
  'docs/protocols/oidc.md::Back-channel logout profile': 'OIDC back-channel logout profile',
  'docs/protocols/oidc.md::CIBA': 'OIDC CIBA',
  'docs/protocols/oidc.md::Discovery': 'OAuth discovery metadata',
  'docs/protocols/oidc.md::FAPI 2.0': 'FAPI 2.0 profile',
  'docs/protocols/oidc.md::Federation': 'OpenID Federation',
  'docs/protocols/oidc.md::Form post response mode': 'Form post response mode',
  'docs/protocols/oidc.md::Front-channel logout': 'OIDC front-channel logout profile',
  'docs/protocols/oidc.md::Hybrid response type': 'OIDC hybrid response type',
  'docs/protocols/oidc.md::ID token code flow': 'OIDC ID token',
  'docs/protocols/oidc.md::JWKS': 'JWKS',
  'docs/protocols/oidc.md::Nonce': 'Nonce',
  'docs/protocols/oidc.md::OIDC Dynamic Client Registration': 'OIDC Dynamic Client Registration',
  'docs/protocols/oidc.md::Session Management': 'OIDC Session Management',
  'docs/protocols/oidc.md::Userinfo': 'OIDC userinfo',
  'docs/protocols/oidc.md::Downstream OIDC app catalog': 'Downstream OIDC app catalog',
  'docs/protocols/oidc.md::Microsoft custom OIDC enterprise app template':
    'Microsoft custom enterprise app downstream SSO',
  'docs/protocols/oidc.md::Salesforce OIDC app template':
    'Salesforce downstream SAML/OIDC template',
  'docs/protocols/oidc.md::Zoom OIDC app template': 'Zoom downstream SAML/OIDC template',
  'docs/protocols/provider-compatibility.md::AD FS': 'AD FS provider compatibility',
  'docs/protocols/provider-compatibility.md::Apple': 'Apple social OAuth provider',
  'docs/protocols/provider-compatibility.md::Atlassian': 'Atlassian downstream SAML template',
  'docs/protocols/provider-compatibility.md::GitHub': 'GitHub social OAuth provider',
  'docs/protocols/provider-compatibility.md::GitHub Enterprise Cloud':
    'GitHub Enterprise downstream SAML template',
  'docs/protocols/provider-compatibility.md::Google': 'Google social OAuth provider',
  'docs/protocols/provider-compatibility.md::Google Workspace':
    'Google Workspace provider compatibility',
  'docs/protocols/provider-compatibility.md::Infobip': 'Infobip SMS OTP provider',
  'docs/protocols/provider-compatibility.md::JumpCloud': 'JumpCloud provider compatibility',
  'docs/protocols/provider-compatibility.md::Keycloak': 'Keycloak provider compatibility',
  'docs/protocols/provider-compatibility.md::MessageBird': 'MessageBird SMS OTP provider',
  'docs/protocols/provider-compatibility.md::Meta WhatsApp': 'Meta WhatsApp OTP provider',
  'docs/protocols/provider-compatibility.md::Microsoft Entra ID':
    'Microsoft Entra ID provider compatibility',
  'docs/protocols/provider-compatibility.md::Microsoft account':
    'Microsoft account social OAuth provider',
  'docs/protocols/provider-compatibility.md::Microsoft custom enterprise app':
    'Microsoft custom enterprise app downstream SSO',
  'docs/protocols/provider-compatibility.md::Okta': 'Okta provider compatibility',
  'docs/protocols/provider-compatibility.md::OneLogin': 'OneLogin provider compatibility',
  'docs/protocols/provider-compatibility.md::PingFederate': 'PingFederate provider compatibility',
  'docs/protocols/provider-compatibility.md::PingOne': 'PingOne provider compatibility',
  'docs/protocols/provider-compatibility.md::Shibboleth': 'Shibboleth provider compatibility',
  'docs/protocols/provider-compatibility.md::Salesforce':
    'Salesforce downstream SAML/OIDC template',
  'docs/protocols/provider-compatibility.md::Slack': 'Slack downstream SAML template',
  'docs/protocols/provider-compatibility.md::Twilio': 'Twilio SMS and WhatsApp OTP provider',
  'docs/protocols/provider-compatibility.md::Vonage': 'Vonage SMS OTP provider',
  'docs/protocols/provider-compatibility.md::Zoom': 'Zoom downstream SAML/OIDC template',
  'docs/protocols/saml.md::ACS POST': 'SAML ACS',
  'docs/protocols/saml.md::Audience, recipient, destination, confirmation method validation':
    'SAML Destination and bearer SubjectConfirmation',
  'docs/protocols/saml.md::EncryptedAssertion': 'SAML EncryptedAssertion',
  'docs/protocols/saml.md::Atlassian SAML app template': 'Atlassian downstream SAML template',
  'docs/protocols/saml.md::GitHub Enterprise Cloud SAML template':
    'GitHub Enterprise downstream SAML template',
  'docs/protocols/saml.md::IdP metadata': 'Outbound SAML IdP metadata',
  'docs/protocols/saml.md::IdP-initiated outbound app launch': 'Outbound SAML IdP SSO endpoint',
  'docs/protocols/saml.md::InResponseTo and replay': 'InResponseTo and replay',
  'docs/protocols/saml.md::JIT provisioning': 'SAML JIT',
  'docs/protocols/saml.md::Microsoft custom SAML app template':
    'Microsoft custom enterprise app downstream SSO',
  'docs/protocols/saml.md::Outbound SAML Single Logout': 'Outbound SAML SLO',
  'docs/protocols/saml.md::RelayState guard': 'RelayState guard',
  'docs/protocols/saml.md::Salesforce SAML app template':
    'Salesforce downstream SAML/OIDC template',
  'docs/protocols/saml.md::Signed Response or Assertion': 'Outbound SAML IdP SSO endpoint',
  'docs/protocols/saml.md::Slack custom SAML template': 'Slack downstream SAML template',
  'docs/protocols/saml.md::SP metadata': 'SP metadata',
  'docs/protocols/saml.md::SP-initiated login': 'SP-initiated login',
  'docs/protocols/saml.md::SP-initiated outbound login': 'Outbound SAML IdP SSO endpoint',
  'docs/protocols/saml.md::Single Logout': 'SAML SLO',
  'docs/protocols/saml.md::XML security precheck and signature structure whitelist':
    'SAML XML security precheck and signature structure whitelist',
  'docs/protocols/saml.md::XML signature validation': 'XML signature validation',
  'docs/protocols/saml.md::Zoom SAML app template': 'Zoom downstream SAML/OIDC template',
  'docs/protocols/scim.md::Directory bearer token': 'Directory bearer token',
  'docs/protocols/scim.md::ETag If-Match': 'SCIM ETag If-Match',
  'docs/protocols/scim.md::Full filter grammar': 'SCIM full filter grammar',
  'docs/protocols/scim.md::Groups CRUD': 'SCIM Groups',
  'docs/protocols/scim.md::ListResponse pagination': 'ListResponse pagination',
  'docs/protocols/scim.md::PATCH': 'PATCH',
  'docs/protocols/scim.md::ResourceTypes': 'SCIM Schemas and ResourceTypes',
  'docs/protocols/scim.md::Schemas': 'SCIM Schemas and ResourceTypes',
  'docs/protocols/scim.md::ServiceProviderConfig': 'SCIM ServiceProviderConfig',
  'docs/protocols/scim.md::Simple list filters': 'SCIM simple filters and invalidFilter guard',
  'docs/protocols/scim.md::Competitor SCIM boundary': 'SCIM Users',
  'docs/protocols/scim.md::Users CRUD': 'SCIM Users',
  'docs/protocols/scim.md::attributes/excludedAttributes': 'SCIM attributes projection',
  'docs/protocols/scim.md::bulk': 'bulk',
  'docs/protocols/scim.md::sort': 'sort',
  'docs/protocols/security-profiles.md::ACR URIs': 'ACR URIs',
  'docs/protocols/security-profiles.md::AMR vocabulary': 'AMR vocabulary',
  'docs/protocols/security-profiles.md::FAPI 2.0': 'FAPI 2.0 profile',
  'docs/protocols/security-profiles.md::NIST AAL1': 'NIST AAL1',
  'docs/protocols/security-profiles.md::NIST AAL2': 'NIST AAL2',
  'docs/protocols/security-profiles.md::OAuth 2.1 baseline': 'Authorization code',
  'docs/protocols/security-profiles.md::OAuth Security BCP': 'Authorization code',
  'docs/protocols/tokens-sessions.md::Access token revocation denylist':
    'Access token revocation denylist',
  'docs/protocols/tokens-sessions.md::Audit event hash chain': 'Audit event hash chain',
  'docs/protocols/tokens-sessions.md::Audit PII redaction': 'Audit PII redaction',
  'docs/protocols/tokens-sessions.md::Instance signing keys': 'Instance signing keys',
  'docs/protocols/tokens-sessions.md::JWKS cache': 'JWKS cache',
  'docs/protocols/tokens-sessions.md::JWT alg allowlist': 'JWT alg allowlist',
  'docs/protocols/tokens-sessions.md::Pending MFA session': 'Pending MFA session',
  'docs/protocols/tokens-sessions.md::Refresh auth context carry-forward':
    'Refresh auth context carry-forward',
  'docs/protocols/tokens-sessions.md::Refresh family revoke': 'Refresh family revoke',
  'docs/protocols/tokens-sessions.md::Refresh token hash storage': 'Refresh token hash storage',
  'docs/protocols/tokens-sessions.md::Session auth context': 'Session auth context',
  'docs/protocols/tokens-sessions.md::Session cookie': 'Session cookie and /v1/me',
  'docs/protocols/tokens-sessions.md::Step-up credential': 'Step-up credential',
  'docs/protocols/tokens-sessions.md::Webhook delivery': 'Webhook delivery',
  'docs/protocols/tokens-sessions.md::Webhook verification SDK': 'Webhook verification SDK',
  'docs/protocols/webauthn-passkeys.md::AAL/ACR/AMR mapping': 'AAL/ACR/AMR mapping',
  'docs/protocols/webauthn-passkeys.md::Authentication verification': 'Authentication verification',
  'docs/protocols/webauthn-passkeys.md::Backup codes': 'Backup codes',
  'docs/protocols/webauthn-passkeys.md::Backup eligibility/state storage':
    'Backup eligibility/state storage',
  'docs/protocols/webauthn-passkeys.md::Discoverable credentials': 'Discoverable credentials',
  'docs/protocols/webauthn-passkeys.md::EdDSA WebAuthn algorithm': 'WebAuthn EdDSA COSE alg',
  'docs/protocols/webauthn-passkeys.md::Enterprise attestation': 'WebAuthn enterprise attestation',
  'docs/protocols/webauthn-passkeys.md::Malformed WebAuthn data handling':
    'WebAuthn malformed input normalization',
  'docs/protocols/webauthn-passkeys.md::Passkey as MFA': 'Passkey as MFA',
  'docs/protocols/webauthn-passkeys.md::Registration options': 'Registration options',
  'docs/protocols/webauthn-passkeys.md::Registration verification': 'Registration verification',
  'docs/protocols/webauthn-passkeys.md::SMS MFA': 'SMS MFA',
  'docs/protocols/webauthn-passkeys.md::Sign count clone detection': 'Sign count clone detection',
}

const dedicatedCoverageTargets = {
  'docs/protocols/oauth.md::Assertion grants': 'Assertion grants',
  'docs/protocols/oauth.md::Client credentials': 'Client credentials',
  'docs/protocols/oauth.md::Device authorization grant': 'Device flow',
  'docs/protocols/oauth.md::Dynamic client registration': 'DCR',
  'docs/protocols/oauth.md::Implicit and password grant': 'Implicit and password grant',
  'docs/protocols/oauth.md::Protected resource metadata': 'Protected resource metadata',
  'docs/protocols/oauth.md::RFC9207 authorization response issuer': 'RFC9207 issuer response',
  'docs/protocols/oauth.md::Refresh rotation': 'Refresh rotation and replay detection',
  'docs/protocols/oidc.md::ACR/AMR/auth_time': 'OIDC ACR/AMR/auth_time and max_age',
  'docs/protocols/oidc.md::Back-channel logout profile': 'OIDC back-channel logout profile',
  'docs/protocols/oidc.md::CIBA': 'OIDC CIBA',
  'docs/protocols/oidc.md::Discovery': 'OAuth discovery metadata',
  'docs/protocols/oidc.md::Form post response mode': 'Form post response mode',
  'docs/protocols/oidc.md::Front-channel logout': 'OIDC front-channel logout profile',
  'docs/protocols/oidc.md::FAPI 2.0': 'FAPI 2.0 profile',
  'docs/protocols/oidc.md::Federation': 'OpenID Federation',
  'docs/protocols/oidc.md::Hybrid response type': 'OIDC hybrid response type',
  'docs/protocols/oidc.md::ID token code flow': 'OIDC ID token',
  'docs/protocols/oidc.md::JWKS': 'JWKS',
  'docs/protocols/oidc.md::Nonce': 'Nonce',
  'docs/protocols/oidc.md::OIDC Dynamic Client Registration': 'OIDC Dynamic Client Registration',
  'docs/protocols/oidc.md::Session Management': 'OIDC Session Management',
  'docs/protocols/oidc.md::Userinfo': 'OIDC userinfo',
  'docs/protocols/oidc.md::Downstream OIDC app catalog': 'Downstream OIDC app catalog',
  'docs/protocols/oidc.md::Microsoft custom OIDC enterprise app template':
    'Microsoft custom enterprise app downstream SSO',
  'docs/protocols/oidc.md::Salesforce OIDC app template':
    'Salesforce downstream SAML/OIDC template',
  'docs/protocols/oidc.md::Zoom OIDC app template': 'Zoom downstream SAML/OIDC template',
  'docs/protocols/provider-compatibility.md::AD FS': 'AD FS provider compatibility',
  'docs/protocols/provider-compatibility.md::Apple': 'Apple social OAuth provider',
  'docs/protocols/provider-compatibility.md::Atlassian': 'Atlassian downstream SAML template',
  'docs/protocols/provider-compatibility.md::GitHub': 'GitHub social OAuth provider',
  'docs/protocols/provider-compatibility.md::GitHub Enterprise Cloud':
    'GitHub Enterprise downstream SAML template',
  'docs/protocols/provider-compatibility.md::Google': 'Google social OAuth provider',
  'docs/protocols/provider-compatibility.md::Google Workspace':
    'Google Workspace provider compatibility',
  'docs/protocols/provider-compatibility.md::Infobip': 'Infobip SMS OTP provider',
  'docs/protocols/provider-compatibility.md::JumpCloud': 'JumpCloud provider compatibility',
  'docs/protocols/provider-compatibility.md::Keycloak': 'Keycloak provider compatibility',
  'docs/protocols/provider-compatibility.md::MessageBird': 'MessageBird SMS OTP provider',
  'docs/protocols/provider-compatibility.md::Meta WhatsApp': 'Meta WhatsApp OTP provider',
  'docs/protocols/provider-compatibility.md::Microsoft Entra ID':
    'Microsoft Entra ID provider compatibility',
  'docs/protocols/provider-compatibility.md::Microsoft account':
    'Microsoft account social OAuth provider',
  'docs/protocols/provider-compatibility.md::Microsoft custom enterprise app':
    'Microsoft custom enterprise app downstream SSO',
  'docs/protocols/provider-compatibility.md::Okta': 'Okta provider compatibility',
  'docs/protocols/provider-compatibility.md::OneLogin': 'OneLogin provider compatibility',
  'docs/protocols/provider-compatibility.md::PingFederate': 'PingFederate provider compatibility',
  'docs/protocols/provider-compatibility.md::PingOne': 'PingOne provider compatibility',
  'docs/protocols/provider-compatibility.md::Shibboleth': 'Shibboleth provider compatibility',
  'docs/protocols/provider-compatibility.md::Salesforce':
    'Salesforce downstream SAML/OIDC template',
  'docs/protocols/provider-compatibility.md::Slack': 'Slack downstream SAML template',
  'docs/protocols/provider-compatibility.md::Twilio': 'Twilio SMS and WhatsApp OTP provider',
  'docs/protocols/provider-compatibility.md::Vonage': 'Vonage SMS OTP provider',
  'docs/protocols/provider-compatibility.md::Zoom': 'Zoom downstream SAML/OIDC template',
  'docs/protocols/saml.md::ACS POST': 'SAML ACS',
  'docs/protocols/saml.md::Audience, recipient, destination, confirmation method validation':
    'SAML Destination and bearer SubjectConfirmation',
  'docs/protocols/saml.md::EncryptedAssertion': 'SAML EncryptedAssertion',
  'docs/protocols/saml.md::Atlassian SAML app template': 'Atlassian downstream SAML template',
  'docs/protocols/saml.md::GitHub Enterprise Cloud SAML template':
    'GitHub Enterprise downstream SAML template',
  'docs/protocols/saml.md::IdP metadata': 'Outbound SAML IdP metadata',
  'docs/protocols/saml.md::IdP-initiated outbound app launch': 'Outbound SAML IdP SSO endpoint',
  'docs/protocols/saml.md::InResponseTo and replay': 'InResponseTo and replay',
  'docs/protocols/saml.md::JIT provisioning': 'SAML JIT',
  'docs/protocols/saml.md::Microsoft custom SAML app template':
    'Microsoft custom enterprise app downstream SSO',
  'docs/protocols/saml.md::Outbound SAML Single Logout': 'Outbound SAML SLO',
  'docs/protocols/saml.md::RelayState guard': 'RelayState guard',
  'docs/protocols/saml.md::Salesforce SAML app template':
    'Salesforce downstream SAML/OIDC template',
  'docs/protocols/saml.md::Signed Response or Assertion': 'Outbound SAML IdP SSO endpoint',
  'docs/protocols/saml.md::Single Logout': 'SAML SLO',
  'docs/protocols/saml.md::Slack custom SAML template': 'Slack downstream SAML template',
  'docs/protocols/saml.md::SP metadata': 'SP metadata',
  'docs/protocols/saml.md::SP-initiated login': 'SP-initiated login',
  'docs/protocols/saml.md::SP-initiated outbound login': 'Outbound SAML IdP SSO endpoint',
  'docs/protocols/saml.md::XML security precheck and signature structure whitelist':
    'SAML XML security precheck and signature structure whitelist',
  'docs/protocols/saml.md::XML signature validation': 'XML signature validation',
  'docs/protocols/saml.md::Zoom SAML app template': 'Zoom downstream SAML/OIDC template',
  'docs/protocols/security-profiles.md::OAuth 2.1 baseline': 'Authorization code',
  'docs/protocols/scim.md::Directory bearer token': 'Directory bearer token',
  'docs/protocols/scim.md::ETag If-Match': 'SCIM ETag If-Match',
  'docs/protocols/scim.md::Full filter grammar': 'SCIM full filter grammar',
  'docs/protocols/scim.md::Groups CRUD': 'SCIM Groups',
  'docs/protocols/scim.md::ListResponse pagination': 'ListResponse pagination',
  'docs/protocols/scim.md::PATCH': 'PATCH',
  'docs/protocols/scim.md::ResourceTypes': 'SCIM Schemas and ResourceTypes',
  'docs/protocols/scim.md::Schemas': 'SCIM Schemas and ResourceTypes',
  'docs/protocols/scim.md::ServiceProviderConfig': 'SCIM ServiceProviderConfig',
  'docs/protocols/scim.md::Simple list filters': 'SCIM simple filters and invalidFilter guard',
  'docs/protocols/scim.md::Competitor SCIM boundary': 'SCIM Users',
  'docs/protocols/scim.md::Users CRUD': 'SCIM Users',
  'docs/protocols/scim.md::attributes/excludedAttributes': 'SCIM attributes projection',
  'docs/protocols/scim.md::bulk': 'bulk',
  'docs/protocols/scim.md::sort': 'sort',
  'docs/protocols/security-profiles.md::ACR URIs': 'ACR URIs',
  'docs/protocols/security-profiles.md::AMR vocabulary': 'AMR vocabulary',
  'docs/protocols/security-profiles.md::FAPI 2.0': 'FAPI 2.0 profile',
  'docs/protocols/security-profiles.md::NIST AAL1': 'NIST AAL1',
  'docs/protocols/security-profiles.md::NIST AAL2': 'NIST AAL2',
  'docs/protocols/tokens-sessions.md::Access token revocation denylist':
    'Access token revocation denylist',
  'docs/protocols/tokens-sessions.md::Audit event hash chain': 'Audit event hash chain',
  'docs/protocols/tokens-sessions.md::Audit PII redaction': 'Audit PII redaction',
  'docs/protocols/tokens-sessions.md::Instance signing keys': 'Instance signing keys',
  'docs/protocols/tokens-sessions.md::JWKS cache': 'JWKS cache',
  'docs/protocols/tokens-sessions.md::JWT alg allowlist': 'JWT alg allowlist',
  'docs/protocols/tokens-sessions.md::Pending MFA session': 'Pending MFA session',
  'docs/protocols/tokens-sessions.md::Refresh auth context carry-forward':
    'Refresh auth context carry-forward',
  'docs/protocols/tokens-sessions.md::Refresh family revoke': 'Refresh family revoke',
  'docs/protocols/tokens-sessions.md::Refresh token hash storage': 'Refresh token hash storage',
  'docs/protocols/tokens-sessions.md::Session auth context': 'Session auth context',
  'docs/protocols/tokens-sessions.md::Session cookie': 'Session cookie and /v1/me',
  'docs/protocols/tokens-sessions.md::Step-up credential': 'Step-up credential',
  'docs/protocols/tokens-sessions.md::Webhook delivery': 'Webhook delivery',
  'docs/protocols/tokens-sessions.md::Webhook verification SDK': 'Webhook verification SDK',
  'docs/protocols/webauthn-passkeys.md::AAL/ACR/AMR mapping': 'AAL/ACR/AMR mapping',
  'docs/protocols/webauthn-passkeys.md::Authentication verification': 'Authentication verification',
  'docs/protocols/webauthn-passkeys.md::Backup codes': 'Backup codes',
  'docs/protocols/webauthn-passkeys.md::Backup eligibility/state storage':
    'Backup eligibility/state storage',
  'docs/protocols/webauthn-passkeys.md::Discoverable credentials': 'Discoverable credentials',
  'docs/protocols/webauthn-passkeys.md::EdDSA WebAuthn algorithm': 'WebAuthn EdDSA COSE alg',
  'docs/protocols/webauthn-passkeys.md::Enterprise attestation': 'WebAuthn enterprise attestation',
  'docs/protocols/webauthn-passkeys.md::Malformed WebAuthn data handling':
    'WebAuthn malformed input normalization',
  'docs/protocols/webauthn-passkeys.md::Passkey as MFA': 'Passkey as MFA',
  'docs/protocols/webauthn-passkeys.md::Registration options': 'Registration options',
  'docs/protocols/webauthn-passkeys.md::Registration verification': 'Registration verification',
  'docs/protocols/webauthn-passkeys.md::SMS MFA': 'SMS MFA',
  'docs/protocols/webauthn-passkeys.md::Sign count clone detection': 'Sign count clone detection',
}

const evidencePattern = /^L[0-4](?:\/L[0-4])*$/

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

// Top level only. The protocol support matrices live in these files, and the file list itself is
// asserted with toEqual against expectedProtocolDocs, so this MUST NOT start descending into
// docs/protocols/runbooks/.
function protocolMarkdownFiles() {
  return readdirSync(protocolsDir)
    .filter((file) => file.endsWith('.md'))
    .map((file) => `${protocolsDir}/${file}`)
    .sort()
}

// Recursive. Used only by content scans (placeholder wording), where the 16 runbooks under
// docs/protocols/runbooks/ are just as publishable as the top-level matrices.
function protocolMarkdownFilesRecursive(dir = protocolsDir) {
  const found = []

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      found.push(...protocolMarkdownFilesRecursive(path))
      continue
    }
    if (entry.name.endsWith('.md')) found.push(path)
  }

  return found.sort()
}

function readProtocolMatrixRows() {
  const rows = []

  for (const file of protocolMarkdownFiles()) {
    const lines = readFileSync(file, 'utf8').split('\n')
    let activeHeader = null

    for (const [index, line] of lines.entries()) {
      if (!line.startsWith('|')) {
        activeHeader = null
        continue
      }
      if (line.includes('---')) continue

      const cells = splitTableRow(line)
      const supportIndex = cells.indexOf('Support')
      const evidenceIndex = cells.indexOf('Evidence')
      const codeIndex = cells.indexOf('Code')
      const gapIndex = cells.indexOf('Gap')
      const notesIndex = cells.indexOf('Notes')
      const productionEvidenceIndex = cells.indexOf('Production evidence')
      const testsIndex = cells.indexOf('Tests')

      if (supportIndex !== -1 && evidenceIndex !== -1) {
        activeHeader = {
          codeIndex,
          evidenceIndex,
          featureIndex:
            cells.indexOf('Feature') !== -1 ? cells.indexOf('Feature') : cells.indexOf('Profile'),
          gapIndex,
          notesIndex,
          productionEvidenceIndex,
          supportIndex,
          testsIndex,
        }
        continue
      }

      if (!activeHeader) continue

      rows.push({
        code: activeHeader.codeIndex === -1 ? null : (cells[activeHeader.codeIndex] ?? ''),
        evidence: cells[activeHeader.evidenceIndex] ?? '',
        feature: cells[activeHeader.featureIndex] ?? cells[0] ?? '',
        file,
        gap: activeHeader.gapIndex === -1 ? null : (cells[activeHeader.gapIndex] ?? ''),
        line: index + 1,
        notes: activeHeader.notesIndex === -1 ? null : (cells[activeHeader.notesIndex] ?? ''),
        productionEvidence:
          activeHeader.productionEvidenceIndex === -1
            ? null
            : (cells[activeHeader.productionEvidenceIndex] ?? ''),
        support: cells[activeHeader.supportIndex] ?? '',
        tests: activeHeader.testsIndex === -1 ? null : (cells[activeHeader.testsIndex] ?? ''),
      })
    }
  }

  return rows
}

function readGapAuditRows() {
  const lines = readFileSync(gapAuditPath, 'utf8').split('\n')
  const rows = []
  let activeHeader = null

  for (const [index, line] of lines.entries()) {
    if (!line.startsWith('|')) {
      activeHeader = null
      continue
    }
    if (line.includes('---')) continue

    const cells = splitTableRow(line)
    const evidencePathIndex = cells.indexOf('Evidence path')

    if (evidencePathIndex !== -1) {
      activeHeader = {
        evidencePathIndex,
        gapIndex: cells.indexOf('Gap'),
      }
      continue
    }

    if (!activeHeader) continue

    rows.push({
      evidencePath: cells[activeHeader.evidencePathIndex] ?? '',
      gap: cells[activeHeader.gapIndex] ?? cells[0] ?? '',
      line: index + 1,
    })
  }

  return rows
}

function readSourceMapRows() {
  const markdown = readFileSync(sourceMapPath, 'utf8')
  return markdown
    .split('\n')
    .filter((line) => line.startsWith('|') && !line.includes('---'))
    .slice(1)
    .map((line) => {
      const [
        feature,
        standardSource,
        support,
        evidence,
        codePath,
        testPath,
        publicDocsPath,
        i18nMsgidPath,
        productionEvidence,
      ] = splitTableRow(line)
      return {
        feature,
        standardSource,
        support,
        evidence,
        codePath,
        testPath,
        publicDocsPath,
        i18nMsgidPath,
        productionEvidence,
      }
    })
}

function parsePublicDocSlugs() {
  const source = readFileSync(publicDocsRegistryPath, 'utf8')
  const match = /PUBLIC_DOC_SLUGS\s*=\s*\[([\s\S]*?)\]\s+as const/.exec(source)
  if (!match?.[1]) throw new Error('PUBLIC_DOC_SLUGS not found')
  return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1])
}

function publicDocSlugSet() {
  return new Set(parsePublicDocSlugs())
}

function sourceMapRow(feature) {
  const row = readSourceMapRows().find((item) => item.feature === feature)
  if (!row) throw new Error(`source-map feature not found: ${feature}`)
  return row
}

function providerCompatibilityRow(provider) {
  const lines = readFileSync('docs/protocols/provider-compatibility.md', 'utf8').split('\n')

  for (const [index, line] of lines.entries()) {
    if (!line.startsWith(`| ${provider}`)) continue
    const cells = splitTableRow(line)
    return {
      boundary: cells[7] ?? '',
      code: cells[4] ?? '',
      evidence: cells[3] ?? '',
      feature: cells[0] ?? '',
      gap: cells[8] ?? '',
      line: index + 1,
      protocols: cells[1] ?? '',
      support: cells[2] ?? '',
      tests: cells[5] ?? '',
    }
  }

  return null
}

function isUnknown(value) {
  return value === undefined || value === '' || value === 'UNKNOWN'
}

function evidenceLevels(value) {
  return value
    .split('/')
    .map((level) => Number(level.replace('L', '')))
    .filter((level) => Number.isInteger(level))
}

function hasEvidenceAtLeast(value, minimum) {
  return evidenceLevels(value).some((level) => level >= minimum)
}

function maxEvidenceLevel(value) {
  const levels = evidenceLevels(value)
  return levels.length === 0 ? -1 : Math.max(...levels)
}

function repoPathsFromCell(value) {
  return [...value.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1])
    .filter((path) => path && !path.startsWith('/') && !path.includes('*'))
}

function nonPathTextFromCell(value) {
  return value.replace(/`[^`]+`/g, '').replace(/[,\s]/g, '')
}

function hasExplicitMissingEvidence(value) {
  return /\b(no |not applicable|until endpoint exists|until public support claim exists|no matching endpoint|no SSF test path)\b/i.test(
    value,
  )
}

function publicDocPathsFromCell(value) {
  return [...value.matchAll(/`(\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?)`/g)].map(
    (match) => match[1],
  )
}

function readConformancePlan() {
  return readFileSync(conformancePlanPath, 'utf8')
}

function conformancePlanTestRefs() {
  const refs = []

  for (const match of readConformancePlan().matchAll(/`([^`]+)`/g)) {
    const command = match[1] ?? ''
    const filter = /pnpm --filter ([^ ]+)/.exec(command)?.[1]
    const root = packageFilterRoots[filter]
    if (!root) continue

    for (const pathMatch of command.matchAll(/\b([A-Za-z0-9_./-]+\.test\.(?:ts|mjs))\b/g)) {
      refs.push({
        filter,
        path: `${root}/${pathMatch[1]}`,
      })
    }
  }

  return refs
}

describe('protocol source map coverage', () => {
  it('keeps the required protocol docs set complete', () => {
    const files = protocolMarkdownFiles().map((file) => file.replace(`${protocolsDir}/`, ''))
    expect(files).toEqual(expectedProtocolDocs)
  })

  it('keeps current official standards status refreshed in goal and protocol docs', () => {
    const markdown = [
      readFileSync(protocolGoalPath, 'utf8'),
      readFileSync(protocolReadmePath, 'utf8'),
      readFileSync('docs/protocols/security-profiles.md', 'utf8'),
      readFileSync(sourceMapPath, 'utf8'),
    ].join('\n')

    for (const term of standardsRefreshRequiredTerms) {
      expect(markdown.includes(term), `standards refresh missing ${term}`).toBe(true)
    }
  })

  it('keeps official provider source URLs traceable in goal and provider compatibility docs', () => {
    const goalMarkdown = readFileSync(protocolGoalPath, 'utf8')
    const providerMarkdown = readFileSync('docs/protocols/provider-compatibility.md', 'utf8')

    expect(providerMarkdown.includes('Search date: 2026-06-08'), 'provider search date').toBe(true)
    expect(providerMarkdown.includes('Official source URLs:'), 'provider source URL section').toBe(
      true,
    )

    for (const url of expectedOfficialSourceUrls) {
      expect(goalMarkdown.includes(url), `${protocolGoalPath} ${url}`).toBe(true)
      expect(
        providerMarkdown.includes(url),
        `docs/protocols/provider-compatibility.md ${url}`,
      ).toBe(true)
    }
  })

  it('keeps official provider boundary notes explicit', () => {
    const markdown = [
      readFileSync(protocolGoalPath, 'utf8'),
      readFileSync('docs/protocols/provider-compatibility.md', 'utf8'),
      readFileSync(sourceMapPath, 'utf8'),
    ].join('\n')

    for (const term of expectedOfficialBoundaryTerms) {
      expect(markdown.includes(term), `official boundary ${term}`).toBe(true)
    }
  })

  it('keeps competitor protocol baseline in protocol docs', () => {
    const providerMarkdown = readFileSync('docs/protocols/provider-compatibility.md', 'utf8')
    const readmeMarkdown = readFileSync(protocolReadmePath, 'utf8')
    const sourceMapMarkdown = readFileSync(sourceMapPath, 'utf8')
    const gapAuditMarkdown = readFileSync(gapAuditPath, 'utf8')

    for (const term of expectedCompetitorBaselineTerms) {
      expect(providerMarkdown.includes(term), `provider compatibility ${term}`).toBe(true)
    }

    for (const term of expectedReadmeCompetitorTerms) {
      expect(readmeMarkdown.includes(term), `${protocolReadmePath} ${term}`).toBe(true)
    }

    for (const term of expectedSourceMapSlackGitHubBoundaryTerms) {
      expect(sourceMapMarkdown.includes(term), `${sourceMapPath} ${term}`).toBe(true)
    }

    expect(
      gapAuditMarkdown.includes(
        'Competitor protocol baseline was not reflected in the protocol matrices',
      ),
      `${gapAuditPath} competitor baseline gap`,
    ).toBe(true)
    expect(
      gapAuditMarkdown.includes('Auth0 Social Identity Providers'),
      `${gapAuditPath} Auth0 Social Identity Providers`,
    ).toBe(true)
    expect(
      gapAuditMarkdown.includes('Clerk Social Connections OAuth'),
      `${gapAuditPath} Clerk Social Connections OAuth`,
    ).toBe(true)
    expect(
      gapAuditMarkdown.includes('Clerk as OAuth/OIDC IdP'),
      `${gapAuditPath} Clerk as OAuth/OIDC IdP`,
    ).toBe(true)
    expect(
      gapAuditMarkdown.includes('Zitadel external identity providers'),
      `${gapAuditPath} Zitadel external identity providers`,
    ).toBe(true)
    expect(
      gapAuditMarkdown.includes('complete OIDC/OAuth identity provider status'),
      `${gapAuditPath} Nimbus hub complete IdP boundary`,
    ).toBe(true)
    expect(
      gapAuditMarkdown.includes('apps/site/src/lib/docs-agent-content.test.ts'),
      `${gapAuditPath} Nimbus agent surface evidence`,
    ).toBe(true)
    expect(
      gapAuditMarkdown.includes('apps/site/scripts/audit-dist-routes.mjs'),
      `${gapAuditPath} Nimbus dist guard evidence`,
    ).toBe(true)
  })

  it('keeps the five protocol role lines explicit in goal, README, and source-map', () => {
    const goalMarkdown = readFileSync(protocolGoalPath, 'utf8')
    const readmeMarkdown = readFileSync(protocolReadmePath, 'utf8')
    const sourceMapMarkdown = readFileSync(sourceMapPath, 'utf8')

    for (const term of expectedRoleLineTerms) {
      expect(goalMarkdown.includes(term), `${protocolGoalPath} ${term}`).toBe(true)
      expect(readmeMarkdown.includes(term), `${protocolReadmePath} ${term}`).toBe(true)
      expect(sourceMapMarkdown.includes(term), `${sourceMapPath} ${term}`).toBe(true)
    }

    for (const term of expectedGoalOfficialBoundaryTerms) {
      expect(goalMarkdown.includes(term), `${protocolGoalPath} ${term}`).toBe(true)
    }
  })

  it('keeps protocol README support levels aligned with evidence and role boundaries', () => {
    const readmeMarkdown = readFileSync(protocolReadmePath, 'utf8')

    for (const term of expectedSupportDefinitionTerms) {
      expect(readmeMarkdown.includes(term), `${protocolReadmePath} ${term}`).toBe(true)
    }

    for (const term of expectedReadmeScimDirectionTerms) {
      expect(readmeMarkdown.includes(term), `${protocolReadmePath} ${term}`).toBe(true)
    }
  })

  it('keeps design docs explicit about downstream SaaS SSO boundaries', () => {
    const oidcDesign = collapseWhitespace(readFileSync(oidcDesignPath, 'utf8'))
    const enterpriseSsoDesign = collapseWhitespace(readFileSync(enterpriseSsoDesignPath, 'utf8'))
    const overviewDesign = collapseWhitespace(readFileSync(overviewDesignPath, 'utf8'))
    const authDesign = collapseWhitespace(readFileSync(authDesignPath, 'utf8'))

    for (const term of expectedOidcDesignBoundaryTerms) {
      expect(oidcDesign.includes(term), `${oidcDesignPath} ${term}`).toBe(true)
    }

    for (const term of expectedEnterpriseSsoDesignBoundaryTerms) {
      expect(enterpriseSsoDesign.includes(term), `${enterpriseSsoDesignPath} ${term}`).toBe(true)
    }

    for (const term of expectedEnterpriseSsoDesignScimTargetTerms) {
      expect(enterpriseSsoDesign.includes(term), `${enterpriseSsoDesignPath} ${term}`).toBe(true)
    }

    expect(
      overviewDesign.includes(
        'support level published externally is governed by the `docs/protocols/**` matrices',
      ),
      `${overviewDesignPath} protocol matrix support level boundary`,
    ).toBe(true)
    expect(
      overviewDesign.includes(
        'lacking real provider/IdP/SaaS L4 evidence MUST NOT be described as complete',
      ),
      `${overviewDesignPath} real L4 completion boundary`,
    ).toBe(true)
    expect(
      authDesign.includes(
        'The support level for passwords, social login, passwordless, MFA, and enterprise SSO is governed by the `docs/protocols/**` matrices plus real L4 evidence',
      ),
      `${authDesignPath} auth support level boundary`,
    ).toBe(true)

    // Boundary and overclaim guards run against the English source of truth and the Chinese mirror,
    // so neither language can quietly drop a boundary statement or reintroduce a "we already
    // support everything" claim.
    const overviewDesignZh = collapseWhitespace(readFileSync(overviewDesignZhPath, 'utf8'))
    const authDesignZh = collapseWhitespace(readFileSync(authDesignZhPath, 'utf8'))
    const oidcDesignZh = collapseWhitespace(readFileSync(oidcDesignZhPath, 'utf8'))
    const enterpriseSsoDesignZh = collapseWhitespace(
      readFileSync(enterpriseSsoDesignZhPath, 'utf8'),
    )

    for (const term of expectedOidcDesignZhBoundaryTerms) {
      expect(oidcDesignZh.includes(term), `${oidcDesignZhPath} ${term}`).toBe(true)
    }

    for (const term of expectedEnterpriseSsoDesignZhBoundaryTerms) {
      expect(enterpriseSsoDesignZh.includes(term), `${enterpriseSsoDesignZhPath} ${term}`).toBe(
        true,
      )
    }

    for (const term of expectedEnterpriseSsoDesignZhScimTargetTerms) {
      expect(enterpriseSsoDesignZh.includes(term), `${enterpriseSsoDesignZhPath} ${term}`).toBe(
        true,
      )
    }

    for (const claim of forbiddenOverviewScopeClaims) {
      expect(
        matchesOverclaim(overviewDesign, claim),
        `${overviewDesignPath} overclaims full scope: ${claim.label}`,
      ).toBe(false)
      expect(
        matchesOverclaim(overviewDesignZh, claim),
        `${overviewDesignZhPath} overclaims full scope: ${claim.label}`,
      ).toBe(false)
    }

    for (const claim of forbiddenAuthSupportClaims) {
      expect(
        matchesOverclaim(authDesign, claim),
        `${authDesignPath} overclaims auth support: ${claim.label}`,
      ).toBe(false)
      expect(
        matchesOverclaim(authDesignZh, claim),
        `${authDesignZhPath} overclaims auth support: ${claim.label}`,
      ).toBe(false)
    }
  })

  it('keeps OIDC matrix explicit about downstream SaaS OIDC local baseline', () => {
    const oidcProtocol = readFileSync('docs/protocols/oidc.md', 'utf8')

    for (const term of expectedOidcProtocolBoundaryTerms) {
      expect(oidcProtocol.includes(term), `docs/protocols/oidc.md ${term}`).toBe(true)
    }
  })

  it('keeps SAML matrix explicit about outbound SaaS SAML local baseline', () => {
    const samlProtocol = readFileSync('docs/protocols/saml.md', 'utf8')

    for (const term of expectedSamlOutboundBoundaryTerms) {
      expect(samlProtocol.includes(term), `docs/protocols/saml.md ${term}`).toBe(true)
    }
  })

  it('keeps SCIM matrix tied to competitor directory sync boundaries', () => {
    const scimProtocol = readFileSync('docs/protocols/scim.md', 'utf8')

    for (const term of expectedScimProtocolBoundaryTerms) {
      expect(scimProtocol.includes(term), `docs/protocols/scim.md ${term}`).toBe(true)
    }
  })

  it('keeps downstream SaaS SCIM targets implemented locally and separate from inbound SCIM', () => {
    const row = sourceMapRow('Downstream SaaS SCIM target clients')
    const gapAuditMarkdown = readFileSync(gapAuditPath, 'utf8')
    const docsSource = readFileSync(publicDocsContentPath, 'utf8')

    for (const term of expectedGapAuditOpenBoundaryTerms) {
      expect(gapAuditMarkdown.includes(term), `${gapAuditPath} ${term}`).toBe(true)
    }

    expect(row.support, 'Downstream SaaS SCIM target clients support').toBe('implemented')
    expect(row.evidence, 'Downstream SaaS SCIM target clients evidence').toBe('L2/L3')
    expect(row.publicDocsPath, 'Downstream SaaS SCIM target clients public docs path').toBe(
      '`/scim` boundary text',
    )
    expect(
      row.codePath.includes('apps/server/worker/scim/outbound.ts'),
      'downstream SCIM code path',
    ).toBe(true)
    expect(
      row.testPath.includes('apps/server/tests/smoke/l3-protocol-client.test.mjs'),
      'downstream SCIM test path',
    ).toBe(true)
    expect(
      row.productionEvidence.includes(
        'real Slack/GitHub Enterprise Cloud/Atlassian/Salesforce/Zoom admin L4',
      ),
      'downstream SCIM production boundary',
    ).toBe(true)
    expect(
      row.productionEvidence.includes('inbound SCIM Service Provider evidence cannot be reused'),
      'downstream SCIM role separation',
    ).toBe(true)
    expect(
      gapAuditMarkdown.includes('Real SaaS L4 is missing for downstream SaaS SCIM target clients'),
      `${gapAuditPath} downstream SCIM P0 gap`,
    ).toBe(true)
    expect(
      docsSource.includes('inbound SCIM Service Provider endpoints') &&
        docsSource.includes('SCIM push clients') &&
        docsSource.includes('local fake-SaaS evidence') &&
        docsSource.includes('real SaaS admin L4'),
      'public SCIM docs downstream target boundary',
    ).toBe(true)
  })

  it('keeps downstream SaaS SCIM target conformance gates separate from inbound SCIM', () => {
    const conformancePlan = readConformancePlan()

    for (const term of expectedDownstreamScimConformanceTerms) {
      expect(conformancePlan.includes(term), `conformance downstream SCIM ${term}`).toBe(true)
    }
  })

  it('keeps downstream SaaS SSO local baseline out of production support claims', () => {
    const rowsByFeature = new Map(readSourceMapRows().map((row) => [row.feature, row]))
    const docsSource = readFileSync(publicDocsContentPath, 'utf8')

    expect(
      docsSource.includes('Outbound SAML IdP') &&
        docsSource.includes('downstream SaaS apps') &&
        docsSource.includes('local fake-SaaS evidence') &&
        docsSource.includes('real SaaS admin L4'),
      'public SAML docs downstream production boundary',
    ).toBe(true)

    for (const feature of expectedDownstreamSaaSFeatures) {
      const row = rowsByFeature.get(feature)
      expect(row, `${feature} source-map row`).toBeDefined()
      if (feature === 'Outbound SAML SLO') {
        expect(row?.support, `${feature} support`).toBe('implemented')
        expect(row?.evidence, `${feature} evidence`).toBe('L1/L2')
      } else if (
        feature === 'Outbound SAML IdP metadata' ||
        feature === 'Outbound SAML IdP SSO endpoint'
      ) {
        expect(row?.support, `${feature} support`).toBe('implemented')
        expect(row?.evidence, `${feature} evidence`).toBe('L1/L2/L3')
      } else {
        expect(row?.support, `${feature} support`).toBe('implemented')
        expect(row?.evidence, `${feature} evidence`).toMatch(/^L/)
      }
      const expectedPublicDocsPath =
        feature === 'Downstream OIDC app catalog'
          ? '`/enterprise-sso`; `/oidc-oauth` boundary text'
          : feature === 'Outbound SAML IdP metadata' || feature === 'Outbound SAML IdP SSO endpoint'
            ? '`/enterprise-sso`; `/saml`'
            : feature === 'Outbound SAML SLO'
              ? '`/saml`'
              : '`/enterprise-sso`; `/saml` boundary text'
      expect(row?.publicDocsPath, `${feature} public docs path`).toBe(expectedPublicDocsPath)
      expect(row?.i18nMsgidPath, `${feature} i18n path`).toBe(
        '`packages/i18n/locales/**/messages.po`',
      )
      expect(row?.codePath.includes('no implementation exists'), `${feature} code path`).toBe(false)
      expect(row?.testPath.includes('until endpoint exists'), `${feature} test path`).toBe(false)
      expect(row?.productionEvidence.includes('L4'), `${feature} production evidence`).toBe(true)
      expect(row?.productionEvidence, `${feature} public boundary evidence`).toMatch(
        /real .* L4|production support is claimed|not claim outbound SLO/,
      )
    }

    expect(
      docsSource.includes('downstream SaaS') &&
        docsSource.includes('Generic OIDC baseline is available locally') &&
        docsSource.includes('real SaaS L4'),
      'public OIDC docs downstream production boundary',
    ).toBe(true)
  })

  it('keeps open P0 protocol gaps tied to blocked inputs and role separation', () => {
    const gapAuditMarkdown = readFileSync(gapAuditPath, 'utf8')
    const p0OpenSection = gapAuditMarkdown.slice(
      gapAuditMarkdown.indexOf('## P0 Open'),
      gapAuditMarkdown.indexOf('## P0 Closed'),
    )

    expect(gapAuditMarkdown.includes('## P0 Open'), `${gapAuditPath} P0 Open`).toBe(true)
    expect(
      gapAuditMarkdown.includes('## Blocked Inputs For Open P0'),
      `${gapAuditPath} blocked inputs`,
    ).toBe(true)

    for (const term of expectedOpenP0BlockedTerms) {
      expect(gapAuditMarkdown.includes(term), `${gapAuditPath} ${term}`).toBe(true)
    }

    expect(
      gapAuditMarkdown.includes(
        'Production-supported completion is blocked by missing real L4 inputs',
      ),
      `${gapAuditPath} goal completion blocked gate`,
    ).toBe(true)
    expect(
      gapAuditMarkdown.includes(
        'source-map gate and docs alignment are evidence of local alignment, not evidence of production-supported completion',
      ),
      `${gapAuditPath} source-map is not completion evidence`,
    ).toBe(true)

    expect(
      p0OpenSection.includes(
        'Provider compatibility matrix previously mixed product roles by brand',
      ),
      `${gapAuditPath} role split should not stay open`,
    ).toBe(false)

    for (const term of expectedP0LandedRoleSplitTerms) {
      expect(gapAuditMarkdown.includes(term), `${gapAuditPath} landed role split ${term}`).toBe(
        true,
      )
    }
  })

  it('keeps local completion separate from production support gates', () => {
    const goalMarkdown = readFileSync(protocolGoalPath, 'utf8')
    const readmeMarkdown = readFileSync(protocolReadmePath, 'utf8')
    const providerMarkdown = readFileSync(providerCompatibilityPath, 'utf8')
    const sourceMapMarkdown = readFileSync(sourceMapPath, 'utf8')

    for (const term of expectedGoalCompletionGateTerms) {
      expect(goalMarkdown.includes(term), `${protocolGoalPath} ${term}`).toBe(true)
    }

    expect(
      readmeMarkdown.includes(
        'local protocol implementation can be completed with L1/L2/L3 and fake provider or fake SaaS evidence',
      ),
      `${protocolReadmePath} goal completion gate`,
    ).toBe(true)
    expect(
      readmeMarkdown.includes(
        'Missing real provider/IdP/SaaS L4 blocks only production-supported claims',
      ),
      `${protocolReadmePath} production support gate`,
    ).toBe(true)
    expect(
      providerMarkdown.includes(
        'Goal completion gate: local implementation can close with fake provider or fake SaaS L3',
      ),
      `${providerCompatibilityPath} goal completion gate`,
    ).toBe(true)
    expect(
      sourceMapMarkdown.includes(
        'Goal completion gate: source-map coverage can prove role-line documentation and local evidence alignment. Local protocol implementation can be completed with fake provider or fake SaaS L3.',
      ),
      `${sourceMapPath} source-map not completion evidence`,
    ).toBe(true)
  })

  it('keeps API contracts aligned with protocol role boundaries', () => {
    const apiContracts = readFileSync(apiContractsPath, 'utf8')
    // Table assertions run against squeezed whitespace: oxfmt re-pads columns to the widest cell,
    // so an assertion must never depend on the current padding.
    const apiContractsTable = apiContracts.replace(/ +/gu, ' ')
    // Prose assertions collapse newlines too: paragraphs are hard-wrapped, so an overclaim sentence
    // routinely spans several source lines.
    const apiContractsProse = collapseWhitespace(apiContracts)

    for (const claim of forbiddenInboundScimProseClaims) {
      expect(
        matchesOverclaim(apiContractsProse, claim),
        `${apiContractsPath} overclaims inbound SCIM in prose: ${claim.label}`,
      ).toBe(false)
    }

    expect(
      apiContracts.includes('`apps/server/worker/oidc/par.ts`'),
      `${apiContractsPath} PAR`,
    ).toBe(true)
    expect(
      apiContracts.includes('`apps/server/worker/oauth/par.ts`'),
      `${apiContractsPath} stale PAR path`,
    ).toBe(false)
    // Over-claim guard: `production L4` is the exact status label 18 other rows in this table
    // legitimately carry, so it is the wording an over-claimer would reach for on the SCIM row.
    expect(
      apiContractsTable.includes('| SCIM users and groups | production L4'),
      `${apiContractsPath} inbound SCIM boundary`,
    ).toBe(false)
    expect(
      apiContractsTable.includes(
        '| SCIM users and groups | provider-ready, real IdP provisioning L4 missing',
      ),
      `${apiContractsPath} inbound SCIM provider-ready boundary`,
    ).toBe(true)
    expect(
      apiContracts.includes(
        'local/production paths and a 401 without Bearer are not real IdP provisioning L4',
      ),
      `${apiContractsPath} inbound SCIM L4 evidence boundary`,
    ).toBe(true)
    expect(
      apiContracts.includes(
        'real Microsoft Entra/Okta/Auth0/Clerk/Zitadel provisioning into XID is still missing',
      ),
      `${apiContractsPath} inbound SCIM missing provider evidence`,
    ).toBe(true)
    expect(
      apiContractsTable.includes(
        '| SCIM downstream SaaS target clients | implemented, real SaaS L4 missing',
      ),
      `${apiContractsPath} downstream SCIM boundary`,
    ).toBe(true)
    expect(
      apiContracts.includes('XID acts as an inbound SCIM Service Provider'),
      `${apiContractsPath} inbound SCIM role`,
    ).toBe(true)
    expect(
      apiContracts.includes(
        'XID acts as an outbound SCIM client pushing users and groups to the Slack/GitHub Enterprise Cloud/Atlassian/Salesforce/Zoom SCIM API',
      ),
      `${apiContractsPath} downstream SCIM role`,
    ).toBe(true)
    expect(
      apiContracts.includes(
        'inbound SCIM Service Provider evidence MUST NOT be reused as SCIM push-to-SaaS L4',
      ),
      `${apiContractsPath} downstream SCIM evidence boundary`,
    ).toBe(true)
    expect(
      apiContractsTable.includes('| SAML inbound SSO | provider-ready, L4 missing'),
      `${apiContractsPath} inbound SAML boundary`,
    ).toBe(true)
    expect(
      apiContractsTable.includes('| SAML outbound SaaS SSO | provider-ready, real SaaS L4 missing'),
      `${apiContractsPath} outbound SAML boundary`,
    ).toBe(true)
    expect(
      apiContracts.includes('XID acts as the SAML SP for an upstream enterprise IdP'),
      `${apiContractsPath} inbound role`,
    ).toBe(true)
    expect(
      apiContracts.includes('XID acts as the SAML/OIDC IdP for downstream SaaS'),
      `${apiContractsPath} outbound role`,
    ).toBe(true)
    expect(
      apiContracts.includes('Public docs MUST NOT promise production-supported'),
      `${apiContractsPath} public claim boundary`,
    ).toBe(true)
  })

  it('keeps required provider compatibility coverage', () => {
    const rows = readProtocolMatrixRows()
      .filter((row) => row.file === 'docs/protocols/provider-compatibility.md')
      .map((row) => row.feature)
      .sort()

    expect(rows).toEqual(expectedProviderCompatibilityRows)
  })

  it('keeps provider SCIM target rows locally ready and separate from inbound SCIM evidence', () => {
    for (const provider of expectedProviderScimTargetRows) {
      const row = providerCompatibilityRow(provider)
      expect(row, `${provider} provider row`).toBeDefined()
      expect(row?.support, `${provider} support`).toBe('implemented')
      expect(row?.evidence, `${provider} evidence`).toMatch(/^L/)
      expect(row?.protocols.includes('SCIM target'), `${provider} SCIM target protocol`).toBe(true)
      expect(
        row?.code?.includes('apps/server/worker/scim/outbound.ts'),
        `${provider} code path`,
      ).toBe(true)
      expect(
        row?.tests?.includes('apps/server/tests/smoke/l3-protocol-client.test.mjs'),
        `${provider} test path`,
      ).toBe(true)
      expect(
        row?.gap?.includes('production evidence') || row?.gap?.includes('production support'),
        `${provider} SCIM push production gap`,
      ).toBe(true)
      expect(row?.gap?.includes('real'), `${provider} real SaaS boundary`).toBe(true)
    }
  })

  it('keeps provider SCIM concurrency claims aligned with the implemented protocol matrix', () => {
    const row = providerCompatibilityRow('Microsoft Entra ID')

    expect(row, 'Microsoft Entra ID provider row').toBeDefined()
    expect(row?.boundary).toContain('ETag')
    expect(row?.boundary).toContain('If-Match')
    expect(row?.boundary).not.toContain('not supported')
  })

  it('keeps required security profile decisions', () => {
    const rows = readProtocolMatrixRows()
      .filter((row) => row.file === 'docs/protocols/security-profiles.md')
      .map((row) => row.feature)
      .sort()

    expect(rows).toEqual(expectedSecurityProfileRows)
  })

  it('keeps conformance plan tied to L0 through L4 gates', () => {
    const markdown = readConformancePlan()

    for (const level of ['L0', 'L1', 'L2', 'L3', 'L4']) {
      expect(markdown.includes(`## ${level}`), `${conformancePlanPath} ${level}`).toBe(true)
    }

    for (const required of [
      'pnpm exec vp check',
      'pnpm run i18n:compile -- --strict',
      'pnpm run protocols:source-map',
      'git diff --check',
      'OAuth/OIDC protocol package tests',
      'SAML focused tests',
      'SCIM focused tests',
      'WebAuthn focused tests',
      'registerAllRoutes',
      '/authorize',
      '/token',
      '/scim/v2/*',
      'SAML ACS',
      'passkey routes',
      'l3-password-browser.test.mjs',
      'l3-passkey-browser.test.mjs',
      'l3-password-reset-browser.test.mjs',
      'l3-protocol-client.test.mjs',
      'Protocol client runs',
      'connected Git Workers Builds',
      'active deployment',
      'active version',
    ]) {
      expect(markdown.includes(required), `${conformancePlanPath} ${required}`).toBe(true)
    }
  })

  it('keeps outbound SaaS SSO conformance gates explicit for local baseline and L4', () => {
    const markdown = readConformancePlan()

    for (const term of expectedOutboundSaaSConformanceTerms) {
      expect(markdown.includes(term), `${conformancePlanPath} ${term}`).toBe(true)
    }
  })

  it('keeps conformance plan focused test commands pointing at real files', () => {
    const refs = conformancePlanTestRefs()

    expect(refs.length, `${conformancePlanPath} test refs`).toBeGreaterThan(0)
    for (const ref of refs) {
      expect(existsSync(ref.path), `${conformancePlanPath} ${ref.filter} ${ref.path}`).toBe(true)
    }

    for (const expectedPath of expectedL3TestPaths) {
      expect(
        refs.some((ref) => ref.path === expectedPath),
        `${conformancePlanPath} ${expectedPath}`,
      ).toBe(true)
    }
  })

  it('keeps L4 conformance plan explicit about redacted production evidence', () => {
    const markdown = readConformancePlan()

    for (const forbiddenOutput of [
      'secrets',
      'OTP values',
      'SAMLResponse',
      'authorization codes',
      'refresh tokens',
      'cookies',
      'provider tokens',
    ]) {
      expect(markdown.includes(forbiddenOutput), `${conformancePlanPath} ${forbiddenOutput}`).toBe(
        true,
      )
    }

    expect(markdown.includes('without recording'), `${conformancePlanPath} redaction policy`).toBe(
      true,
    )
  })

  it('uses only known support and evidence levels across protocol matrices', () => {
    const rows = readProtocolMatrixRows()
    expect(rows.length).toBeGreaterThan(0)

    for (const row of rows) {
      const location = `${row.file}:${row.line} ${row.feature}`
      expect(allowedSupports.has(row.support), `${location} support ${row.support}`).toBe(true)
      expect(evidencePattern.test(row.evidence), `${location} evidence ${row.evidence}`).toBe(true)
    }
  })

  it('maps every protocol matrix row to source-map coverage', () => {
    const matrixRows = readProtocolMatrixRows()
    const sourceMapFeatures = new Set(readSourceMapRows().map((row) => row.feature))

    for (const row of matrixRows) {
      const key = `${row.file}::${row.feature}`
      const sourceMapFeature = sourceMapFeatures.has(row.feature)
        ? row.feature
        : matrixSourceMapAliases[key]
      expect(
        sourceMapFeature,
        `${row.file}:${row.line} ${row.feature} missing source-map coverage`,
      ).toBeDefined()
      expect(
        sourceMapFeatures.has(sourceMapFeature),
        `${row.file}:${row.line} ${row.feature} maps to missing source-map feature ${sourceMapFeature}`,
      ).toBe(true)
    }
  })

  it('keeps protocol matrix evidence no weaker than mapped source-map evidence', () => {
    const matrixRows = readProtocolMatrixRows()
    const sourceMapRows = new Map(readSourceMapRows().map((row) => [row.feature, row]))

    for (const row of matrixRows) {
      const key = `${row.file}::${row.feature}`
      const sourceMapFeature = sourceMapRows.has(row.feature)
        ? row.feature
        : matrixSourceMapAliases[key]
      const sourceMapRow = sourceMapRows.get(sourceMapFeature)
      if (!sourceMapRow) continue

      expect(
        maxEvidenceLevel(row.evidence),
        `${row.file}:${row.line} ${row.feature} matrix evidence must cover ${sourceMapFeature} ${sourceMapRow.evidence}`,
      ).toBeGreaterThanOrEqual(maxEvidenceLevel(sourceMapRow.evidence))
    }
  })

  it('keeps protocol matrix code and test evidence concrete', () => {
    const matrixRows = readProtocolMatrixRows()

    for (const row of matrixRows) {
      if (row.code === null || row.tests === null) continue

      const location = `${row.file}:${row.line} ${row.feature}`
      if (row.evidence === 'L0') {
        expect(hasExplicitMissingEvidence(row.code), `${location} L0 code evidence`).toBe(true)
        expect(hasExplicitMissingEvidence(row.tests), `${location} L0 test evidence`).toBe(true)
        continue
      }

      const codePaths = repoPathsFromCell(row.code)
      const testPaths = repoPathsFromCell(row.tests)
      expect(codePaths.length, `${location} code paths`).toBeGreaterThan(0)
      expect(testPaths.length, `${location} test paths`).toBeGreaterThan(0)

      for (const path of [...codePaths, ...testPaths]) {
        expect(existsSync(path), `${location} references missing path ${path}`).toBe(true)
      }
    }
  })

  it('keeps gap-audit evidence paths concrete', () => {
    const rows = readGapAuditRows()
    expect(rows.length).toBeGreaterThan(0)

    for (const row of rows) {
      if (row.gap.startsWith('None ')) continue

      const location = `${gapAuditPath}:${row.line} ${row.gap}`
      const paths = repoPathsFromCell(row.evidencePath)
      expect(paths.length, `${location} evidence paths`).toBeGreaterThan(0)
      expect(nonPathTextFromCell(row.evidencePath), `${location} non-path evidence`).toBe('')

      for (const path of paths) {
        expect(existsSync(path), `${location} references missing path ${path}`).toBe(true)
      }
    }
  })

  it('keeps high-risk matrix rows on dedicated source-map coverage', () => {
    const matrixRows = readProtocolMatrixRows()
    const sourceMapFeatures = new Set(readSourceMapRows().map((row) => row.feature))

    for (const row of matrixRows) {
      const key = `${row.file}::${row.feature}`
      const expectedFeature = dedicatedCoverageTargets[key]
      if (!expectedFeature) continue

      expect(
        sourceMapFeatures.has(expectedFeature),
        `${row.file}:${row.line} ${row.feature} must have dedicated source-map row ${expectedFeature}`,
      ).toBe(true)
      expect(
        matrixSourceMapAliases[key],
        `${row.file}:${row.line} ${row.feature} dedicated alias`,
      ).toBe(expectedFeature)
    }
  })

  it('requires reviewed aliases for non-planned matrix rows', () => {
    const matrixRows = readProtocolMatrixRows()
    const sourceMapFeatures = new Set(readSourceMapRows().map((row) => row.feature))

    for (const row of matrixRows) {
      if (row.support === 'planned') continue
      if (sourceMapFeatures.has(row.feature)) continue

      const key = `${row.file}::${row.feature}`
      expect(
        dedicatedCoverageTargets[key],
        `${row.file}:${row.line} ${row.feature} non-planned alias must be reviewed`,
      ).toBe(matrixSourceMapAliases[key])
    }
  })

  it('uses only known support levels and non-empty feature metadata', () => {
    const rows = readSourceMapRows()
    expect(rows.length).toBeGreaterThan(0)
    const features = new Set()

    for (const row of rows) {
      expect(row.feature).not.toBe('')
      expect(row.standardSource).not.toBe('')
      expect(allowedSupports.has(row.support), `${row.feature} support ${row.support}`).toBe(true)
      expect(evidencePattern.test(row.evidence), `${row.feature} evidence ${row.evidence}`).toBe(
        true,
      )
      expect(features.has(row.feature), `${row.feature} duplicate source-map feature`).toBe(false)
      features.add(row.feature)
    }
  })

  it('does not leave UNKNOWN placeholders in source-map cells', () => {
    const rows = readSourceMapRows()

    for (const row of rows) {
      for (const [key, value] of Object.entries(row)) {
        expect(isUnknown(value), `${row.feature} ${key}`).toBe(false)
      }
    }
  })

  it('does not leave ambiguous placeholders in protocol docs', () => {
    for (const file of protocolMarkdownFilesRecursive()) {
      const markdown = readFileSync(file, 'utf8')
      expect(markdown.includes('UNKNOWN'), `${file} UNKNOWN placeholder`).toBe(false)
      expect(markdown.includes('partial'), `${file} partial placeholder`).toBe(false)
    }
  })

  it('maps public support claims to code, tests, public docs, i18n, and evidence', () => {
    const rows = readSourceMapRows()

    for (const row of rows) {
      if (!supportRequiringCoverage.has(row.support)) continue

      expect(isUnknown(row.evidence), `${row.feature} evidence`).toBe(false)
      expect(isUnknown(row.codePath), `${row.feature} code path`).toBe(false)
      expect(isUnknown(row.testPath), `${row.feature} test path`).toBe(false)
      expect(isUnknown(row.publicDocsPath), `${row.feature} public docs path`).toBe(false)
      expect(isUnknown(row.i18nMsgidPath), `${row.feature} i18n msgid path`).toBe(false)
      expect(isUnknown(row.productionEvidence), `${row.feature} production evidence`).toBe(false)
    }
  })

  it('covers every P0 goal feature directly in source-map', () => {
    const sourceMapFeatures = new Set(readSourceMapRows().map((row) => row.feature))

    for (const feature of p0SourceMapFeatures) {
      expect(sourceMapFeatures.has(feature), `${feature} missing from source-map P0 coverage`).toBe(
        true,
      )
    }
  })

  it('keeps P0 source-map rows out of planned and UNKNOWN states', () => {
    const rowsByFeature = new Map(readSourceMapRows().map((row) => [row.feature, row]))

    for (const feature of p0SourceMapFeatures) {
      const row = rowsByFeature.get(feature)
      expect(row, `${feature} missing source-map row`).toBeDefined()
      expect(row.support, `${feature} support`).not.toBe('planned')
      expect(isUnknown(row.productionEvidence), `${feature} production evidence`).toBe(false)
    }
  })

  it('requires L2 or L3 evidence for critical implemented route behavior', () => {
    const rows = readSourceMapRows()

    for (const row of rows) {
      if (row.support !== 'implemented' && row.support !== 'provider-ready') continue
      if (!criticalRuntimeFeatures.has(row.feature)) continue
      expect(
        hasEvidenceAtLeast(row.evidence, 2),
        `${row.feature} critical route evidence ${row.evidence}`,
      ).toBe(true)
    }
  })

  it('keeps protocol client L3 smoke mapped to OAuth and SCIM runtime rows', () => {
    const rowsByFeature = new Map(readSourceMapRows().map((row) => [row.feature, row]))

    for (const feature of expectedL3ProtocolClientFeatures) {
      const row = rowsByFeature.get(feature)
      expect(row, `${feature} source-map row`).toBeDefined()
      expect(row?.evidence.includes('L3'), `${feature} L3 evidence`).toBe(true)
      expect(
        row?.testPath.includes('apps/server/tests/smoke/l3-protocol-client.test.mjs'),
        `${feature} L3 protocol client test path`,
      ).toBe(true)
    }
  })

  it('keeps fake SaaS OIDC RP callback covered by L3 smoke', () => {
    const harness = readFileSync(
      'apps/server/tests/smoke/harness/smoke-l3-protocol-client.mjs',
      'utf8',
    )
    const oidcRow = sourceMapRow('Downstream OIDC app catalog')

    for (const term of expectedFakeSaaSOidcRpTerms) {
      expect(harness.includes(term), `fake SaaS OIDC RP harness term ${term}`).toBe(true)
    }
    expect(oidcRow.evidence.includes('L3'), 'Downstream OIDC app catalog L3 evidence').toBe(true)
    expect(
      oidcRow.testPath.includes('apps/server/tests/smoke/l3-protocol-client.test.mjs'),
      'Downstream OIDC app catalog L3 smoke path',
    ).toBe(true)
    expect(
      oidcRow.productionEvidence.includes('fake SaaS OIDC RP callback L3'),
      'Downstream OIDC app catalog fake SaaS RP evidence',
    ).toBe(true)
  })

  it('keeps provider-ready rows explicit about external L4 inputs', () => {
    const rows = readSourceMapRows()

    for (const row of rows) {
      if (row.support !== 'provider-ready') continue
      expect(
        providerReadyRequiredTerms.test(row.productionEvidence),
        `${row.feature} provider-ready evidence must mention real or production evidence`,
      ).toBe(true)
      expect(
        providerReadyExternalInputTerms.test(row.productionEvidence),
        `${row.feature} provider-ready evidence must name missing external inputs`,
      ).toBe(true)
    }
  })

  it('keeps provider-ready protocol matrix rows explicit about external L4 inputs', () => {
    const rows = readProtocolMatrixRows()

    for (const row of rows) {
      if (row.support !== 'provider-ready') continue
      const details = [row.notes, row.gap, row.productionEvidence].filter(Boolean).join(' ')
      const location = `${row.file}:${row.line} ${row.feature}`
      expect(
        providerReadyRequiredTerms.test(details),
        `${location} provider-ready matrix row must mention real or production evidence`,
      ).toBe(true)
      expect(
        providerReadyExternalInputTerms.test(details),
        `${location} provider-ready matrix row must name missing external inputs`,
      ).toBe(true)
    }
  })

  it('requires negative or absence evidence for unsupported and rejected features', () => {
    const rows = readSourceMapRows()
    const statuses = new Set(['guarded-disabled', 'not-supported', 'deprecated-rejected'])

    for (const row of rows) {
      if (!statuses.has(row.support)) continue
      expect(row.testPath.includes('.test.'), `${row.feature} negative test path`).toBe(true)
      expect(
        /\b(reject|rejected|unsupported|not supported|not-supported|absent|no route|does not advertise|no matching endpoint|public docs must not claim|returns)\b/i.test(
          row.productionEvidence,
        ),
        `${row.feature} negative evidence`,
      ).toBe(true)
    }
  })

  it('requires matrix-level negative or absence evidence for unsupported and rejected features', () => {
    const rows = readProtocolMatrixRows()
    const statuses = new Set(['guarded-disabled', 'not-supported', 'deprecated-rejected'])

    for (const row of rows) {
      if (!statuses.has(row.support)) continue
      const location = `${row.file}:${row.line} ${row.feature}`
      const details = [row.notes, row.gap, row.productionEvidence].filter(Boolean).join(' ')
      expect(
        /\b(reject|rejects|rejected|return|returns|unsupported|not supported|not-supported|no route|not public-supported|must not claim|does not advertise|advertises .*false|supported=false|not implemented|outside current product scope|until .+ exists|do not issue|cannot be claimed)\b/i.test(
          details,
        ),
        `${location} matrix negative evidence`,
      ).toBe(true)
    }
  })

  it('points source-map code and test references at real repository paths', () => {
    const rows = readSourceMapRows()

    for (const row of rows) {
      const paths = [...repoPathsFromCell(row.codePath), ...repoPathsFromCell(row.testPath)]
      for (const path of paths) {
        expect(existsSync(path), `${row.feature} references missing path ${path}`).toBe(true)
      }
    }
  })

  it('uses only public docs slugs from the public docs registry', () => {
    const publicDocSlugs = publicDocSlugSet()
    const rows = readSourceMapRows()

    for (const row of rows) {
      const publicDocsPaths = publicDocPathsFromCell(row.publicDocsPath)
      for (const publicDocsPath of publicDocsPaths) {
        if (publicDocsPath === '/' || publicDocsPath === '/docs') continue
        const slug = publicDocsPath.slice(1)
        expect(
          publicDocSlugs.has(slug),
          `${row.feature} references unknown ${publicDocsPath}`,
        ).toBe(true)
      }
    }
  })

  it('keeps the public SCIM document exact and excludes Core SCIM subpaths', () => {
    expect(publicDocPathsFromCell('`/scim`; `/scim/v2`; `/scim/outbound`')).toEqual([
      '/scim',
      '/scim/v2',
      '/scim/outbound',
    ])

    const publicDocsPaths = readSourceMapRows().flatMap((row) =>
      publicDocPathsFromCell(row.publicDocsPath),
    )
    expect(publicDocsPaths).toContain('/scim')
    expect(publicDocsPaths.some((path) => path.startsWith('/scim/'))).toBe(false)
  })

  it('keeps the source-map public docs whitelist row tied to every guard test', () => {
    const row = sourceMapRow('Public docs whitelist')

    expect(row.publicDocsPath).toContain('product landing')
    expect(row.publicDocsPath).toContain('canonical `/docs` hub')
    expect(row.codePath).toContain(publicDocsRegistryPath)
    for (const testPath of publicDocsGuardTestPaths) {
      expect(row.testPath).toContain(`\`${testPath}\``)
      expect(existsSync(testPath), `${row.feature} guard path ${testPath}`).toBe(true)
    }
  })

  it('keeps the public docs registry on an explicit allowlist', () => {
    const publicDocSlugs = parsePublicDocSlugs().sort()
    expect(publicDocSlugs).toEqual(expectedPublicDocSlugs)

    for (const slug of forbiddenPublicDocSlugs) {
      expect(publicDocSlugs.includes(slug), `${publicDocsRegistryPath} exposes ${slug}`).toBe(false)
    }
  })

  it('keeps public docs tests blocking internal repository docs', () => {
    const registryTestSource = readFileSync(publicDocsRegistryTestPath, 'utf8')
    const generationTestSource = readFileSync(publicDocsGenerationTestPath, 'utf8')
    const siteWorkerTestSource = readFileSync(siteWorkerTestPath, 'utf8')
    const distAuditSource = readFileSync(siteDistAuditPath, 'utf8')
    const guardSources = [
      registryTestSource,
      generationTestSource,
      siteWorkerTestSource,
      distAuditSource,
    ].join('\n')

    for (const slug of internalDocSlugsRequiredInGuard) {
      expect(
        distAuditSource.includes(`'${slug}'`),
        `Site docs root denylist missing ${slug}`,
      ).toBe(true)
    }

    for (const required of [
      'INTERNAL_DOC_SLUGS',
      '`${prefix}/${slug}`',
      '`${prefix}/docs/${slug}`',
      '404-page',
    ]) {
      expect(
        guardSources.includes(required),
        `Site docs guards missing ${required}`,
      ).toBe(true)
    }
  })
})
