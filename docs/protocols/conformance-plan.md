# Conformance Plan

This document answers one question: what has to be run before a protocol capability may be described as working, and at what strength. It is written for contributors adding or changing protocol behavior, and for anyone auditing how a support claim in `source-map.md` was earned.

Evidence levels L0 through L4 are defined in `README.md`. Each section below lists the concrete commands or runs that satisfy that level.

## L0

- Run `pnpm exec vp check` or package-scoped `vp check`.
- Run TypeScript typecheck for changed packages.
- Run `pnpm run i18n:compile -- --strict` after public text changes.
- Run `pnpm run protocols:source-map` to prove public protocol source-map rows have code/test/docs/evidence coverage and valid public docs slugs.
- Run `git diff --check`.

## L1

- OAuth/OIDC protocol package tests: `pnpm --filter @xid-kit/protocol test -- src/__tests__/discovery.test.ts src/__tests__/authorize.test.ts src/__tests__/pkce.test.ts src/__tests__/dpop.test.ts src/__tests__/tokens.test.ts src/__tests__/refresh.test.ts`。
- Worker OAuth/OIDC focused tests: `pnpm --filter @xid-kit/server exec vitest run worker/oidc/__tests__/discovery.test.ts worker/oidc/__tests__/authorize.test.ts worker/oidc/__tests__/token.test.ts worker/oidc/__tests__/par.test.ts`。
- SAML focused tests: `pnpm --filter @xid-kit/saml exec vitest run src/__tests__/verify.test.ts` and `pnpm --filter @xid-kit/server exec vitest run worker/sso/__tests__/saml-acs.test.ts worker/sso/__tests__/saml-router.test.ts worker/sso/__tests__/saml-jit.test.ts`。
- SCIM focused tests: `pnpm --filter @xid-kit/server exec vitest run worker/scim/__tests__/scim.test.ts`。
- WebAuthn focused tests: `pnpm --filter @xid-kit/webauthn test` and `pnpm --filter @xid-kit/server exec vitest run worker/auth/__tests__/passkey.test.ts worker/me-auth/__tests__/passkey-signin.test.ts worker/auth/__tests__/mfa.test.ts worker/me-auth/__tests__/mfa-challenge.test.ts worker/me/__tests__/mfa-factors.test.ts`。

## L2

- Real Worker route tests through `registerAllRoutes` for `/authorize`, `/token`, `/par`, `/userinfo`, `/introspect`, `/revoke`, `/device_authorization`, `/register`, `/scim/v2/*`, SAML ACS, and passkey routes.
- Use local D1/DO/KV/R2/Queue equivalent bindings.
- Prove public `/docs/*` only serves `apps/server/public-docs.ts` whitelist and blocks internal docs paths including `/docs/design`, `/docs/goal`, `/docs/verification`, `/docs/deployment`, and `/docs/api-contracts`.

## L3

- Hosted auth password, consent, logout, social OAuth, enterprise OIDC, and enterprise SAML fake IdP browser smoke: `pnpm --filter @xid-kit/server exec vitest run --config vitest.smoke.config.ts tests/smoke/l3-password-browser.test.mjs`。
- Passkey browser registration and sign-in smoke: `pnpm --filter @xid-kit/server exec vitest run --config vitest.smoke.config.ts tests/smoke/l3-passkey-browser.test.mjs`。
- Password reset browser smoke: `pnpm --filter @xid-kit/server exec vitest run --config vitest.smoke.config.ts tests/smoke/l3-password-reset-browser.test.mjs`。
- Protocol client runs for OAuth code flow, PAR, DPoP userinfo, and SCIM CRUD: `pnpm --filter @xid-kit/server exec vitest run --config vitest.smoke.config.ts tests/smoke/l3-protocol-client.test.mjs`。
- Outbound SaaS SSO has left `planned` for the local baseline: fake SP L3 proves outbound IdP metadata, SP-initiated SAMLRequest handling, IdP-initiated launch, signed Response, ACS POST, NameID/email mapping, RelayState guard, and org membership gate without claiming downstream SaaS production support.
- Generic customer-app OAuth/OIDC L3 evidence, Clerk-style OAuth SSO comparison evidence, and Social OAuth provider callback evidence do not prove SaaS-specific production support. Role 3 production-supported claims require SaaS app catalog behavior, Slack/GitHub/Microsoft/Atlassian/Salesforce/Zoom templates, assignment gates, a claim-mapping contract, and real SaaS L4.
- Fake SP L3 is a local implementation gate only. Public production support for Slack, GitHub Enterprise Cloud, Microsoft custom enterprise app, Atlassian, Salesforce, or Zoom still requires the L4 runs below.
- Inbound SCIM Service Provider L3 is only a provider-ready gate. It must not claim Auth0, Clerk, Zitadel, Okta, Microsoft Entra, or other real IdP provisioning completion until a real IdP provisioning run proves Users/Groups, schema, PATCH, active deprovisioning, token handling, and audit behavior without storing SCIM bearer tokens or raw sensitive payloads.
- Downstream SaaS SCIM target clients have left `planned` for the local baseline: fake SaaS SCIM L3 proves outbound SCIM target config, secret ref lookup, user create, active=false PATCH mapping, group create, and membership push; Management API CRUD and assignment gate sync filtering are landed. Inbound SCIM Service Provider L3 evidence does not prove SCIM push-to-SaaS L4. Production support still requires per-SaaS templates, retry/audit behavior, and real SaaS admin runs.

## L4

- Only mark production-ready after connected Git Workers Builds deploys current HEAD.
- Record build id, active deployment, active version, and production route/client/provider evidence.
- Production public docs evidence must include `/docs`, `/docs/scim`, and internal docs blocking for `/docs/design`, `/docs/goal`, `/docs/verification`, and `/docs/deployment`.
- Provider-ready features require real provider secret/config/callback evidence without recording secrets, OTP values, SAMLResponse, authorization codes, refresh tokens, cookies, or provider tokens.

### Production readiness inputs

`pnpm run goal:readiness` is the production readiness gate. It is deliberately stricter than the protocol matrix: the matrix proves local implementation coverage, this gate proves a deployed instance actually serves the claimed behavior against real providers. The following inputs are required before provider-ready rows can be treated as L4 evidence.

| Gate                                | Provider policy requirement                                                                                                                                                                                                                                                                                                                                                                                                      | Full L4 evidence input                                                                                                                                                                                                                                                                                                |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WhatsApp OTP                        | An active organization enables Hosted Auth `whatsappOtp` for login and user creation, enables a WhatsApp delivery channel, uses provider `twilio` or `meta`, has all referenced provider secrets or vars, and has a sender configured.                                                                                                                                                                                           | Set `XID_PRODUCTION_PHONE_OTP_CHANNEL=whatsapp` plus `XID_PRODUCTION_PHONE_OTP_ORGANIZATION_ID`, `XID_PRODUCTION_PHONE_OTP_PHONE_FILE`, and `XID_PRODUCTION_PHONE_OTP_CODE_FILE` from a real received OTP; or record current production evidence under the phone WhatsApp evidence key without storing the OTP value. |
| SMS OTP                             | An active organization enables Hosted Auth `smsOtp` for login and user creation, enables an SMS delivery channel, uses provider `twilio`, `vonage`, `infobip`, or `messagebird`, has all referenced provider secrets or vars, and has a sender configured.                                                                                                                                                                       | Set `XID_PRODUCTION_PHONE_OTP_CHANNEL=sms` plus `XID_PRODUCTION_PHONE_OTP_ORGANIZATION_ID`, `XID_PRODUCTION_PHONE_OTP_PHONE_FILE`, and `XID_PRODUCTION_PHONE_OTP_CODE_FILE` from a real received OTP; or record current production evidence under the phone SMS evidence key without storing the OTP value.           |
| Social OAuth                        | An active organization allows existing-user Hosted Auth login, has `forceSso=false`, enables a social provider with `clientId`, authorization endpoint, token endpoint, `clientSecretRef`, a matching Workers secret, and issuer/JWKS metadata for OIDC providers.                                                                                                                                                               | Record a real production provider callback evidence entry without storing provider tokens, authorization codes, cookies, or refresh tokens.                                                                                                                                                                           |
| Enterprise SSO                      | An active organization enables enterprise SSO login and has an active SAML connection with IdP entity ID plus SSO URL or metadata URL, or an OIDC connection with client ID plus discovery URL.                                                                                                                                                                                                                                  | Record a real production IdP callback evidence entry without storing SAMLResponse, provider tokens, authorization codes, cookies, or refresh tokens.                                                                                                                                                                  |
| Inbound SCIM Service Provider       | An active organization has a real directory/IdP provisioning app configured against XID `/scim/v2`, a directory bearer token, assigned users and groups, and expected schema/attribute mappings. Okta SCIM must use SAML or SWA integration rather than OIDC; Microsoft Entra Test Connection must return HTTP 200 empty ListResponse for a non-existent user; Auth0/Clerk/Zitadel comparisons remain role evidence, not XID L4. | Record a real IdP provisioning run for create/update/deactivate and group or membership behavior without storing SCIM bearer tokens, raw emails beyond redacted identifiers, provider tokens, cookies, or raw sensitive payloads.                                                                                     |
| MFA SMS                             | The SMS OTP policy above is ready and the organization has at least one verified phone for the step-up user.                                                                                                                                                                                                                                                                                                                     | Record a real production SMS step-up evidence entry without storing OTP values, cookies, or session tokens.                                                                                                                                                                                                           |
| Outbound SaaS SSO                   | XID has outbound SAML/OIDC IdP metadata, SSO endpoint, assertion/token signer, SaaS app catalog, Slack template, GitHub Enterprise template, Microsoft custom enterprise app template, Atlassian template, Salesforce template, Zoom template, assignment gates, and public docs boundary text.                                                                                                                                  | Record a fake SP L3 run and real Slack Enterprise, GitHub Enterprise Cloud, Microsoft Entra custom enterprise app, Atlassian, Salesforce, and Zoom admin runs without storing SAMLResponse values, provider tokens, authorization codes, cookies, or refresh tokens.                                                  |
| Downstream SaaS SCIM target clients | XID has outbound SCIM client implementation, per-SaaS endpoint templates, encrypted token storage or secret refs, assignment gates, retry/audit handling, Slack template, GitHub Enterprise Cloud template, Atlassian template, Salesforce template, Zoom template, and public docs boundary text.                                                                                                                               | Record a fake SaaS SCIM L3 run and real Slack Enterprise, GitHub Enterprise Cloud, Atlassian, Salesforce, and Zoom admin runs without storing SCIM bearer tokens, provider tokens, cookies, or raw sensitive payloads.                                                                                                |

Outbound SaaS SSO L4 evidence must be recorded per SaaS role:

- Slack Enterprise: workspace or Enterprise Grid admin setup, custom SAML ACS/entityID, signed Response verification, assignment gate, and no SLO claim.
- GitHub Enterprise Cloud: enterprise or organization admin setup, SAML Sign On URL, issuer, certificate, RSA-SHA256/SHA256, NameID mapping, optional SCIM alignment, and no OIDC generic support claim except the Entra ID partner path.
- Microsoft custom enterprise app: Entra custom SAML or OIDC app setup, Reply URL or redirect URI, Entity ID or client ID, issuer, claim mapping, user assignment, and callback evidence.
- Atlassian: Atlassian Guard org admin setup, SAML SSO configuration, verified domain or identity provider directory, NameID/email mapping, optional SCIM alignment, and callback evidence.
- Salesforce: Salesforce admin setup, SAML Service Provider or OpenID Connect authentication provider configuration, callback URL, issuer/client metadata, claim mapping, optional SCIM alignment, and callback evidence.
- Zoom: Zoom admin setup, approved vanity URL, SAML or OIDC SSO configuration, callback URL or SP metadata, claim mapping, optional SCIM2 alignment, and callback evidence.

Generic OIDC client L4, Social OAuth L4, inbound enterprise SSO L4, and SCIM provisioning L4 cannot be reused as outbound SaaS SSO L4 unless the same run proves the SaaS-specific app catalog row above.

Downstream SaaS SCIM target L4 evidence must be recorded per SaaS role:

- Slack Enterprise: Business+ or Enterprise plan, admin or owner SCIM token, `/scim/v2` Users/Groups create/update/deactivate, rate-limit handling, and no permanent-delete claim.
- GitHub Enterprise Cloud: Enterprise Managed Users setup, partner IdP or open SCIM configuration, Users/Groups lifecycle, group assignment, and no generic OIDC support claim except the Entra ID partner path.
- Atlassian: Atlassian Guard org admin setup, SCIM provisioning configuration, users/groups create/update/deactivate, verified domain or identity provider directory, and SAML/JIT boundary evidence.
- Salesforce: Salesforce admin setup, SCIM user identity management configuration, users/groups or role mapping behavior allowed by the org, and callback-free provisioning evidence.
- Zoom: Zoom admin setup, SSO-enabled account, SCIM2 Users/Groups create/update/deactivate, `active=false` behavior, approved account requirements, and rate-limit handling.

Inbound SCIM Service Provider L4, inbound enterprise SSO L4, outbound SaaS SSO L4, and Social OAuth L4 cannot be reused as downstream SaaS SCIM target L4 unless the same run proves outbound SCIM push against the SaaS target API.
