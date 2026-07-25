# XID Documentation

Chinese version: [zh-Hans/README.md](./zh-Hans/README.md)

XID is a multi-tenant identity platform running on Cloudflare Workers: an OIDC/OAuth2 IdP, an organization model with RBAC, enterprise SSO federation (SAML/OIDC), SCIM directory sync, and passkey/WebAuthn. MIT licensed, and self-hosting gives you the complete feature set.

This directory holds the in-repository documentation. Pick an entry point by what you are trying to do.

## I want to integrate XID into my application

Start with the SDKs, then read the protocol detail you need.

| Goal                                           | Document                                             |
| ---------------------------------------------- | ---------------------------------------------------- |
| Is there an SDK for my language or framework   | [sdks/platform-matrix.md](./sdks/platform-matrix.md) |
| Browser (vanilla or any framework)             | [sdks/web.md](./sdks/web.md)                         |
| React                                          | [sdks/react.md](./sdks/react.md)                     |
| Next.js                                        | [sdks/nextjs.md](./sdks/nextjs.md)                   |
| Verifying tokens and webhooks on a server      | [sdks/backend.md](./sdks/backend.md)                 |
| React Native                                   | [sdks/react-native.md](./sdks/react-native.md)       |
| iOS                                            | [sdks/ios.md](./sdks/ios.md)                         |
| macOS                                          | [sdks/macos.md](./sdks/macos.md)                     |
| Android                                        | [sdks/android.md](./sdks/android.md)                 |
| Flutter                                        | [sdks/flutter.md](./sdks/flutter.md)                 |
| HTTP contract (calling the API without an SDK) | [api-contracts.md](./api-contracts.md)               |

The 13 native SDKs under `sdk/` are published to no registry. They ship as source inside the repository; see the platform matrix.

## I want to know which protocols XID supports, and how far

`docs/protocols/` binds every protocol capability to its standard source, support level, code path, test path and evidence level. "Support" has a strict definition there; it is not a marketing word.

| Goal                                       | Document                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| Start here: how to read a support level    | [protocols/README.md](./protocols/README.md)                                 |
| OAuth 2.x authorization server matrix      | [protocols/oauth.md](./protocols/oauth.md)                                   |
| OIDC OP/RP matrix                          | [protocols/oidc.md](./protocols/oidc.md)                                     |
| SAML SSO matrix                            | [protocols/saml.md](./protocols/saml.md)                                     |
| SCIM 2.0 matrix                            | [protocols/scim.md](./protocols/scim.md)                                     |
| WebAuthn / passkey / MFA matrix            | [protocols/webauthn-passkeys.md](./protocols/webauthn-passkeys.md)           |
| Token, key, session and cookie behaviour   | [protocols/tokens-sessions.md](./protocols/tokens-sessions.md)               |
| FAPI / NIST / AAL / ACR / AMR              | [protocols/security-profiles.md](./protocols/security-profiles.md)           |
| Per-IdP compatibility notes                | [protocols/provider-compatibility.md](./protocols/provider-compatibility.md) |
| Full capability to code and test mapping   | [protocols/source-map.md](./protocols/source-map.md)                         |
| Known gaps and what would close them       | [protocols/gap-audit.md](./protocols/gap-audit.md)                           |
| Official standard and provider source list | [standards-sources.md](./standards-sources.md)                               |

### Connecting a specific IdP or SaaS

`docs/protocols/runbooks/` holds the per-provider runbooks, indexed in [protocols/runbooks/README.md](./protocols/runbooks/README.md).

Upstream enterprise IdPs (sign in to XID with them):

- [Microsoft Entra ID](./protocols/runbooks/microsoft-entra-id.md)
- [Okta](./protocols/runbooks/okta.md)
- [Google Workspace](./protocols/runbooks/google-workspace.md)
- [OneLogin](./protocols/runbooks/onelogin.md)
- [JumpCloud](./protocols/runbooks/jumpcloud.md)
- [PingOne](./protocols/runbooks/pingone.md)
- [PingFederate](./protocols/runbooks/pingfederate.md)
- [AD FS](./protocols/runbooks/adfs.md)
- [Shibboleth](./protocols/runbooks/shibboleth.md)
- [Keycloak](./protocols/runbooks/keycloak.md)

Downstream SaaS (sign in to them with XID):

- [Slack](./protocols/runbooks/slack-downstream-saml.md)
- [GitHub Enterprise](./protocols/runbooks/github-enterprise-downstream-saml.md)
- [Microsoft custom enterprise application](./protocols/runbooks/microsoft-enterprise-app-downstream.md)
- [Atlassian](./protocols/runbooks/atlassian-downstream-saml.md)
- [Salesforce](./protocols/runbooks/salesforce-downstream-saml-oidc.md)
- [Zoom](./protocols/runbooks/zoom-downstream-saml-oidc.md)

## I want to deploy my own instance

| Goal                                    | Document                                                         |
| --------------------------------------- | ---------------------------------------------------------------- |
| Deploy to Cloudflare from scratch       | [deployment.md](./deployment.md)                                 |
| Evidence levels and commands (L0 to L4) | [protocols/conformance-plan.md](./protocols/conformance-plan.md) |
| What a DELETE endpoint really does      | [soft-delete.md](./soft-delete.md)                               |

Before deploying, read at least the Secrets section of [deployment.md](./deployment.md): losing `KEK` or `PEPPER` is unrecoverable.

## I want to change XID's code

`docs/design/` is the source of truth for product design, and records **why** each subsystem is built the way it is. Read the relevant chapter before changing an implementation; change the design there first. A Chinese mirror of all nine chapters lives in [zh-Hans/design/](./zh-Hans/design/README.md); the English chapters are authoritative.

| Chapter                                                        | Contents                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [Design index](./design/README.md)                             | Overview of the nine chapters                                                   |
| [00 Overview](./design/00-overview.md)                         | Positioning, license, stack, build-vs-buy boundary, TenantContext, domain model |
| [01 Authentication](./design/01-authentication.md)             | Passkey, password, social, passwordless, MFA, anti-abuse                        |
| [02 Tenancy and RBAC](./design/02-tenancy-rbac.md)             | Organization model, membership, permissions, data isolation                     |
| [03 OIDC/OAuth](./design/03-oidc-oauth.md)                     | Endpoints, grants, tokens, advanced security, consent                           |
| [04 Enterprise SSO](./design/04-enterprise-sso.md)             | SAML/OIDC federation, JIT, SCIM, SAML constraints on Workers                    |
| [05 Users and sessions](./design/05-users-sessions.md)         | User model, sign-up and sign-in orchestration, GDPR, session management         |
| [06 Developer experience](./design/06-developer-experience.md) | SDK layering, Management API, webhooks                                          |
| [07 Platform operations](./design/07-platform-operations.md)   | Console, branding, notifications, i18n, audit, metering                         |
| [08 Data model](./design/08-data-model.md)                     | D1 table inventory and isolation constraints                                    |

For copy changes or adding a language, see [i18n.md](./i18n.md). Changing protocol behaviour requires updating [protocols/source-map.md](./protocols/source-map.md) in the same change; CI has a gate for it.

## License

MIT, copyright StringKe, 2026. Commercial use, closed-source use and redistribution are all permitted; the only obligation is to keep the copyright and license notice. Full terms are in `LICENSE` at the repository root.
