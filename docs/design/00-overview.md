# 00 - Overview and Cross-Cutting Design

> Chinese version: [`docs/zh-Hans/design/00-overview.md`](../zh-Hans/design/00-overview.md)

## 1. Product positioning

XID is a multi-tenant identity platform running on the full Cloudflare stack. It sits between the
simplicity of pocket-id and the capability surface of Keycloak/Hydra, and targets the combined
feature set of Clerk / Auth0 / WorkOS / Zitadel:

- Clerk's developer experience (embeddable UI components plus SDKs)
- Auth0's and Zitadel's complete OIDC/OAuth2 IdP and organization model
- WorkOS's enterprise SSO federation plus Directory Sync

In one sentence: edge-native modern identity infrastructure, MIT licensed, deployable to your own
Cloudflare account.

Scope principle: the target capability set is benchmarked against commercial products, but the
support level published externally is governed by the `docs/protocols/**` matrices. A capability
lacking real provider/IdP/SaaS L4 evidence MUST NOT be described as complete.

### 1.1 Current external capability tiers

| Capability tier                        | Current status                       | L4 boundary                                                                                                                         |
| -------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| OIDC/OAuth IdP                         | implemented                          | Production issuer, real client, and real resource server L4 are required before writing production-supported                        |
| Organization model + RBAC              | implemented                          | Production organization, membership, role, and permission paths are still validated through the readiness gate                      |
| Inbound enterprise SAML/OIDC           | provider-ready                       | Missing real Microsoft Entra ID, Okta, Google Workspace, OneLogin, JumpCloud, PingOne, PingFederate, AD FS, Shibboleth, Keycloak L4 |
| Inbound SCIM Service Provider          | implemented                          | Missing real external IdP provisioning into XID L4                                                                                  |
| Downstream SaaS SAML/OIDC              | local-mock verified / provider-ready | Missing real Slack, GitHub Enterprise Cloud, Microsoft custom app, Atlassian, Salesforce, Zoom admin L4                             |
| Outbound SCIM target clients           | local-mock verified                  | Missing real SaaS SCIM target admin L4                                                                                              |
| Social OAuth RP                        | provider-ready                       | Missing real GitHub, Google, Microsoft account, Apple callback L4                                                                   |
| Web/Core, Backend, React, Next.js SDKs | implemented                          | External app installation, cross-origin, visual E2E, and provider E2E are verified separately later                                 |
| React Native SDK                       | implemented                          | Local unit tests and typecheck cover it; real React Native runtime, IdP, and callback L4 are unverified                             |
| Flutter, iOS, Android, macOS SDKs      | implemented                          | Each platform has a native package and local unit tests; device or simulator, real IdP, and callback L4 are unverified              |

## 2. Licensing and delivery model

### 2.1 License: MIT

The chosen license is the **MIT License**, copyright StringKe, 2026. MIT is OSI-approved, so XID is
open source in the full sense of the term and can legitimately describe itself that way.

MIT grants the right to:

- Use, copy, modify, merge, publish, distribute, sublicense, and sell copies of the software
- Use it commercially without restriction, including distributing closed-source derivative works
- Offer it as a hosted service

The only obligation is to retain the copyright notice and license text in all copies or substantial
portions of the software.

There is no feature tiering, no license key check, and no commercial carve-out. No part of the
repository is gated behind payment.

### 2.2 Delivery model

- Self-hosting: take the entire codebase (including the multi-tenant capabilities) and deploy it to
  your own Cloudflare account
- Single-tenant and multi-tenant are two runtime modes of the same codebase, driven by
  configuration; see section 5

There is no "community edition versus enterprise edition" split. Self-hosting gives you everything.

## 3. Technology stack

workers-rs was dropped in favor of **TypeScript**. The reasoning: an identity product is dominated by
protocol correctness and I/O, not compute; signing runs through Web Crypto (native code), so Rust
offers no performance advantage while forcing you into WASM cryptography problems (getrandom #812,
bundle size); and the protocol libraries and reference implementations all live in the TypeScript
ecosystem.

```
Language     TypeScript
Monorepo     pnpm workspace + turborepo (the only cross-package orchestrator) + Vite+ (vp: Oxlint/Oxfmt/Vitest/tsgo/library bundling) + standard Vite (app builds)
Runtime      Cloudflare Workers
Backend      Hono (protocol endpoints + Management API)
Public site  Astro 7 + @cloudflare/nimbus-docs 0.8.2, static SSR, Pagefind, sitemap, OG, Markdown twins and LLM outputs
Hosted UI    React 19 SPA in the Core deployment: sign-in, consent and account
Console      React 19 SPA in a static-assets-only Worker: one org/instance console product on apex and tenant-host `/console`
Edge routing More-specific Worker Routes select Site and Console paths; Core remains the Custom Domain and tenant wildcard fallback
i18n         Full lingui stack (@lingui/core + @lingui/react + @lingui/cli + macros, ICU, po format)
Cryptography Web Crypto (crypto.subtle)
ORM/DB       Drizzle ORM + D1 (relational data)
Strong consistency  11 Durable Objects (WebAuthn and TOTP replay / OAuth, PAR, device and CIBA state / session revocation / rate limiting / audit sequence / metering / guest dedupe / impersonation grants)
Cache        KV (JWKS / discovery / branding / feature flags / upstream keys and trust anchors)
Objects      R2 (organization logos / email locale packs / private privacy exports / immutable compliance evidence)
Async        8 business Queues (email / SMS / WhatsApp / audit / webhook / metering / outbound SCIM / privacy) plus source-specific DLQ and quarantine Queues
Scheduled    Cron Triggers (hourly cleanup; daily signing key, custom hostname, domain, SAML, usage, privacy and guest maintenance)
Secrets      Workers Secrets (KEK / pepper / provider credentials) + envelope encryption stored in D1
Human check  Turnstile
Edge         WAF + Rate Limiting
Analytics    Analytics Engine (live metrics: sign-in success rate / MFA adoption / active users)
SAML XML     xmldsigjs + @xmldom/xmldom (nodejs_compat >= 2025-04-08)
```

### 3.1 Application boundary

One product and one logical Core do not require one frontend deployment. XID has three runtime
boundaries:

| Runtime     | Package            | Responsibility                                                                                                                                            |
| ----------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nimbus Site | `@xid-kit/site`    | Canonical apex documentation hub, 8-locale public documentation, SEO, Pagefind, OG, sitemap, Markdown twins, LLM outputs, and the `www` 308 redirect      |
| Console     | `@xid-kit/console` | One org and instance management SPA. It is a static Worker with only an `ASSETS` binding and owns `/console` on both apex and tenant hosts                |
| Core        | `@xid-kit/server`  | Hono protocol and Management API surface, Hosted Auth, account self-service, admin logic, Durable Objects, queues, crons, secrets, and every data binding |

The Core Worker remains the only logical identity core. The Site and Console Workers cannot access
D1, KV, R2, Durable Objects, Queues, or Core secrets. The Console calls the same-host Core API, and
platform and org management continue to share one RBAC model and one Console product.

Cloudflare selects these runtimes through explicit, more-specific Worker Routes. Site owns only its
enumerated public and locale paths, Console owns only `/console` and `/console/*`, and the Core
Custom Domain plus tenant wildcard remain the fallback. No front proxy Worker is introduced, and
neither Site nor Console may claim a broad apex catch-all.

Worker Route matching includes the query string, so an exact frontend route can fall through to the
Core Custom Domain when a query is present. Core resolves the same ownership contract and delegates
only those requests through one-way `SITE_WORKER` or `CONSOLE_WORKER` Service Bindings. The original
Request is preserved, frontend Workers do not bind back to Core, and unknown or overmatched paths
remain in Core.

The private `@xid-kit/web-ui` package contains the UI primitives, theme, locale, session, API client,
query helpers, and router adapter shared by Hosted UI and Console. The protocol, WebAuthn, crypto,
SAML, database, and i18n kernel packages remain internal to Core. The browser, backend, React, and
Next.js packages remain optional SDKs for customer applications.

`@xid-kit/*` splits into two groups. `protocol/webauthn/crypto/saml/db/i18n` are **kernel libraries**
used inside the Core Worker. `core/backend/react/nextjs` are **SDKs for embedded customer
integration** (optional). The hosted sign-in and consent pages are part of the OIDC protocol
foundation, not an optional app.

## 4. Build-vs-buy boundary

Principle: **use the platform for cryptographic primitives, build the protocol and business logic
in-house, and use a mature library for legacy XML signature formats.**

| Category                                                                                                                                                                  | Approach                                      | Rationale                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Cryptographic primitives (ECDSA/RSA/AES/SHA/HKDF/randomness)                                                                                                              | Never build in-house; use Web Crypto          | Rolling your own cryptography is a cardinal security mistake                                                     |
| OIDC/OAuth2 kernel, JWT issuance and verification, PKCE, refresh rotation, WebAuthn verification orchestration, social login, multi-tenant isolation, envelope encryption | Built entirely in-house                       | Core product surface; must be fully auditable, free of supply-chain risk, and license-clean                      |
| base64url / CBOR / COSE parsing                                                                                                                                           | In-house or a minimal dependency-free library | Format encoding and decoding, not security-sensitive                                                             |
| SAML XML-DSig / canonicalization                                                                                                                                          | Mature library (xmldsigjs + @xmldom/xmldom)   | Hand-rolled XML signature code is extremely prone to security holes; see the technical constraints in chapter 04 |

## 5. Core architecture: multi-tenancy and TenantContext

### 5.1 One repository, one codebase for single and multi-tenant

All code shares one license, so there is no need for the projection, stripping, or closed-source
layers that open-core models require. One monorepo, one codebase; single-tenant and multi-tenant are
two runtime modes of that same code, selected by configuration rather than by removing code.

The core abstraction is **TenantContext**: the issuer, signing keys, RPID, and configuration all come
from it. The kernel MUST NOT reference a global singleton issuer, key, or configuration directly;
everything goes through TenantContext.

- Single-tenant mode: TenantContext is a configuration-driven singleton (the self-hosting default,
  zero configuration)
- Multi-tenant mode: TenantContext is resolved dynamically from D1 by the Host header (used by
  xid.dev)

This is the technical pivot that makes "one codebase, two deployment models" work.

### 5.2 Hierarchy model (aligned with Zitadel)

```
Instance (platform operations layer)
  -> Organization (tenant/customer layer, the unit of data isolation, may override instance-level policy)
       -> Project (role namespace, roles shared across apps)
            -> Application (OIDC/SAML client)
       -> Project Grant (cross-organization authorization for B2B partnerships)
```

An Organization supports one level of sub-organization (Team/SubOrg); deeper nesting is not
supported. Users are platform-level entities associated with organizations through membership, and
cross-organization membership is supported. See chapter 02 for details.

### 5.3 Data isolation

D1 has no row-level security, so isolation is enforced at the application layer. A tenant-scoped
query layer wraps Drizzle ORM and injects `WHERE tenant_id = ?` (or `org_id`) into every query; raw
SQL that bypasses this layer is forbidden. This is a P0 control point and is covered by dedicated
cross-tenant access tests that assert one tenant cannot reach another tenant's resources. The
management API runs on a separate path and does not reuse the business API.

## 6. Domain model

### 6.1 Authentication root domain: xid.dev

The `xid.dev` apex domain is the unified instance-level entry point for humans and the entry point
for the platform console. Nimbus Site owns the canonical documentation hub and public documentation, while
the Core Worker owns Hosted Auth, account, protocol and API paths, and the Console Worker owns
`/console`. This path routing does not change the issuer or create an additional identity core. The
apex is not a fixed alias for an `admin` tenant or an `app` tenant. Every user can reach the unified
Hosted UI at `https://xid.dev/sign-in`, which first collects an
identifier, `login_hint`, OIDC authorize context, or an existing session, and then lets the instance
login resolver determine the final authentication context. The initial superadmin is not required to
know about `admin.xid.dev`, business users are not required to know about `app.xid.dev`, and the
platform still does not build a separate admin SPA, admin API, or admin RBAC system.

`https://www.xid.dev/{path}?{query}` always returns 308 to
`https://xid.dev/{path}?{query}` with the path and query preserved. `www` is a reserved tenant slug
and never enters TenantContext resolution.

The instance login resolver selects the target org/tenant under the apex domain:

- Known user: look up the unique user's org/tenant by email, username, phone, or external_id
- `login_hint` and email domain: assist home realm discovery, enterprise SSO, allowed-domain
  matching, and default org selection
- Initial superadmin: the `adminEmail` passed explicitly at bootstrap resolves to the default
  organization and retains `instance_manager` (that address belongs to the deployer and is not
  hard-coded in the repository)
- Business user: resolves to the org/tenant the user belongs to
- New user: when no existing user is found, the default organization's user creation policy decides
  whether creation is allowed
- Multiple matches: MUST enter a disambiguation flow or reject explicitly; picking an org/tenant at
  random is forbidden

Protocol boundaries for requests under the apex domain:

- An OAuth/OIDC request has a stable protocol owner: the active Application selected by the
  validated `client_id`. Its top-level Tenant is resolved before the browser cookie and remains the
  data, policy, and signing context for the complete authorize, token, userinfo, logout, PAR, device,
  and CIBA transaction. A cookie from another top-level Tenant is treated as unauthenticated. The
  current implementation does not authorize users across top-level Tenants; ProjectGrant only spans
  Organizations inside one top-level Tenant.
- Hosted UI origin is `https://xid.dev`. Transactional email magic link, OTP, reset, and verify links
  point back to the apex domain by default, and the resolver reconstructs the authentication context
  from there.
- The token issuer, discovery document, JWKS, and signing keys come from the instance issuer context.
  Hosted production defaults to `iss = https://xid.dev`, which does not change with the admin org,
  the default business org, or any other business org.
- Org/tenant context only determines policy, user membership, branding, RBAC, data isolation, and
  default org selection. It MUST NOT change the OIDC issuer.
- `instance_manager` is a platform-layer ManagerAssignment and is never written into business token
  claims.
- The WebAuthn RPID MUST be pinned by explicit policy. A business tenant's passkeys MUST NOT leak to
  another tenant. Apex-domain passkeys are only allowed for instance-level management scenarios that
  are explicitly bound to the root origin.

Business tenants get a first-level subdomain `{tenant}.xid.dev`:

- The first-level wildcard `*.xid.dev` is covered by free Universal SSL, so no ACM is needed
- RPID is `{tenant}.xid.dev`, unique per tenant, which isolates passkeys per tenant naturally
- The same static Console Worker owns `/console` and `/console/*` on both the apex and each tenant
  host. It keeps document navigation and Core API calls on the original host so host-only session
  cookies continue to work
- By default this is not an OIDC issuer. A subdomain can serve as an org-scoped UI, branding surface,
  or future custom issuer entry point, but the hosted default issuer for xid.dev remains the instance
  domain `https://xid.dev`

Default bootstrap creates only the default organization; it is not an "admin org plus app org" dual
default model. `default.xid.dev` can serve as the default organization's org-scoped UI, branding
surface, or RPID entry point, but it is not an independent issuer. `admin.xid.dev` and `app.xid.dev`
are not production routes, ordinary entry points, compatibility redirects, or default product
semantics. The apex-domain entry point MUST NOT be hard-coded to `admin`, `app`, or `default`; it
MUST go through the instance login resolver.

The instance, root Organization and quota, signing key, initial manager User and Email, owner
Membership, and `instance_manager` assignment MUST be created by one D1 batch transaction. A failed
statement leaves no bootstrap resource rows and keeps the complete request retryable.

Note: under multi-tenancy the RPID MUST be the specific tenant subdomain and MUST NOT be set to the
parent domain. Otherwise a user of tenant A would see their own passkeys on tenant B's sign-in page,
which breaks both isolation and privacy.

`.dev` is a Google TLD with enforced HTTPS (HSTS preload), so local development needs HTTPS as well.

### 6.2 Custom domains (enterprise feature)

Tenants can white-label to `auth.customer.com` through Cloudflare for SaaS Custom Hostnames. The
implemented state machine is:

```
POST /v1/organizations/:orgId/custom-hostnames
  -> Normalize the external hostname and reserve it globally in D1 before the provider call
  -> Cloudflare API POST /custom_hostnames (ssl.method=txt, type=dv)
  -> Bind ownership_verification to the initiating tenant with a 24-hour expiry
  -> Show the tenant up to three DNS record groups:
     1. Ownership TXT:  _cf-custom-hostname.auth.customer.com TXT <token>
     2. DCV delegation CNAME, once Cloudflare returns it asynchronously
     3. Traffic CNAME: auth.customer.com CNAME <configured-friendly-target-or-active-fallback-origin>
  -> Daily maintenance polls Cloudflare and refreshes hostname, SSL and DCV state
  -> status becomes active only when hostname status=active AND ssl.status=active
  -> Core Worker route */* intercepts, and TenantContext reverse-resolves the active Host
```

- Ownership verification and certificate DCV are separate provider states. A successful ownership
  check does not make the hostname routable until SSL is active.
- Cloudflare can return DCV records after the create response. The Console exposes refresh and the
  daily job eventually surfaces those records; an empty initial DCV list is not treated as success.
- An unverified ownership reservation expires after 24 hours. Cleanup calls the remote delete first
  and releases the local reservation only after that succeeds.
- Explicit deletion also calls the remote delete first. The local deleted tombstone remains globally
  unique so stale customer DNS cannot be claimed by another tenant; the same organization can
  re-provision it.
- Wildcard custom hostnames are rejected. This implementation accepts one concrete external
  hostname at a time.
- Local API, isolation, resolver and cron evidence exists. A real Cloudflare for SaaS account,
  customer DNS, certificate issuance and traffic cutover have not been exercised in production and
  remain `UNKNOWN`.

### 6.3 WebAuthn RPID under custom domains

`auth.customer.com` is a separate eTLD+1, so the RPID switches to that domain. Passkeys already
registered under `{tenant}.xid.dev` will not work on the new domain, so enabling a custom domain MUST
explicitly prompt users to re-register their passkeys (the same approach Auth0 and Clerk take).
The Console shows this warning before creation and on every hostname that carries the migration
flag. The OIDC issuer remains the instance issuer; only `hostedAuthOrigin` and `rpId` move to the
active custom hostname. Related Origin Requests (ROR) is not implemented.

## 7. Security trust model

An identity product resells trust, so tenant security reviews follow a predictable order: key
isolation -> data isolation -> compliance certifications -> protocol correctness -> availability.

### 7.1 Signing key isolation (highest priority)

The hosted default issuer uses a dedicated instance key, aligned with ZITADEL's instance issuer
model. Cloudflare has no HSM or KMS, so software envelope encryption is used: an account-level master
key (KEK, AES-256-GCM) lives in Workers Secrets and wraps the instance signing private key. The
wrapped ciphertext is persisted per instance alongside its kid. At runtime the ciphertext is
decrypted with the KEK and loaded into memory as a non-extractable key to perform signing, so the
plaintext private key exists only briefly inside the isolate. The tenant signing key is used only for
early per-org issuer data migration and for an explicit future custom issuer; it MUST NOT act as the
default signing source for `xid.dev`.

- The algorithm is ES256 (smaller keys, faster signing, smaller JWKS payloads than RS256), while
  RS256 remains supported externally for older clients
- Each instance keeps multiple kids in parallel. JWKS publishes every unexpired public key, and
  rotation is a four-step process: publish the new public key -> wait out the cache TTL -> switch
  signing to the new kid -> delete the old public key once old tokens have expired
- If advanced compliance (FIPS 140-2 L3) becomes a requirement, an external KMS can be integrated
  over mTLS; the architecture reserves the substitution point

### 7.2 Protocol-layer security (RFC 9700 / OWASP ASVS 10)

Exact redirect_uri matching, mandatory PKCE S256, state/nonce CSRF defense, single-use authorization
codes, hashed client secrets, refresh token rotation with family revocation, and jti replay
protection. See chapter 03.

### 7.3 The four WebAuthn verifications (no bypass path)

challenge, origin, rpIdHash, and signature, plus mandatory user verification and sign_count clone
detection. See chapter 01.

### 7.4 Three layers of abuse prevention

Rate Limiting (network) + Turnstile (forms) + Durable Objects (business logic). Account enumeration
defense: uniform error messages plus constant-time responses. See chapters 01 and 07.

The versioned expected edge policy is
`docs/deployment/cloudflare-security-rules.v1.json`. The hosted `xid.dev` zone uses the Cloudflare
Free WAF plan, so the baseline deliberately fits its limits: no more than five custom rules, one
rate-limiting rule, and only Free-plan fields and actions. The manifest remains `EXTERNAL` until a
read-only zone reconciliation proves that live phase entry points match it. Edge limiting is a
coarse shield only; `RateLimitStore` remains the fail-closed, strongly consistent authority for
identity-flow and per-tenant business limits.

### 7.5 Compliance roadmap

SOC 2 Type II (P0, the price of entry for B2B) -> GDPR DPA (P0) -> ISO 27001 (P1) -> OpenID Certified
(P1). Cloudflare's own compliance posture (SOC 2 / ISO 27001 / PCI DSS) can be cited as
sub-service-organization evidence, but application-layer controls remain our responsibility.

## 8. Cloudflare service mapping

| Service                         | Purpose                                                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core Worker + Hono              | Protocol, Hosted Auth, account, Management API, bindings, queues, crons, and identity business logic                                                                   |
| Nimbus Site Worker              | Canonical apex documentation hub, 8-locale public docs, SEO, Pagefind, Markdown and LLM outputs, and `www` 308                                                         |
| Console Worker                  | Static org and instance management SPA on apex and tenant-host `/console`, with no Core bindings                                                                       |
| Worker Routes                   | More-specific Site and Console path ownership over the Core Custom Domain and tenant wildcard fallback, with no front proxy                                            |
| D1                              | Users, applications, groups, credential metadata, authorization codes, refresh tokens, audit, tenants, key ciphertext, sessions                                        |
| Durable Objects                 | 11 bindings for WebAuthn/TOTP replay, OAuth/PAR/device/CIBA state, session revocation, rate limiting, audit sequence, metering, guest dedupe, and impersonation grants |
| KV                              | JWKS, discovery, branding, feature flags, upstream provider keys, and trust anchors                                                                                    |
| R2                              | Organization logos, email locale packs, private privacy exports, and immutable compliance evidence                                                                     |
| Queues                          | 8 business Queues for email, SMS, WhatsApp, audit, webhook, metering, outbound SCIM, and privacy, plus per-source DLQ and quarantine Queues                            |
| Cron Triggers                   | Hourly cleanup plus daily signing key, custom hostname, domain, SAML, usage, privacy, and guest maintenance                                                            |
| Workers Secrets                 | KEK master key, provider credentials                                                                                                                                   |
| Turnstile / WAF / Rate Limiting | Abuse prevention                                                                                                                                                       |
| Analytics Engine                | Live metrics (sign-in success rate, MFA adoption, active users)                                                                                                        |

## 9. Key technical risks and verification items

| Level | Risk                                                                      | Mitigation                                                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1    | SAML round-trip verification against a real IdP                           | Spike complete: the xmldsigjs + @xmldom/xmldom processing layer shipped in `packages/saml` and all SSO endpoints pass; round-trip signature verification against real Okta/Azure/Google IdPs is still pending L4. See chapter 04 |
| P0    | D1 has no RLS, so a missing tenant_id injection means cross-tenant access | Mandatory query-layer wrapping plus cross-tenant access tests                                                                                                                                                                    |
| P1    | Correctness of the in-house OIDC/WebAuthn protocol code                   | Verify against the specifications and pursue OpenID Certified                                                                                                                                                                    |
| P1    | Cloudflare for SaaS custom domain squatting or takeover                   | Bind ownership to the tenant with expiry; delete remotely first; keep an explicit-delete hostname tombstone so stale DNS cannot move to another tenant                                                                           |
| P1    | Exact MAU deduplication (billing)                                         | MeteringDO sharded per tenant, with exact deduplication on DO storage keys `member:month:{ym}:{userId}`; HyperLogLog is not used because 0.8% error is unacceptable                                                              |
| P2    | WASM/bundle size and cold start                                           | This risk dropped sharply after moving to TypeScript; keep monitoring bundle size                                                                                                                                                |
| P2    | Security incidents caused by self-hoster misconfiguration                 | Secure defaults plus a deployment guide that explicitly lists the secrets and domain boundaries that must be set                                                                                                                 |

## 10. Decision summary

| #   | Decision                 | Conclusion                                                                                          |
| --- | ------------------------ | --------------------------------------------------------------------------------------------------- |
| 1   | Language                 | TypeScript (workers-rs dropped)                                                                     |
| 2   | Delivery model           | The entire codebase is open source and self-hostable; single and multi-tenant share one codebase    |
| 3   | License                  | MIT (OSI-approved open source, no usage restrictions)                                               |
| 4   | Single/multi-tenant code | One codebase, driven by TenantContext configuration, with no code stripping                         |
| 5   | Authentication           | Full multi-factor plus social plus enterprise SSO (SAML/OIDC)                                       |
| 6   | Tenant addressing        | `{tenant}.xid.dev` subdomains plus custom domains                                                   |
| 7   | Passkey isolation        | Per-tenant RPID; subdomains isolate naturally                                                       |
| 8   | Signing keys             | Instance ES256 by default plus envelope encryption (KEK in Workers Secrets)                         |
| 9   | Build-vs-buy boundary    | Platform cryptography, in-house protocol and business logic, library-based SAML XML                 |
| 10  | Usage metering           | Exact DAU/MAU deduplication, so self-hosters can wire up their own billing or quotas                |
| 11  | Hierarchy model          | Instance -> Org -> Project -> App, with one level of sub-org                                        |
| 12  | Scope                    | Full target capability coverage; support level governed by the protocol matrices and L4 evidence    |
| 13  | Frontend architecture    | Nimbus Site plus a separate static Console Worker; Core retains the React Hosted UI and account SPA |
