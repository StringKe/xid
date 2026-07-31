# Protocol standards and provider source-of-truth list

This document answers one question: when XID claims support for a protocol capability or a provider, which official document is that claim based on, and how strong is the evidence behind it. The readers are integrators, security reviewers and contributors who want to check whether XID protocol behaviour matches the specification.

This document records **external official sources** and **capability boundary wording** only. Per-capability implementation paths, test paths and gap lists live in `docs/protocols/source-map.md` and `docs/protocols/gap-audit.md`.

## Acceptance wording

- Local protocol implementation can be proven complete with L1/L2/L3 and fake provider or fake SaaS evidence.
- Real Slack/GitHub/Microsoft/Atlassian/Salesforce/Zoom L4 is used only for production-supported claims.
- Missing real L4 does not mean the local implementation is incomplete. These are two different gates.
- L4 is the gate for production-supported claims, not the gate for local implementation completion.

Local implementation status per role line:

- Role 1 XID as OIDC/OAuth IdP: `implemented`. Local L1/L2/L3 cover authorization code, PKCE, PAR, DPoP, userinfo, JAR, JARM, RAR, introspection, revocation and device flow across the current claim surface.
- Role 2 XID as enterprise upstream IdP SAML SP/OIDC RP: `provider-ready`. Real Microsoft Entra ID, Okta, Google Workspace, OneLogin, JumpCloud, PingOne, PingFederate, AD FS, Shibboleth and Keycloak L4 is missing.
- Role 3 XID as downstream SaaS SAML/OIDC IdP: the local baseline has landed. Outbound SAML IdP metadata, SSO endpoint, signed SAML Response, RelayState and NameID/email mapping have fake SaaS SP L3. Downstream OIDC builds on the existing OIDC/OAuth IdP baseline and fake SaaS OIDC RP callback L3, but SaaS-specific app presets and real SaaS L4 are still missing.
- Role 4 XID as SCIM Service Provider: `implemented`. Local L1/L2/L3 cover Users, Groups, PATCH, projection, simple filter and deprovisioning. Real Microsoft Entra/Okta/Auth0/Clerk/Zitadel provisioning into XID L4 is still missing.
- Downstream SaaS SCIM target clients: the local baseline has landed. `scim_targets`, `/scim/outbound/:targetId/sync`, Users/Groups push, deactivation PATCH and fake SaaS SCIM target L3 all pass. Real Slack/GitHub Enterprise Cloud/Atlassian/Salesforce/Zoom admin L4 is still missing.
- Role 5 XID as Social OAuth RP: `provider-ready`. Real GitHub, Google, Microsoft account and Apple provider secret/callback L4 is missing.

## Support levels

- `implemented`: code, configuration entry point, tests, documentation and local evidence are closed. A production-ready claim still requires L4.
- `provider-ready`: the code path, configuration entry point and local evidence exist, but a real external provider, IdP, SaaS, callback, secret, admin permission or provisioning run is missing. It must not be written as production supported.
- `guarded-disabled`: UI/API/docs/tests prove the capability is invisible or rejected.
- `planned`: in scope but not implemented.
- `not-supported`: explicitly unsupported. Public docs must not imply support.
- `deprecated-rejected`: deprecated or rejected for security reasons. A negative test is mandatory.

## Evidence levels

- L0: static scanning, typecheck, lint, build, documentation checks.
- L1: focused unit tests and mock tests.
- L2: Workers runtime HTTP integration with a real route, cookie and D1/DO/KV/R2/Queue binding or a local equivalent binding.
- L3: browser or protocol client against local/preview. Fake IdP, fake SaaS SP, fake SaaS RP and fake SaaS SCIM target are valid L3.
- L4: the current git HEAD deployed to production through Cloudflare Workers Builds, then verified against the real deployment address with real D1, a real provider, a real IdP, a real SaaS, a real browser or a real protocol client.

L4 is the gate for production-supported claims, not the gate for local implementation completion.

## The five role lines

| Role line | XID role                                      | External counterpart                                                                                                | Current local status                                                   | L4 boundary                                                                                    |
| --------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1         | OIDC/OAuth IdP                                | customer applications, SDKs, resource servers, generic OAuth/OIDC clients                                           | `implemented`                                                          | production supported requires a production issuer plus real client and real resource server L4 |
| 2         | SAML SP/OIDC RP of an enterprise upstream IdP | Microsoft Entra ID, Okta, Google Workspace, OneLogin, JumpCloud, PingOne, PingFederate, AD FS, Shibboleth, Keycloak | `provider-ready`                                                       | real IdP metadata/config/callback L4 is missing                                                |
| 3         | SAML/OIDC IdP for downstream SaaS             | Slack, GitHub Enterprise Cloud, Microsoft custom enterprise app, Atlassian, Salesforce, Zoom                        | SAML baseline `implemented`, downstream OIDC baseline `provider-ready` | real SaaS admin L4 is missing, so no production supported claim                                |
| 4         | SCIM Service Provider                         | Microsoft Entra ID, Okta, Google Workspace, OneLogin, JumpCloud and other external directories                      | `implemented`                                                          | real IdP provisioning into XID L4 is missing                                                   |
| 5         | Social OAuth RP                               | GitHub, Google, Microsoft account, Apple                                                                            | `provider-ready`                                                       | real provider secret/callback L4 is missing                                                    |

The two SCIM directions must be recorded separately:

- Inbound SCIM Service Provider: an external IdP or directory pushes users and groups into XID.
- Downstream SaaS SCIM target clients: XID pushes users and groups to SaaS platforms such as Slack, GitHub Enterprise Cloud, Atlassian, Salesforce and Zoom.
- Both directions have local implementation evidence. Inbound SCIM has local SCIM client L3. Outbound SCIM has fake SaaS SCIM target L3.
- Inbound SCIM L3 or real IdP provisioning L4 cannot be reused as downstream SaaS SCIM target L4. Outbound SCIM fake SaaS L3 also cannot be reused as real Slack/GitHub/Atlassian/Salesforce/Zoom production support.

## Official source baseline

Source verification date: 2026-06-08. When official sources are verified again, the new date must be written into `docs/protocols/provider-compatibility.md` in the same change.

### Competitors

- Auth0 Enterprise Connections: `https://auth0.com/docs/authenticate/enterprise-connections`
- Auth0 Enterprise Identity Providers: `https://auth0.com/docs/authenticate/identity-providers/enterprise-identity-providers`
- Auth0 WS-Fed protocol: `https://auth0.com/docs/authenticate/protocols/ws-fed-protocol`
- Auth0 Social Identity Providers: `https://auth0.com/docs/authenticate/identity-providers/social-identity-providers`
- Auth0 Google social connection: `https://auth0.com/docs/authenticate/identity-providers/social-identity-providers/google`
- Auth0 GitHub social connection: `https://auth0.com/docs/authenticate/identity-providers/social-identity-providers/github`
- Auth0 custom OAuth2 social connection: `https://auth0.com/docs/authenticate/identity-providers/social-identity-providers/oauth2`
- Auth0 Inbound SCIM: `https://auth0.com/docs/authenticate/protocols/scim/configure-inbound-scim`
- Auth0 outbound SAML IdP for GitHub Enterprise Cloud: `https://auth0.com/docs/authenticate/single-sign-on/outbound-single-sign-on/configure-auth0-saml-identity-provider/configure-saml2-web-app-addon-for-github-enterprise-cloud`
- Clerk Enterprise SSO: `https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/overview`
- Clerk Social Connections: `https://clerk.com/docs/nextjs/guides/configure/auth-strategies/social-connections/overview`
- Clerk OAuth SSO: `https://clerk.com/docs/guides/configure/auth-strategies/oauth/single-sign-on`
- Clerk Google social connection: `https://clerk.com/docs/guides/configure/auth-strategies/social-connections/google`
- Clerk GitHub social connection: `https://clerk.com/docs/guides/configure/auth-strategies/social-connections/github`
- Clerk Apple social connection: `https://clerk.com/docs/guides/configure/auth-strategies/social-connections/apple`
- Clerk Directory Sync SCIM: `https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/directory-sync`
- Zitadel external identity providers: `https://zitadel.com/docs/guides/integrate/identity-providers/introduction`
- Zitadel identity brokering: `https://zitadel.com/docs/concepts/features/identity-brokering`
- Zitadel Google identity provider: `https://zitadel.com/docs/guides/integrate/identity-providers/google`
- Zitadel Apple identity provider: `https://zitadel.com/docs/guides/integrate/identity-providers/apple`
- Zitadel Okta OIDC: `https://zitadel.com/docs/guides/integrate/identity-providers/okta-oidc`
- Zitadel Okta SAML: `https://zitadel.com/docs/guides/integrate/identity-providers/okta_saml`
- Zitadel OpenLDAP identity provider: `https://zitadel.com/docs/guides/integrate/identity-providers/openldap`
- Zitadel Okta SCIM: `https://zitadel.com/docs/guides/integrate/scim-okta-guide`

Confirmed competitor conclusions:

- Auth0 Enterprise Connections is the XID role 2 counterpart: Auth0 connecting to an external enterprise IdP.
- Auth0 Inbound SCIM is the XID role 4 counterpart: an external enterprise directory pushing users into Auth0. The official documentation covers SAML, OpenID Connect, Okta Workforce Identity and Microsoft Azure AD / Entra ID enterprise connection types, and supports user create/get/put/patch/delete/search/deactivate, the Enterprise User extension, connection-specific bearer tokens, token rotation and attribute mapping, but it does not support a full `/groups` endpoint.
- Auth0 outbound SSO and the outbound SAML IdP for GitHub Enterprise Cloud are the XID role 3 counterpart: Auth0 issues SAML to GitHub Enterprise Cloud, and the official outbound SSO documentation covers IdP-initiated marketplace integrations such as Slack and Zoom plus custom SAML/OIDC. That proves downstream SaaS SSO is an independent product surface which inbound enterprise SSO cannot replace.
- Clerk Enterprise SSO is SAML/OIDC enterprise inbound. Clerk EASIE OIDC is a multi-tenant IdP path for Google Workspace and Microsoft Entra ID, which is not the same as an XID downstream SaaS app catalog.
- Clerk OAuth SSO covers both directions at once. Sign in with Other App is Clerk acting as a Social OAuth RP; Sign in with Your App is Clerk acting as an OAuth 2.0/OIDC IdP for third-party client sign-in. The latter proves only a generic OAuth/OIDC IdP and cannot be automatically equated with a Slack/GitHub/Microsoft/Atlassian/Salesforce/Zoom SaaS-specific app catalog. Clerk generic OAuth/OIDC IdP evidence must not be treated as SaaS app catalog completion.
- Zitadel identity brokering and external IdP mean external IdPs signing in to ZITADEL, which maps to XID role 2 and role 5.
- Zitadel Okta SCIM is Okta provisioning into the ZITADEL SCIM endpoint, which maps to XID role 4. The official guide requires an existing Okta SAML app, a ZITADEL service account, the Org User Manager role and a PAT or client credentials, and the SCIM base URL is `https://${ZITADEL_DOMAIN}/scim/v2/{orgId}`.

### Enterprise IdPs and directories

- Microsoft Entra SSO options: `https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/what-is-single-sign-on`
- Microsoft Entra plan SSO deployment: `https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/plan-sso-deployment`
- Microsoft Entra SAML SSO: `https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/add-application-portal-setup-sso`
- Microsoft Entra OIDC SSO: `https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/add-application-portal-setup-oidc-sso`
- Microsoft Entra SCIM provisioning: `https://learn.microsoft.com/en-us/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups`
- Microsoft Entra app provisioning overview: `https://learn.microsoft.com/en-us/entra/identity/app-provisioning/user-provisioning`
- Microsoft Entra application gallery: `https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/overview-application-gallery`
- Microsoft Entra app integration planning: `https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/plan-an-application-integration`
- Okta app integrations: `https://developer.okta.com/docs/guides/create-an-app-integration/-/main/`
- Okta SCIM provisioning for app integrations: `https://help.okta.com/oie/en-us/Content/Topics/Apps/Apps_App_Integration_Wizard_SCIM.htm`
- PingOne SAML application: `https://docs.pingidentity.com/pingoneforenterprise/pingone_for_enterprise/p14e_add_update_saml_application.html`
- PingOne OIDC application: `https://docs.pingidentity.com/pingoneforenterprise/pingone_for_enterprise/p14e_integrate_oidc_application.html`
- PingFederate OIDC RP support: `https://docs.pingidentity.com/pingfederate/13.0/administrators_reference_guide/pf_oidc_relying_party_support.html`
- PingFederate browser SSO configuration: `https://docs.pingidentity.com/pingfederate/13.0/administrators_reference_guide/help_idpconnectionconfigtasklet_idpbrowserssostate.html`
- AD FS OAuth and OpenID Connect: `https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-adfsod/7fc51569-b46d-4aba-8ae6-bad19cb9951b`
- AD FS relying party trust: `https://learn.microsoft.com/en-us/windows-server/identity/ad-fs/operations/create-a-relying-party-trust`
- Shibboleth OIDC OP plugin: `https://shibboleth.atlassian.net/wiki/spaces/IDPPLUGINS/pages/1376878976/OIDC+OP`
- Shibboleth OIDC RP plugin: `https://shibboleth.atlassian.net/wiki/spaces/IDPPLUGINS/pages/1376878976/OIDC%20OP`
- Keycloak server admin guide: `https://www.keycloak.org/docs/latest/server_admin/`

Confirmed enterprise boundaries:

- Microsoft Entra ID can act as an enterprise upstream IdP, a SCIM provisioning client and a custom enterprise app management surface at the same time. All three must be split into different matrix rows.
- Microsoft Entra SSO options include SAML 2.0, WS-Federation, OpenID Connect, password-based SSO, linked sign-on, Integrated Windows Authentication and header-based SSO. The XID local baseline implements SAML/OIDC federation, LDAP direct bind, WS-Federation, SWA password vaulting, header-based SSO and a directory connector registry; linked launch and native IWA/Kerberos are out of scope. Real AD/LDAP gateway, AD FS signed `wresult`, SWA target replay and Application Proxy header L4 are still missing, so no production supported claim can be made.
- Microsoft Entra provisioning covers LDAP, SQL, REST, SOAP, flat-file, PowerShell and custom ECMA connectors in addition to SCIM. XID aligns only with the SCIM Service Provider and the outbound SCIM target client baseline, and claims no non-SCIM connector.
- Entra SCIM provisioning synchronizes assigned users and groups to the target app SCIM endpoint, Test Connection queries a non-existent user and expects an HTTP 200 empty ListResponse, and later sync cycles run about every 40 minutes.
- Real XID L4 must come from real IdP provisioning into XID.
- Okta app integrations cover OIDC, SAML, SWA, WS-Fed and SCIM. The XID local baseline implements SWA/password vaulting and WS-Fed routes, but real Okta SWA/WS-Fed L4 is still missing, so no production supported claim can be made. Adding SCIM provisioning to a custom app in the Okta AIW requires first creating a SAML or SWA SSO integration that supports SCIM; an OIDC integration currently cannot add SCIM provisioning. Okta OIDC upstream login and Okta SCIM provisioning must be verified separately.
- PingOne, PingFederate, AD FS, Shibboleth and Keycloak are only role 2 SAML/OIDC upstream provider-ready rows. WS-Fed, LDAP/AD federation and a Kerberos bridge are not part of the current support claim.

### Downstream SaaS SSO and SCIM targets

- Slack custom SAML: `https://slack.com/help/articles/205168057-Custom-SAML-single-sign-on`
- Slack SCIM: `https://api.slack.com/scim`
- GitHub Enterprise Cloud SAML IdP connection: `https://docs.github.com/en/enterprise-cloud@latest/organizations/managing-saml-single-sign-on-for-your-organization/connecting-your-identity-provider-to-your-organization`
- GitHub Enterprise Managed Users SAML SSO: `https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/configuring-authentication-for-enterprise-managed-users/configuring-saml-single-sign-on-for-enterprise-managed-users`
- GitHub Enterprise Cloud SCIM for Enterprise Managed Users: `https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/provisioning-user-accounts-with-scim/configuring-scim-provisioning-for-users`
- GitHub OAuth apps: `https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps`
- Atlassian identity provider setup: `https://support.atlassian.com/provisioning-users/docs/what-are-setup-options-for-provisioning-and-single-sign-on/`
- Atlassian SAML SSO: `https://support.atlassian.com/security-and-access-policies/docs/configure-saml-single-sign-on-with-an-identity-provider/`
- Atlassian SCIM provisioning: `https://support.atlassian.com/provisioning-users/docs/configure-user-provisioning-with-an-identity-provider/`
- Salesforce SAML Service Provider: `https://help.salesforce.com/s/articleView?id=xcloud.sso_saml.htm&type=5`
- Salesforce OIDC Authentication Provider: `https://developer.salesforce.com/docs/platform/mobile-sdk/guide/sso-provider-openid-connect.html`
- Salesforce SCIM official entry: `https://help.salesforce.com/s/articleView?id=xcloud.identity_scim_overview.htm&language=en_US&type=5`
- Zoom SAML SSO: `https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0065487`
- Zoom OIDC SSO: `https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0083701`
- Zoom SCIM2: `https://developers.zoom.us/docs/api/scim2/`

### Social provider official sources

- Google OpenID Connect: `https://developers.google.com/identity/openid-connect/openid-connect`
- Microsoft identity platform OIDC: `https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc`
- Microsoft identity platform authorization code flow: `https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow`
- Apple Sign in with Apple REST API: `https://developer.apple.com/documentation/signinwithapplerestapi`
- Apple Sign in with Apple web configuration: `https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web/`

Confirmed SaaS boundaries:

- Slack custom SAML requires the IdP to issue a signed SAML Response, with ACS `https://yourdomain.slack.com/sso/saml`, Entity ID `https://slack.com`, HTTP POST binding only, and required NameID and User.Email. It covers SP-initiated, IdP-initiated, JIT and SCIM provisioning, and Slack does not support Single Logout.
- Slack SCIM is a Slack-side SaaS API. It needs a Bearer OAuth token with the `admin` scope and a Business+ or Enterprise plan; the Enterprise org token is obtained by installing the SCIM app on the Enterprise organization. This is a downstream SaaS SCIM target.
- GitHub Enterprise Cloud SAML is a GitHub organization or enterprise connecting to an external IdP, which makes it a downstream SAML SP. The organization must be on GitHub Enterprise Cloud. Organization SCIM supported IdPs are Entra ID, Okta and OneLogin. Enterprise Managed Users OIDC is an Entra ID partner path, not generic downstream OIDC support for XID. REST API SCIM is not supported for enterprises with OIDC enabled.
- Atlassian Guard covers SAML SSO, JIT provisioning and SCIM user provisioning.
- The Salesforce SAML page confirms that a Salesforce org or Experience Cloud site can act as a SAML Service Provider, with an external IdP sending a SAML response that Salesforce validates. The OIDC document confirms Salesforce can be the relying party of a third-party OpenID provider. The SCIM page confirms the Salesforce SCIM 2.0 extension supports REST API create/read/update/disable of users, deactivate/reactivate and group member management.
- Zoom SAML SSO states that Zoom acts as the Service Provider, Zoom OIDC SSO can use discovery or manual endpoints, and the Zoom SCIM2 API supports User and Group provisioning.

## Provider grouping

| Provider                                                                      | Role                                       | Protocol direction                          | Current local status         | Must not be confused with                                    |
| ----------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------- | ---------------------------- | ------------------------------------------------------------ |
| Microsoft Entra ID                                                            | upstream enterprise IdP + SCIM client      | SAML upstream, OIDC upstream, SCIM inbound  | `provider-ready`, L4 missing | not the same as Microsoft custom enterprise app outbound SSO |
| Microsoft account                                                             | Social OAuth RP                            | OIDC social login                           | `provider-ready`, L4 missing | not the same as Entra enterprise SSO                         |
| Microsoft custom enterprise app                                               | downstream SaaS SAML/OIDC SP               | outbound SAML/OIDC                          | `provider-ready`, L4 missing | not the same as Microsoft account or Entra inbound SSO       |
| GitHub                                                                        | Social OAuth RP                            | OAuth social login                          | `provider-ready`, L4 missing | not the same as GitHub Enterprise SAML/SCIM                  |
| GitHub Enterprise Cloud                                                       | downstream SaaS SP + SCIM target           | outbound SAML, SCIM push target             | `provider-ready`, L4 missing | OIDC EMU belongs to the Entra ID partner path only           |
| Slack                                                                         | downstream SaaS SP + SCIM target           | outbound SAML, SCIM push target             | `provider-ready`, L4 missing | Slack does not support SLO                                   |
| Atlassian                                                                     | downstream SaaS SP + SCIM target           | outbound SAML, SCIM push target             | `provider-ready`, L4 missing | requires Atlassian Guard admin L4                            |
| Salesforce                                                                    | downstream SaaS SAML/OIDC SP + SCIM target | outbound SAML/OIDC, SCIM push target        | `provider-ready`, L4 missing | requires Salesforce admin L4                                 |
| Zoom                                                                          | downstream SaaS SAML/OIDC SP + SCIM target | outbound SAML/OIDC, SCIM push target        | `provider-ready`, L4 missing | requires Zoom admin and vanity URL L4                        |
| Google                                                                        | Social OAuth RP                            | OIDC social login                           | `provider-ready`, L4 missing | not the same as Google Workspace enterprise SSO/SCIM         |
| Google Workspace                                                              | upstream enterprise IdP + SCIM client      | SAML/OIDC upstream, SCIM inbound            | `provider-ready`, L4 missing | not the same as Google social login                          |
| Okta, OneLogin, JumpCloud, PingOne, PingFederate, AD FS, Shibboleth, Keycloak | upstream enterprise IdP                    | SAML/OIDC upstream and partial SCIM inbound | `provider-ready`, L4 missing | WS-Fed, LDAP and Kerberos are not part of the current claim  |

## P0 capability surface

### P0-A OAuth/OIDC security baseline

Status: `implemented`.

- PKCE S256, redirect URI exact match, authorization code one-time use, refresh token rotation, family replay revoke, state/nonce, RFC9207 `iss`, PAR, DPoP, JAR, JARM, RAR, introspection, revocation.
- Implicit flow, password grant, plain PKCE and wildcard redirect are `deprecated-rejected` or `not-supported`.

### P0-B SAML inbound SP

Status: `provider-ready`, real IdP L4 missing.

- SAML SP metadata, login, ACS, IdP metadata/cert, signed response/assertion, EncryptedAssertion.
- Audience, Recipient, Destination, InResponseTo, NotBefore, NotOnOrAfter, RelayState, replay defence.
- No production supported claim before real Microsoft Entra ID, Okta, Google Workspace, OneLogin, JumpCloud, PingOne, PingFederate, AD FS, Shibboleth and Keycloak L4 is obtained.

### P0-C Outbound SaaS SSO

Status: SAML baseline `implemented`, downstream OIDC baseline `provider-ready`, real SaaS L4 missing.

- `packages/saml/src/idp.ts` implements the IdP metadata and signed SAML Response builder.
- `apps/server/worker/sso/outbound-saml.ts` implements `/sso/outbound/saml/:appId/metadata` and `/sso/outbound/saml/:appId/sso`.
- `saml_service_providers` is used as the downstream SP registry.
- Fake SaaS SP L3 covers metadata, signed response, RelayState and ACS POST.
- Real admin L4 for Slack, GitHub Enterprise Cloud, Microsoft custom enterprise app, Atlassian, Salesforce and Zoom is still missing.
- Generic inbound and outbound SAML Single Logout has local L1/L2 implementation evidence:
  signed LogoutRequest verification, SessionIndex mapping, session revocation, signed
  LogoutResponse, and outbound SP notification. Real IdP and SaaS callback L4 is still missing.
  Slack is an explicit provider exception because Slack does not support Single Logout.
- The downstream OIDC app catalog stays `provider-ready` on top of the existing OIDC/OAuth IdP baseline and fake SaaS OIDC RP callback L3. SaaS-specific presets, assignment UI and real SaaS OIDC L4 are still missing.

### P0-D SCIM Service Provider

Status: `implemented`, real IdP provisioning L4 missing.

- ServiceProviderConfig, ResourceTypes, Schemas, Users, Groups.
- pagination, filter, attributes, excludedAttributes, PATCH.
- User `active=false` maps to deactivate, not physical deletion.
- The directory token is shown once, supports rotation, and the active gate is enforced.
- Real Microsoft Entra, Okta, Auth0, Clerk and Zitadel provisioning into XID L4 is still missing.

### P0-E Downstream SaaS SCIM target clients

Status: local baseline `implemented`, real SaaS L4 missing.

- `packages/db/src/schema/directory.ts` defines `scim_targets`.
- `packages/db/drizzle/0000_init.sql` is the matching migration.
- `apps/server/worker/scim/outbound.ts` implements `/scim/outbound/:targetId/sync`.
- Fake SaaS SCIM target L3 covers Users push, Groups push and deactivation PATCH.
- Real Slack, GitHub Enterprise Cloud, Atlassian, Salesforce and Zoom SCIM endpoints, tokens, admin permissions and L4 are still missing.
- Inbound SCIM L3 or real IdP provisioning L4 cannot be reused as downstream SaaS SCIM target L4.

### P0-F Social OAuth

Status: `provider-ready`, real provider L4 missing.

- GitHub, Google, Microsoft account and Apple have consistent configuration UI, secret ref, callback, account linking, domain policy and verified email policy.
- GitHub non-OIDC profile/email lookup covers the primary verified email.
- Apple form_post and private relay email are covered.
- Microsoft account issuer/JWKS covers the configuration boundary for common, organizations and consumers.
- While real provider L4 is missing the status stays `provider-ready` and no production supported claim can be made.

## P1 scope

- PingOne, PingFederate, AD FS, Shibboleth and Keycloak inbound SSO fixtures.
- OneLogin and JumpCloud SCIM provider fixtures.
- Preset UI and management API for Slack, GitHub Enterprise Cloud, Microsoft custom enterprise app, Atlassian, Salesforce and Zoom.
- Outbound SCIM target preset UI, queue retry, audit correlation and rate-limit handling for Slack, GitHub Enterprise Cloud, Atlassian, Salesforce and Zoom.
- An explicit implementation or rejection of OpenID Federation, CIBA, Session Management, Front-Channel Logout and Back-Channel Logout.
- A product decision on the Shared Signals Framework, CAEP and RISC.
- The FAPI 2.0 profile gate.

## P2 scope

- OID4VCI, OID4VP, UMA, GNAP, HEART.
- SAML artifact binding.
- mTLS sender-constrained tokens.
- A full app marketplace catalog.

## External inputs required for production-supported claims

While the following inputs are missing, the related `provider-ready` rows cannot be promoted to production supported:

- Real Microsoft Entra ID, Okta, Google Workspace, OneLogin and JumpCloud IdP permissions.
- Real PingOne, PingFederate, AD FS, Shibboleth and Keycloak configuration permissions.
- Real Slack Enterprise or GitHub Enterprise Cloud admin permissions.
- Real Microsoft Entra custom enterprise app admin permissions.
- Real Atlassian Guard org admin permissions.
- Real Salesforce admin permissions.
- Real Zoom admin permissions and an approved vanity URL.
- Real Social OAuth provider client secrets.
- Real SCIM provisioning app permissions.
- Real downstream SaaS SCIM endpoints, tokens and admin permissions.
- Permission to write provider configuration in the production environment.

## Related documents

- Protocol implementation evidence matrix: `docs/protocols/source-map.md`
- Protocol gap list: `docs/protocols/gap-audit.md`
- Per-provider compatibility detail: `docs/protocols/provider-compatibility.md`
- Per-provider integration runbooks: `docs/protocols/runbooks/README.md`
