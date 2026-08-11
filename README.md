# XID

English | [简体中文](README.zh-Hans.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Português (BR)](README.pt-BR.md)

An edge-native identity platform deployed as three Cloudflare Workers from one codebase. The Core
Worker serves OIDC/OAuth, multi-tenant RBAC, enterprise SSO federation, Hosted Auth, and account
pages. A Nimbus Site Worker serves the complete localized documentation from the apex, while an
isolated Console Worker serves the management UI.

[![CI](https://img.shields.io/github/actions/workflow/status/StringKe/xid/ci.yml?branch=main&label=CI)](https://github.com/StringKe/xid/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-orange)](https://developers.cloudflare.com/workers/) [![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/StringKe/xid/badge)](https://securityscorecards.dev/viewer/?uri=github.com/StringKe/xid) [![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13783/badge)](https://www.bestpractices.dev/projects/13783)

<a href="https://www.producthunt.com/products/xid?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-xid" target="_blank" rel="noopener noreferrer"><img alt="XID - Edge-native identity platform on Cloudflare Workers | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1217874&amp;theme=light&amp;t=1786263008879"></a>

## Project status

**Pre-1.0. Do not run this in production yet.** Every capability below is backed by local evidence
only: unit tests, Workers-runtime integration tests, and browser or protocol-client smoke tests
against a local build. Nothing has been verified end-to-end against a real external identity
provider, a real downstream SaaS application, a real social OAuth provider, or real SMS/WhatsApp
delivery. Evidence tiers (L0 to L4) and per-feature support levels are defined in
[`docs/protocols/README.md`](docs/protocols/README.md), which is authoritative over any summary
here. Interfaces, database schema, and package APIs may change without a deprecation period.

## Why XID

Identity requests are latency-critical and globally distributed, yet most identity platforms answer
them from one region. XID puts the whole authorization server on Cloudflare's edge: token signing
runs on Web Crypto inside the isolate, session revocation is serialized by a per-user Durable
Object instead of a central database, and JWKS is cached in KV so relying parties verify tokens
without a round trip. Multi-tenancy is not an add-on either -- issuer, signing keys, WebAuthn RP ID,
and policy all resolve from a single `TenantContext`, so the same source tree runs as a zero-config
single-tenant deployment or a multi-tenant instance, by configuration rather than a build flag.

## Features

**Protocols and federation**

- OIDC and OAuth 2.x authorization server with discovery, JWKS, protected-resource metadata,
  `/authorize`, `/token`, `/userinfo`, `/introspect`, `/revoke`, `/end_session`, PAR, Device Flow,
  Dynamic Client Registration, CIBA, hybrid responses, and front-channel, back-channel, and
  session-management logout paths.
- Authorization code with mandatory PKCE S256, client credentials, rotating refresh tokens with
  family replay revocation, and RFC 8693 token exchange. Resource Indicators, DPoP, mTLS, JAR,
  JARM, RAR, and local Browser-Based Apps and FAPI 2.0 enforcement profiles are implemented.
- Enterprise SSO in both directions: inbound SAML 2.0 SP and OIDC RP federation, outbound SAML 2.0
  IdP and OIDC applications for downstream SaaS, plus LDAP direct bind, WS-Federation, SWA password
  vaulting, header-based SSO, and a directory connector framework.
- SCIM 2.0 Service Provider with Users, Groups, PATCH, filters, projection, sort, bulk, and
  ETag/If-Match, plus outbound Users/Groups provisioning to downstream SaaS targets.
- OpenID Federation is limited to a minimal entity-metadata and registration boundary. Trust-chain
  resolution, trust anchors, authority-hint traversal, and production interoperability are not
  implemented.

**Authentication and account lifecycle**

- Passkeys/WebAuthn as the primary credential with discoverable credentials, mandatory user
  verification, ES256/RS256/EdDSA verification, sign-count clone detection, and policy-driven
  packed enterprise attestation validation.
- Passwords use Argon2id plus a server-side pepper held in Workers Secrets. Passwordless sign-in
  supports magic links and one-time codes over email, SMS, and WhatsApp; social OAuth supports
  Google, GitHub, Microsoft account, and Apple through the relying-party flow.
- MFA supports TOTP, SMS, passkey challenges, single-use backup codes, and OIDC AAL2 step-up bound
  to the current session. AAL3 is explicitly not claimed.
- Guest sign-in provides Firebase-style lazy reuse and one-click in-place passkey upgrade with
  `sub` preserved. Browser clients also have hidden-iframe `prompt=none` silent re-authentication
  with a top-level redirect fallback.
- Invitation acceptance, email verification, top-level Tenant onboarding, active-Organization
  selection, session management, and self-service credential management are implemented in Hosted
  Auth and the account portal.

**Organizations and authorization**

- Instances, Organizations, one-level SubOrgs, memberships, Projects, Applications, roles,
  permissions, user and cross-Organization grants, invitations, and domain verification.
- OrgUnit trees model departments and teams inside an Organization with primary and secondary
  placements, a maximum depth of 8, subtree moves and archival, and manager resolution along the
  reporting line. OrgUnits never become tenant boundaries or token claims.
- Each Project can be `open`, `restricted`, or `approval_required`. Same-Organization authorization
  enforces that policy; users can request access, approvers resolve through the OrgUnit reporting
  line and management fallbacks, and approval can create an expiring `user_grant`.

**Operations and delivery**

- Management API under `/v1/*`, self-service account portal under `/v1/me/*`, and a separately
  guarded instance-operator API under `/v1/platform/*`.
- Append-only audit events use a per-tenant SHA-256 hash chain and redact sensitive metadata before
  persistence. Eight asynchronous pipelines have independent dead-letter and quarantine paths with
  lease-based replay, while metering failures fall back to a D1 outbox.
- Signed webhooks support encrypted secrets, rotation, retry, idempotent message IDs, and dead-letter
  snapshots. Self-service privacy flows provide private R2 exports and cancelable delayed erasure
  with sole-owner and last-instance-manager protections.
- Feature flags, branding, usage metering, announcements, compliance artifacts, and Hosted UI in 8
  locales (en, zh-Hans, ja, ko, fr, de, es, pt-BR) are managed from the same codebase.

## Quickstart

### Integrating an application

Eighteen `@xid-kit/*` TypeScript packages are configured as publishable and pass the clean local
tarball consumer gate (`pnpm run sdk:distribution:verify`). No checked-in release evidence proves
their current state in an external registry, so npm publication is `UNKNOWN`; use the workspace or
a locally produced tarball unless you independently verify the registry. The API below is the
current public surface. From `@xid-kit/react`:

```tsx
import { XidProvider, SignedIn, SignedOut, SignInButton, UserButton } from '@xid-kit/react'

function App() {
  return (
    <XidProvider
      mode="oidc"
      issuer="https://auth.example.com"
      clientId="client_abc123"
      redirectUri="https://app.example.com/auth/callback"
    >
      <SignedOut>
        <SignInButton />
      </SignedOut>
      <SignedIn>
        <UserButton />
      </SignedIn>
    </XidProvider>
  )
}
```

Inside the provider, `useUser()` returns a discriminated union on `isLoaded` and `isSignedIn`, and
`useAuth()` exposes `getToken` and `signOut`; organization, session, and API key hooks follow the
same shape. Server side, `verifyToken` from `@xid-kit/backend` is networkless -- pass the JWKS you
already hold and nothing leaves the isolate.

```ts
import { verifyToken } from '@xid-kit/backend'

const result = await verifyToken(accessToken, {
  jwtKey: jwks, // a JWK, a JWKS, or an imported CryptoKey
  issuer: 'https://auth.example.com',
  authorizedParties: ['app_123'],
})

if (!result.ok) {
  return new Response('unauthorized', { status: 401 }) // result.error names the failed check
}
const userId = result.value.sub
```

`authenticateRequest(request, options)` wraps the same check for a whole `Request`, and
`verifyWebhook(request, options)` validates inbound webhook signatures.

### Self-hosting

Requires Node >= 22.12 and pnpm 10.33.4. D1, KV, Queues, and SQLite-backed Durable Objects all have
Workers Free tiers, but sending mail to arbitrary recipients through the `send_email` binding
requires Workers Paid, so any deployment that actually delivers verification mail, magic links, or
one-time codes needs the paid plan.

Bootstrap enables **only** email magic link and email OTP by default. The Worker falls back to
`no-reply@xid.dev`. On a self-hosted deployment you must onboard **your** sending domain
(`npx wrangler email sending enable <your-domain>`, with DKIM/SPF/DMARC), then set the non-secret
Core Worker variables `EMAIL_FROM_ADDRESS=no-reply@<your-domain>` and `EMAIL_FROM_NAME=XID` before
anyone can receive a login message. No source edit is required. Details:
[`docs/deployment.md`](docs/deployment.md) section **Sending domain**.

```bash
git clone https://github.com/StringKe/xid.git
cd xid && pnpm install

# create the resources the Core Worker binds to
cd apps/server
npx wrangler d1 create xid-db
npx wrangler kv namespace create CACHE
npx wrangler r2 bucket create xid-storage
pnpm --dir ../.. run cloudflare:queues:create
```

The Queue script derives all 24 required resources from `apps/server/wrangler.jsonc`: 8 source
Queues, 8 per-source dead-letter Queues, and 8 persistence-failure quarantine Queues. It does not
create or delete the obsolete shared `xid-dlq`. Re-running it lists the account first, skips
matching resources, and creates only missing Queue names.

Then replace the upstream account and route values in `apps/server/wrangler.jsonc`,
`apps/console/wrangler.jsonc`, and `apps/site/wrangler.jsonc`. Set the canonical public origin in
`apps/site/astro.config.ts` to your HTTPS apex URL as well. The Core configuration also needs your
D1 `database_id` and KV namespace `id`. There is no self-hosting template to copy, and **the three
Workers will not deploy correctly while these upstream values remain**. The eleven Durable Object
bindings, the Analytics Engine dataset, the `send_email` binding, and the two cron triggers belong
only to Core and are already declared.

Set the secrets, verify locally, connect Workers Builds, and initialize after the three production
builds succeed. Losing `KEK` makes every signing key and stored provider credential undecryptable;
losing `PEPPER` invalidates every password hash. Back both up outside Cloudflare first.

```bash
openssl rand -base64 32 | npx wrangler secret put KEK
openssl rand -base64 32 | npx wrangler secret put PEPPER
npx wrangler secret put BOOTSTRAP_TOKEN   # strongly recommended before first bootstrap

cd ../..
pnpm check
pnpm test
pnpm run build
pnpm smoke:three-workers
```

Connect `xid`, `xid-console`, and `xid-site` as three Cloudflare Workers Builds projects backed by
this Git repository. Set their production branch to `main`, disable non-production branch builds and
Worker Preview URLs, and use the root, build, and deploy commands in
[`docs/deployment.md`](docs/deployment.md). Merge a reviewed, signed commit into `main`; Workers
Builds applies the remote D1 migrations and deploys all three Workers. After the builds succeed:

```bash
curl -X POST https://<your-domain>/admin/bootstrap \
  -H 'content-type: application/json' \
  -H 'X-Bootstrap-Token: <BOOTSTRAP_TOKEN>' \
  --data '{"primaryDomain":"<your-domain>","mode":"multi_tenant","adminEmail":"<you@example.com>"}'
```

Bootstrap creates the instance, the default organization, the instance ES256 signing key, and the
first `instance_manager` user; it refuses to run twice. Full instructions, including local D1
migration, seeding, three-Worker release ordering, and rollback are in
[`docs/deployment.md`](docs/deployment.md). A self-hosted release is incomplete unless Core,
Console, and Site are all deployed: Site owns the apex documentation hub, 8-locale docs, SEO, Pagefind,
agent surfaces, and the `www` 308 redirect; Console owns `/console` and `/console/*`.

### Developing

```bash
pnpm run dev                   # Core, Console, and Nimbus Site development servers
pnpm test                      # Vitest across the workspace
pnpm run check                 # typecheck, lint, i18n, protocol and coverage gates
pnpm run build                 # all packages and all three Workers
pnpm smoke:three-workers       # local route ownership and cross-Worker smoke test
```

`pnpm run check` is the full gate, including two coverage runs; it is not a quick lint. It calls
`native:verify`, which without `XID_NATIVE_SDK_PLATFORM` set only validates the native SDK contract
matrix and needs no native toolchain. GitHub Actions verifies but never deploys; production
deployment runs from Cloudflare Workers Builds on the repository owner's account. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the per-area workflow.

## Architecture

Three Workers share one hostname without sharing runtime bindings. Nimbus Site owns the apex
documentation hub, all 8 locale documentation trees, SEO, Pagefind, Markdown and MDX twins, LLM indexes, and
the `www` to apex 308 redirect. Console is a binding-free static Worker that owns `/console` and
`/console/*` on the apex and tenant hosts. Core owns Hosted Auth, account pages, protocol and API
routes, and `/_core/*`; it is the only Worker with D1, Durable Objects, KV, R2, Queues, email,
Analytics Engine, and cron bindings.

Core state is split by consistency requirement: D1 for relational data, Durable Objects for anything
needing serialization (WebAuthn challenges, OAuth state, PAR, device flow, session revocation, rate
limits, audit sequence, metering), KV for cached reads, R2 for blobs, and Queues for work that must
stay off the login path.

```
apps/site/         Nimbus docs Site: apex hub, localized docs, SEO, Pagefind, agent surfaces, www 308
apps/console/      Binding-free static management UI for /console and /console/*
apps/server/       Identity Core Worker
  worker/          Hono routes, Durable Objects, queue consumers, cron handlers
  src/             React SPA for Hosted Auth and account pages
packages/          23 workspace packages: 15 TypeScript SDKs + 3 public runtime kernels + 5 private implementation packages
sdk/               13 native SDKs
docs/              Design chapters, protocol matrices, SDK matrix, deployment guide
tests/             Cross-workspace gates: protocol source map, native SDK contract, smoke suites
```

The public runtime kernels are `protocol`, `crypto`, and `types`. The private implementation
packages are `webauthn`, `saml`, `db`, `i18n`, and `web-ui`. Cryptographic primitives always come
from Web Crypto and XML-DSig is delegated to `xmldsigjs`; the protocol and business logic in
between are written here.

## Protocol support

Every row maps to files and tests in [`docs/protocols/source-map.md`](docs/protocols/source-map.md).

| Area                                                                   | Support     | Highest evidence                | Notes                                                                      |
| ---------------------------------------------------------------------- | ----------- | ------------------------------- | -------------------------------------------------------------------------- |
| OAuth 2.x core (code, PKCE S256, client credentials, refresh rotation) | implemented | local protocol client           | Implicit and password grants are rejected with negative tests              |
| OIDC core (ID token, userinfo, logout, session management, hybrid)     | implemented | local protocol client           | Front-channel and back-channel logout profiles included                    |
| PAR, DPoP, Device Flow                                                 | implemented | local protocol client           | DPoP nonce challenge is not implemented                                    |
| Browser-Based Apps and FAPI 2.0 enforcement profiles                   | implemented | Workers runtime integration     | Local policy coverage only; no production conformance claim                |
| JAR, JARM, RAR, mTLS, token exchange, DCR, CIBA                        | implemented | Workers runtime integration     | JWE, remote request-object fetch, and `form_post.jwt` are not claimed      |
| OpenID Federation                                                      | implemented | Workers runtime integration     | Minimal metadata and registration boundary only; no trust-chain resolution |
| SAML 2.0 SP (inbound) and IdP (outbound)                               | implemented | local fake IdP and fake SaaS SP | Not verified against Okta, Entra ID, or Google Workspace                   |
| SCIM 2.0 Service Provider and outbound provisioning                    | implemented | local fake SaaS SCIM            | Not verified against a real directory or SaaS target                       |
| WebAuthn, passkeys, passkey MFA, and AAL2 step-up                      | implemented | Workers runtime integration     | Includes EdDSA and packed attestation locally; AAL3 is not supported       |
| LDAP direct bind, WS-Federation, SWA, header-based SSO                 | implemented | local harness                   | Kerberos is documentation only                                             |
| Social OAuth relying party (Google, GitHub, Microsoft, Apple)          | implemented | local fake provider             | Not verified with real provider secrets or callbacks                       |
| Shared Signals, CAEP, RISC                                             | planned     | negative route tests            | Endpoints return 501 and create no streams                                 |
| GNAP, UMA, HEART, OID4VP, OID4VCI                                      | planned     | negative route tests            | Reserved routes return 501; they are not protocol implementations          |

## SDKs

Fifteen TypeScript SDK packages live under `packages/`: `core` and `backend` plus framework
bindings for React, Next.js, Remix, Astro, Vue, Nuxt, Svelte, Solid, Angular, React Native, Expo,
Electron, and Tauri. Together with the 3 public runtime kernels (`crypto`, `protocol`, and `types`),
18 packages are configured as publishable and pass clean local tarball installation tests. The
remaining 5 packages (`db`, `i18n`, `saml`, `web-ui`, and `webauthn`) are private implementation
packages. External npm registry publication remains `UNKNOWN`; local distribution evidence is not
a registry release claim.

Thirteen native SDKs under `sdk/`: Go, Rust, Python, Ruby, PHP, Java, .NET, Windows, iOS, macOS,
Linux, Android, and Flutter. **None are published to crates.io, PyPI, Maven Central, RubyGems,
Packagist, NuGet, CocoaPods, or pub.dev**, and no release pipeline exists for them -- they are
consumed from source. CI installs no language toolchain and runs none of their test suites. What it
does check is the contract matrix in `tests/native-sdk-contract.test.mjs`: `pnpm check` calls
`native:verify` inside the `check` job, and that asserts every platform entry in the matrix points
at a directory that exists. Executing a platform's real toolchain is a local opt-in step:
`XID_NATIVE_SDK_PLATFORM=go pnpm run native:verify`. Per-platform maturity is in
[`docs/sdks/platform-matrix.md`](docs/sdks/platform-matrix.md).

## Documentation

Start at [`docs/README.md`](docs/README.md), which routes by reader. Everything under `docs/` is
written in English, and English is authoritative. A Simplified Chinese mirror lives in
[`docs/zh-Hans/`](docs/zh-Hans/README.md), but it deliberately covers only the entry documents and
the design chapters -- the protocol matrices, the IdP runbooks, most SDK pages and the remaining
guides exist in English only, because a stale translation of a support matrix is worse than none.

- Product design, nine chapters: [`docs/design/`](docs/design/README.md)
- Protocol matrices and gap audit: [`docs/protocols/`](docs/protocols/README.md)
- HTTP endpoint contracts: [`docs/api-contracts.md`](docs/api-contracts.md)
- Self-hosting: [`docs/deployment.md`](docs/deployment.md)
- Standards source-of-truth URLs: [`docs/standards-sources.md`](docs/standards-sources.md)

## Contributing, security, and license

| Topic | Where |
| ----- | ----- |
| How to contribute (PR flow, DCO, testing policy, coding standards) | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| Bug reports, feature requests, questions | [`SUPPORT.md`](SUPPORT.md) · [Issues](https://github.com/StringKe/xid/issues) · [Discussions](https://github.com/StringKe/xid/discussions) |
| Vulnerability reports (private only) | [`SECURITY.md`](SECURITY.md) |
| Code of conduct | [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) |
| OpenSSF Best Practices (Passing) checklist and form answers | [`docs/openssf-best-practices.md`](docs/openssf-best-practices.md) |
| License | [`LICENSE`](LICENSE) (MIT) |

Do not open a public issue for a vulnerability. Reporting channels, scope, fix timelines, and the
cryptography summary are in [`SECURITY.md`](SECURITY.md).

XID is licensed under the MIT License; see [`LICENSE`](LICENSE). You may use, modify, and
distribute it, including commercially and in closed-source products, as long as you retain the
copyright notice and the license text.
