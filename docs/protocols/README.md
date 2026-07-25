# XID Protocol Matrix Overview

This directory answers one question: for every protocol capability, how far does XID actually support it, against which standard, which code, and which test. The audience is integrators, security reviewers, and contributors who need to check protocol behavior.

Every capability is bound to a standards source, a support level, a code path, a test path, and an evidence level, so that the word "supported" never stays ambiguous. The public HTTP `/docs/*` site does not render this directory; it is written for people reading the source.

## Support Levels

- `implemented`: code, configuration entry point, tests, docs, and evidence are closed. Critical paths covering sign-in, token, SCIM, SAML, and WebAuthn have at least L2 or L3. A production-supported claim still MUST have L4.
- `provider-ready`: code and configuration entry points exist and local evidence can close, but a real external provider secret, a real IdP, a real SaaS, a real callback, or a real provisioning run is required before claiming production supported.
- `guarded-disabled`: explicitly not enabled, with UI/API/docs/test evidence that it is invisible or rejected.
- `planned`: the standard is in scope but not implemented.
- `not-supported`: explicitly unsupported; public docs MUST NOT imply support.
- `deprecated-rejected`: the protocol or flow is deprecated or rejected on security grounds, and a negative test MUST exist.

Support level rules:

- `implemented` is not a production-supported claim. Without L4, the only statement allowed is that local or preview evidence is closed.
- `provider-ready` is not a completion state. The missing real provider, IdP, SaaS, callback, secret, or provisioning input MUST be listed.
- Downstream SaaS SSO such as Slack, GitHub Enterprise Cloud, Microsoft custom enterprise app, Atlassian, Salesforce, and Zoom already has an outbound SAML IdP baseline and local fake SaaS SP L3, but before real SaaS L4 it may only be claimed as local implementation or provider-ready, and MUST NOT be claimed production supported.
- Downstream SaaS SCIM target clients such as Slack, GitHub Enterprise Cloud, Atlassian, Salesforce, and Zoom already have an outbound SCIM client baseline and local fake SaaS SCIM L3, but MUST NOT be claimed production supported before real SaaS L4.
- GitHub Social OAuth MUST NOT substitute for GitHub Enterprise SAML/SCIM. Microsoft account MUST NOT substitute for Microsoft Entra ID or Microsoft custom enterprise app.
- Enterprise SSO currently commits to local SAML SP, OIDC RP, LDAP direct bind, WS-Federation, SWA/password vaulting, header-based SSO, directory connector framework, SCIM Service Provider, Social OAuth RP, outbound SAML IdP baseline, and outbound SCIM client baseline. linked sign-on, native IWA/Kerberos termination, non-HTTP LDAP sockets, and SQL/REST/SOAP/PowerShell/ECMA provisioning connectors remain non-goal boundaries; Kerberos is covered by deployment-pattern documentation only.

## Completion Gate

- Standards and provider source-of-truth URLs live in `docs/standards-sources.md`; per-feature evidence lives in `docs/protocols/source-map.md`.
- local protocol implementation can be completed with L1/L2/L3 and fake provider or fake SaaS evidence.
- Missing real provider/IdP/SaaS L4 blocks only production-supported claims. It is not a support level.
- Passing `pnpm run protocols:source-map` proves the source-map and local evidence are internally aligned. It does not prove production-supported completion.
- Role 2 provider-ready rows still need real IdP metadata, configuration, callback, and production evidence before production-supported claims.
- Role 4 inbound SCIM still needs real Microsoft Entra, Okta, Auth0, Clerk, or Zitadel provisioning into XID before production-supported claims.
- Role 5 social OAuth still needs real provider secrets, callbacks, and production evidence before production-supported claims.
- Role 3 downstream SaaS SSO and downstream SaaS SCIM target clients have local baseline evidence, but real Slack/GitHub/Microsoft/Atlassian/Salesforce/Zoom L4 is still missing.

## Evidence Levels

- L0: static scanning, typecheck, lint, build, and documentation checks.
- L1: focused unit tests and mock tests.
- L2: Workers runtime HTTP integration with real routes, cookies, and D1/DO/KV/R2/Queue bindings or their local equivalents.
- L3: a browser or protocol client against local/preview.
- L4: the current git HEAD is auto-deployed to production by Cloudflare Workers Builds, then verified against the real deployment address, real D1, a real provider, a real IdP, a real browser, or a real protocol client.

## Protocol Role Lines

This directory records support status per role line; one brand name MUST NOT be collapsed into a single capability:

- XID as OIDC/OAuth IdP: customer applications treat XID as their Authorization Server and OpenID Provider.
- XID as enterprise upstream IdP SAML SP/OIDC RP: enterprises sign in to XID Hosted Auth with Okta, Microsoft Entra ID, Google Workspace, and similar.
- The implemented matrix for this role line covers Okta, Microsoft Entra ID, Google Workspace, OneLogin, JumpCloud, PingOne, PingFederate, AD FS, Shibboleth, and Keycloak, plus LDAP direct bind, WS-Federation, SWA/password vaulting, and header-based SSO. All of them lack real IdP L4; linked sign-on and a native Kerberos bridge are not part of the current support claim.
- XID as downstream SaaS SAML/OIDC IdP: enterprises connect XID to SaaS such as Slack, GitHub Enterprise Cloud, Microsoft custom enterprise app, Atlassian, Salesforce, and Zoom. The outbound SAML IdP baseline currently has local fake SaaS SP L3, downstream OIDC reuses the generic OIDC/OAuth IdP baseline, and production supported MUST NOT be claimed while real SaaS L4 is missing.
- XID as SCIM Service Provider: external directory services push users and groups into XID.
- Downstream SaaS SCIM target clients run in the opposite direction: XID pushes users and groups into SaaS SCIM APIs such as Slack, GitHub Enterprise Cloud, Atlassian, Salesforce, and Zoom. The outbound SCIM client baseline currently has local fake SaaS SCIM L3, it MUST NOT reuse inbound SCIM Service Provider evidence, and production supported MUST NOT be claimed while real SaaS L4 is missing.
- XID as Social OAuth RP: users sign in to XID with GitHub, Google, Microsoft account, Apple, and similar.

## Standards Version Baseline

The matrices in this directory are written against the standards versions below. When a standard advances, this section and `docs/protocols/security-profiles.md` MUST be updated together.

- Standards refresh: OAuth 2.1 is `draft-ietf-oauth-v2-1-15` updated 2026-03-02; OAuth Browser-Based Apps is `draft-ietf-oauth-browser-based-apps-26` in `RFC Ed Queue` as of 2026-05-20; WebAuthn Level 3 is W3C Candidate Recommendation Snapshot 2026-05-26; NIST SP 800-63-4 final released 2025-07; OpenID Shared Signals Framework 1.0, CAEP 1.0, and RISC 1.0 are Final.

## Document Index

- `oauth.md`: OAuth 2.x authorization server matrix.
- `oidc.md`: OIDC OP/RP matrix.
- `saml.md`: SAML SSO matrix.
- `scim.md`: SCIM 2.0 matrix.
- `webauthn-passkeys.md`: WebAuthn, passkey, and MFA matrix.
- `tokens-sessions.md`: token, key, session, and cookie matrix.
- `security-profiles.md`: OAuth Security BCP, FAPI, NIST, AAL/ACR/AMR mapping.
- `provider-compatibility.md`: provider compatibility notes.
- `conformance-plan.md`: L0/L1/L2/L3/L4 verification plan.
- `gap-audit.md`: current gap audit.
- `source-map.md`: feature to code/test/docs/evidence map.
- `runbooks/README.md`: index of the per-provider integration runbooks.
- `../standards-sources.md`: the list of official standards and provider sources.

## Competitor Alignment Baseline

- Auth0: the official docs cover Enterprise Connections, Social Identity Providers, and Inbound SCIM, plus an outbound SAML IdP for GitHub Enterprise Cloud. XID role 3 currently has an outbound SAML IdP baseline; the gaps are real SaaS L4 and productized SaaS presets.
- Auth0: the official docs also cover Active Directory/LDAP, ADFS, and WS-Fed. XID currently has local baselines for LDAP direct bind, WS-Federation, and SWA/password vaulting, but lacks real AD/LDAP gateway, AD FS WS-Fed, and target app L4.
- Auth0 Inbound SCIM: the official docs cover SAML, OpenID Connect, Okta Workforce Identity, and Microsoft Azure AD / Entra ID enterprise connection types, support user create/get/put/patch/delete/search/deactivate, the Enterprise User extension, connection-specific bearer tokens, token rotation, and attribute mapping, but do not support a full `/groups` endpoint. Auth0 SCIM deactivate/block terminates Auth0 sessions, revokes refresh tokens, and can trigger OIDC Back-Channel Logout when configured. XID role 4 already has local Users/Groups evidence but still lacks real IdP provisioning L4.
- Auth0 outbound SSO: the official docs cover IdP-initiated marketplace integrations, including Dropbox, Slack, and Zoom, and also support custom SAML or OIDC. This proves role 3 downstream SaaS SSO is a distinct product surface that MUST NOT be replaced by an inbound enterprise connection.
- Clerk: the official docs cover Enterprise SSO (SAML/OIDC), Social Connections OAuth, Clerk as OAuth/OIDC IdP, and Directory Sync SCIM 2.0 GA. XID MUST verify Social OAuth, generic customer-app OAuth/OIDC IdP, enterprise SSO, SaaS-specific outbound SSO, and SCIM separately, and MUST NOT write production supported while real provider, IdP provisioning, or SaaS L4 is missing.
- Clerk OAuth SSO: the official docs state two explicit directions. Sign in with Other App is Clerk acting as a Social OAuth RP, and Sign in with Your App is Clerk acting as an OAuth 2.0/OIDC IdP. The second one proves the generic OAuth/OIDC IdP role only; it does not prove that the Slack/GitHub/Microsoft custom enterprise app SaaS catalog is production-supported.
- Clerk Directory Sync: the official docs state that Directory Sync is SCIM 2.0 Service Provider behavior, the IdP pushes create/update/delete/disable into Clerk, Clerk revokes active sessions on deprovisioning, and a SAML or OIDC enterprise connection MUST exist first.
- Zitadel: the official docs cover external identity providers, identity brokering, Google/Apple social login, Okta OIDC/SAML identity provider, LDAP external IdP, and Okta SCIM provisioning. XID aligns on the Social OAuth RP, inbound OIDC RP, inbound SAML SP, and SCIM Service Provider role lines. XID also has an LDAP direct bind baseline, which is not downstream SaaS SSO.
- Zitadel SCIM: the official Okta guide is Okta provisioning into ZITADEL, requiring an existing Okta SAML app, a ZITADEL service account, the Org User Manager role, and a PAT or client credentials, with SCIM base URL `https://${ZITADEL_DOMAIN}/scim/v2/{orgId}`. That only proves the role 4 inbound SCIM Service Provider direction.
- Okta and Microsoft Entra: the official docs cover WS-Fed, SWA/password vaulting, linked sign-on, IWA/Kerberos, header-based SSO, and non-SCIM provisioning connectors. XID currently implements local baselines for WS-Fed, SWA/password vaulting, header-based SSO, and the directory connector framework; linked sign-on, native IWA/Kerberos, and non-SCIM connector execution still lack L4.
- Okta SCIM: the official docs state that adding SCIM provisioning to a custom app in the AIW requires first creating a SAML or SWA SSO integration that supports SCIM, and that an OIDC integration currently cannot add SCIM provisioning. Okta OIDC upstream login and Okta SCIM provisioning MUST be verified separately.
- Microsoft Entra SCIM: the official docs state that Entra provisioning synchronizes assigned users and groups to the target app SCIM endpoint, that Test Connection queries a non-existent user and expects HTTP 200 with an empty ListResponse, and that later sync cycles run about every 40 minutes. A new gallery connector requires SCIM 2.0 user/group endpoints, schema discovery, PATCH group membership, and OAuth 2.0 client credentials. XID still lacks real Entra provisioning L4.
- PingOne, PingFederate, AD FS, Shibboleth, and Keycloak: the official docs all cover SAML/OIDC or OIDC/OAuth upstream IdP capabilities. XID lists these as SAML/OIDC upstream implemented with a legacy WS-Fed/LDAP/header baseline, and does not commit to linked sign-on or a native Kerberos bridge.
- Slack: the official custom SAML docs confirm Slack is the downstream SP, with ACS URL `https://yourdomain.slack.com/sso/saml`, Entity ID `https://slack.com`, HTTP POST binding only, a required signed SAML Response, NameID and User.Email, support for IdP-initiated, SP-initiated, JIT, and SCIM provisioning, and no Single Logout support. XID currently has an outbound SAML IdP route, metadata, an assertion builder, and fake SaaS SP L3, but lacks a Slack template UI and real Slack admin L4.
- Slack SCIM: the official SCIM API is a downstream target API, with SCIM 2.0 base path `/scim/v2`, a Bearer OAuth token carrying the `admin` scope, a Business+ or Enterprise plan, and an Enterprise org token obtained by installing the SCIM app on the Enterprise organization. The XID outbound SCIM client baseline has fake SaaS SCIM L3 but lacks real Slack SCIM token/admin L4.
- GitHub Enterprise Cloud: the official SAML docs confirm a GitHub organization connects an external IdP, and the organization MUST be on GitHub Enterprise Cloud. Organization SCIM supported IdPs are Entra ID, Okta, and OneLogin. Enterprise Managed Users SCIM is IdP-to-GitHub user lifecycle management, partner IdP paths cover Entra ID OIDC/SAML, Okta SAML, and PingFederate SAML, non-partner setups can use GitHub REST API endpoints for SCIM, but REST API SCIM is not supported for enterprises enabled for OIDC. XID currently has a generic outbound SAML and outbound SCIM baseline, but lacks a GitHub template and real GitHub Enterprise L4.
- Atlassian, Salesforce, and Zoom: the official docs cover the SAML, OIDC, or SCIM capabilities of these SaaS as downstream SP or SCIM target. Salesforce Help pages were browser/manual verified down to the SAML Service Provider and SCIM body text: a Salesforce org or Experience Cloud site can act as a SAML SP, and SCIM supports user create/read/update/disable, deactivate/reactivate, and group member management. XID currently has a generic outbound SAML and outbound SCIM baseline, but does not commit to real Atlassian, Salesforce, or Zoom being production-supported.

## Overall Conclusion

XID already has the main entry points for OAuth/OIDC, inbound SAML SP, outbound SAML IdP baseline, inbound SCIM Service Provider, outbound SCIM client baseline, WebAuthn, Passkey, and token/session. `implemented` may only be used for a feature whose code, config, tests, docs, and local evidence are all closed. Slack/GitHub Enterprise/Microsoft custom app/Atlassian/Salesforce/Zoom belong to downstream SaaS SSO, which currently has outbound SAML IdP routes, metadata, assertion generation, and fake SaaS SP L3, but lacks SaaS-specific preset UI and real SaaS L4. The SCIM target APIs of Slack/GitHub Enterprise/Atlassian/Salesforce/Zoom are also not completion evidence for XID inbound SCIM; there is an outbound SCIM client and fake SaaS SCIM L3 today, but real SaaS admin L4 is missing.
