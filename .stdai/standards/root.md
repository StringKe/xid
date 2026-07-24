# XID Identity Platform

XID is a multi-tenant identity platform running entirely on Cloudflare's stack. MIT licensed (Copyright 2026 StringKe). Self-hosting gets the complete feature set: there is no feature tiering and no license-key check. Scope-wise it is Clerk (DX) + Auth0/Zitadel (OIDC/OAuth IdP + organization model) + WorkOS (enterprise SSO federation + directory sync) combined. A single codebase serves both single-tenant and multi-tenant deployments; the difference is configuration, never stripped-out code.

## Design source of truth

The product design source of truth is `docs/design/` (chapter index in `docs/design/README.md`). Change the design there first, then the implementation. Individual rules cite specific chapters (00 overview / 01 authentication / 02 tenancy-rbac / 03 oidc-oauth / 04 enterprise-sso / 05 users-sessions / 06 developer-experience / 07 platform-operations / 08 data-model).

Design intent is not the same as shipped support level. Protocol support and gaps live in `docs/protocols/` (`source-map.md`, `gap-audit.md`); SDK maturity per platform lives in `docs/sdks/platform-matrix.md`. Never report local L0-L3 evidence as production-supported.

## Application boundary

**The logical core is one Worker (`apps/server`)**: the protocol surface (Hono -- OIDC/OAuth, JWKS, SCIM, SAML, legacy enterprise SSO, Management API) plus the human-facing frontend (React SPA -- sign-in, consent, account, org and platform console, landing, public docs) plus the admin logic, all in one codebase and one Worker. `@cloudflare/vite-plugin` builds it as a single project: the Worker handles requests first, the SPA renders client-side, and non-API paths fall back to static assets.

The hosted sign-in and consent pages are not an optional app -- they are the foundation of the OIDC protocol surface. An RP redirects the user to `/authorize` while that user is not yet authenticated, so the IdP MUST render sign-in and consent itself.

`@xid-kit/*` packages split into kernel libraries used inside the server Worker and embeddable SDKs shipped to customers. Full directory tree, the kernel-vs-SDK package split, package roles, and the authoritative applyTo globs: reference `xid-repo-layout`. Consult it before placing a new file or writing a rule's applyTo entry.

## Tech stack

TypeScript on Cloudflare Workers. Hono serves the protocol surface and Management API; a React 19 SPA serves the human-facing frontend; Drizzle ORM over D1 holds relational data; Durable Objects hold anything needing strong consistency; KV caches, R2 stores objects, Queues carry async work. lingui does i18n, valibot guards every untrusted boundary, Web Crypto provides the primitives.

Full per-layer stack inventory -- exact runtime, binding names, Durable Object and queue names, cron schedules, pinned libraries, and the rejected alternatives such as workers-rs: reference `xid-tech-stack`. Consult it before choosing a library or naming a binding.

## Global iron rules

Summaries below are binding. Each rule's long form, with implementation paths, table names, and rationale, is in reference `xid-iron-rules-detail` -- read it before working in the area a rule governs.

1. **TenantContext is the single source**: issuer, signing keys, RPID, and policy MUST come from TenantContext. The kernel MUST NOT reference any module-level singleton holding an issuer, key, or tenant config.
2. **Tenant isolation is enforced by injection (P0)**: D1 has no RLS. Every query MUST go through the Drizzle tenant query layer, which injects `WHERE tenant_id = ?` (plus `org_id` where applicable). Raw SQL bypasses are forbidden, admin paths MUST NOT reuse business APIs, and cross-tenant authorization tests are mandatory.
3. **Crypto boundary**: never implement cryptographic primitives yourself -- Web Crypto, plus `@noble/hashes` for Argon2id. Protocol and business logic are in-house; SAML XML-DSig and canonicalization use mature libraries.
4. **Signing key isolation**: the default issuer signs with a per-instance ES256 key, envelope-encrypted with the KEK in Workers Secrets. Plaintext private keys are NEVER persisted. `tenant_signing_keys` is deprecated and MUST NOT be the default signing source.
5. **Zero protocol shortcuts**: PKCE is S256-only, `redirect_uri` matches exactly with no wildcards, refresh tokens rotate with family revocation, `state`/`nonce` guard CSRF, authorization codes are single-use, `jti` blocks replay, and the four WebAuthn checks have no bypass path.
6. **All i18n goes through lingui**: the SPA, the React SDK, and Workers API error messages MUST NOT hardcode user-visible strings. Transactional email templates are the documented exception.
7. **Enumeration resistance**: every authentication endpoint returns a uniform ambiguous response, never distinguishing "user does not exist" from "wrong password", with timing normalized by constant-time comparison plus jitter.
8. **Platform administration is ManagerAssignment, not a parallel system**: the console is one unified org management UI driven by `manager_assignments`. **Do not build a separate admin tenant, admin app, admin API, or admin RBAC.**

## Maintaining the AI configuration

AI rules are managed by stdagent. The sources live in `.stdai/standards/`; the generated outputs (`CLAUDE.md`, `AGENTS.md`, `.claude/`, `.agents/`) are produced mechanically by `stdagent sync`, **MUST NOT be edited by hand**, and MUST be committed.

How to add, change, and sync a rule, which target produces which output path, and why generated output is committed: reference `stdagent-config-workflow`. Read it before editing anything under `.stdai/standards/`.
