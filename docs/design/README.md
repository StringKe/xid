# XID Identity Platform - Product Design

> Chinese version: [`docs/zh-Hans/design/README.md`](../zh-Hans/design/README.md)

XID is a multi-tenant identity platform running entirely on Cloudflare, benchmarked against
Clerk / Auth0 / WorkOS / Zitadel. MIT licensed, and self-hosting gives you the complete feature set.

This directory answers one question: **why** each XID subsystem is designed the way it is, and what
the tradeoffs were. The audience is contributors who need to change XID's internal behavior, and
evaluators who want to understand the design intent before deciding whether to adopt it. For "how
much of this is actually supported" see `docs/protocols/`; for "how do I use it" see `docs/sdks/`.

This directory is the product design source of truth. Change the design here first, then change the
implementation. Implementation status is tracked in `docs/protocols/source-map.md`,
`docs/protocols/gap-audit.md`, and `docs/sdks/platform-matrix.md`.

## Chapter index

| File                         | Contents                                                                                                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `00-overview.md`             | Product positioning, licensing and delivery model, technology stack, build-vs-buy boundary, core architecture (TenantContext), domain model, security trust model, Cloudflare service mapping, technical risks, decision summary |
| `01-authentication.md`       | Authentication methods and credentials: passkey/WebAuthn, passwords, social login, passwordless, MFA, account recovery, device trust, abuse prevention                                                                           |
| `02-tenancy-rbac.md`         | Multi-tenancy and the organization model, membership management, RBAC and permissions, B2B/B2C, per-organization configuration, data isolation                                                                                   |
| `03-oidc-oauth.md`           | The full OIDC/OAuth2 protocol surface XID exposes as an IdP: endpoints, grants, tokens, clients, advanced security, scope and consent, session and logout                                                                        |
| `04-enterprise-sso.md`       | Enterprise SSO federation (SAML/OIDC), JIT provisioning, domain routing, SCIM directory sync, SAML constraints on Workers                                                                                                        |
| `05-users-sessions.md`       | User data model, sign-up and sign-in orchestration, account linking, verification, user management, GDPR, session management                                                                                                     |
| `06-developer-experience.md` | Frontend and backend SDKs, React components and hooks, Hosted UI, Management API, webhooks and events                                                                                                                            |
| `07-platform-operations.md`  | Platform and tenant consoles, branding, notifications, i18n, audit, observability, billing, compliance                                                                                                                           |
| `08-data-model.md`           | D1 data model overview, table inventory, multi-tenant isolation constraints                                                                                                                                                      |

## Status

The Worker, the SPA, and the kernel packages all have substantial shipped code and test coverage.
The target scope is benchmarked against commercial products; the externally claimed support level is
governed by the `docs/protocols/**` matrices plus real L4 evidence. Local L0-L3 evidence MUST NOT be
written up as production-supported.

| Area                                               | Status                                                      |
| -------------------------------------------------- | ----------------------------------------------------------- |
| OIDC/OAuth IdP, Management API, Hosted UI, console | Implemented (local L1-L3)                                   |
| Enterprise SSO / SCIM                              | Provider-ready; real IdP/SaaS L4 evidence missing           |
| React Native SDK                                   | Implemented; real IdP L4 unverified                         |
| Flutter / iOS / Android / macOS SDKs               | Scaffolded or implemented; real IdP L4 verification pending |

## About the bilingual chapters

These English chapters under `docs/design/` are the source of truth. CI asserts on literal strings
inside `00-overview.md`, `01-authentication.md`, `03-oidc-oauth.md`, and `04-enterprise-sso.md` (see
`tests/protocols/source-map-coverage.test.mjs`), so those files stay at their canonical paths and
their boundary wording is load-bearing -- rephrasing it can fail the build.

`docs/zh-Hans/design/` mirrors these chapters one-to-one -- same chapter numbering, same section
numbering, same tables in the same order -- so a cross-reference such as "see chapter 03 section 9.1"
resolves identically in both languages. When you change a design, change the English chapter and the
Chinese mirror in the same commit.
