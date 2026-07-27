# XID

English | [简体中文](README.zh-Hans.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Português (BR)](README.pt-BR.md)

An edge-native identity platform deployed as three Cloudflare Workers from one codebase. The Core
Worker serves OIDC/OAuth, multi-tenant RBAC, enterprise SSO federation, Hosted Auth, and account
pages. A Nimbus Site Worker serves the complete localized documentation from the apex, while an
isolated Console Worker serves the management UI.

[![CI](https://img.shields.io/github/actions/workflow/status/StringKe/xid/ci.yml?branch=main&label=CI)](https://github.com/StringKe/xid/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-orange)](https://developers.cloudflare.com/workers/)

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

**Protocol surface**

- OIDC and OAuth 2.x authorization server: discovery, JWKS, `/authorize`, `/token`, `/userinfo`,
  `/introspect`, `/revoke`, `/end_session`, `/device_authorization`, `/par`, dynamic client
  registration (RFC 7591/7592), and CIBA backchannel authentication.
- Authorization code with mandatory PKCE S256, client credentials, device code, refresh rotation
  with family replay revocation, and RFC 8693 token exchange. Sender-constrained tokens via DPoP
  and mTLS; signed request objects (JAR) and signed authorization responses (JARM).
- Enterprise SSO in both directions: inbound SAML 2.0 SP and OIDC RP federation, outbound SAML 2.0
  IdP for downstream SaaS, plus LDAP direct bind, WS-Federation, SWA password vaulting, and
  header-based SSO.
- SCIM 2.0 Service Provider (Users, Groups, PATCH, filters, sort, bulk, ETag/If-Match) plus
  outbound provisioning to downstream SaaS targets.

**Authentication**

- Passkeys/WebAuthn as the primary credential: discoverable credentials, mandatory user
  verification, sign-count clone detection.
- Passwords hashed with Argon2id plus a server-side pepper held in Workers Secrets; magic links;
  one-time codes over email, SMS, and WhatsApp; social OAuth as a relying party.
- MFA with TOTP, SMS, passkey as second factor, and single-use backup codes.

**Platform**

- Organizations, memberships, roles, permissions, invitations, and domain verification.
- Management API under `/v1/*`, self-service account portal under `/v1/me/*`, instance operator API
  under `/v1/platform/*`.
- Append-only audit log with chained SHA-256 hashes, signed webhooks with a dead-letter queue,
  feature flags, and usage metering.
- Hosted UI in 8 locales (en, zh-Hans, ja, ko, fr, de, es, pt-BR) with fully translated catalogs.

## Quickstart

### Integrating an application

The `@xid-kit/*` packages are **not published to npm**; they are workspace packages, so using them
in your own application today means vendoring the source or adding this repository to your
workspace. The API below is the current public surface. From `@xid-kit/react`:

```tsx
import { XidProvider, SignedIn, SignedOut, SignInButton, UserButton } from '@xid-kit/react'

function App() {
  return (
    <XidProvider publishableKey="pk_test_..." apiUrl="https://auth.example.com">
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

Bootstrap enables **only** email magic link and email OTP by default. The Worker defaults the
sender to `no-reply@xid.dev`. On a self-hosted fork you must onboard **your** sending domain
(`npx wrangler email sending enable <your-domain>`, with DKIM/SPF/DMARC) and point the default
`from` at that domain (today by editing `DEFAULT_FROM` in `apps/server/worker/queues/email.ts`)
before anyone can receive a login message. Details: [`docs/deployment.md`](docs/deployment.md)
section **Sending domain**.

```bash
git clone https://github.com/StringKe/xid.git
cd xid && pnpm install

# create the resources the Core Worker binds to
cd apps/server
npx wrangler d1 create xid-db
npx wrangler kv namespace create CACHE
npx wrangler r2 bucket create xid-storage
for q in xid-email xid-whatsapp xid-sms xid-audit xid-webhook xid-metering xid-dlq; do
  npx wrangler queues create "$q"
done
```

Then replace the upstream account and route values in `apps/server/wrangler.jsonc`,
`apps/console/wrangler.jsonc`, and `apps/site/wrangler.jsonc`. Set the canonical public origin in
`apps/site/astro.config.ts` to your HTTPS apex URL as well. The Core configuration also needs your
D1 `database_id` and KV namespace `id`. There is no self-hosting template to copy, and **the three
Workers will not deploy correctly while these upstream values remain**. The eight Durable Object
bindings, the Analytics Engine dataset, the `send_email` binding, and the two cron triggers belong
only to Core and are already declared.

Set the secrets, migrate, deploy, and initialize. Losing `KEK` makes every signing key and stored
provider credential undecryptable; losing `PEPPER` invalidates every password hash. Back both up
outside Cloudflare first.

```bash
openssl rand -base64 32 | npx wrangler secret put KEK
openssl rand -base64 32 | npx wrangler secret put PEPPER
npx wrangler secret put BOOTSTRAP_TOKEN   # strongly recommended before first bootstrap

npx wrangler d1 migrations apply DB --remote
cd ../..
pnpm run build
pnpm exec wrangler deploy --config apps/server/wrangler.jsonc
pnpm exec wrangler deploy --config apps/console/wrangler.jsonc
pnpm exec wrangler deploy --config apps/site/wrangler.jsonc

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
packages/          22 workspace packages: 7 kernel libraries + 15 TypeScript SDKs
sdk/               13 native SDKs
docs/              Design chapters, protocol matrices, SDK matrix, deployment guide
tests/             Cross-workspace gates: protocol source map, native SDK contract, smoke suites
```

The kernel libraries -- `protocol`, `crypto`, `webauthn`, `saml`, `db`, `i18n`, `types` -- are
internal to the Core Worker. Cryptographic primitives always come from Web Crypto and XML-DSig is
delegated to `xmldsigjs`; the protocol and business logic in between are written here.

## Protocol support

Every row maps to files and tests in [`docs/protocols/source-map.md`](docs/protocols/source-map.md).

| Area                                                                   | Support     | Highest evidence                | Notes                                                                            |
| ---------------------------------------------------------------------- | ----------- | ------------------------------- | -------------------------------------------------------------------------------- |
| OAuth 2.x core (code, PKCE S256, client credentials, refresh rotation) | implemented | local protocol client           | Implicit and password grants are rejected with negative tests                    |
| OIDC core (ID token, userinfo, logout, session management, hybrid)     | implemented | local protocol client           | Front-channel and back-channel logout profiles included                          |
| PAR, DPoP, device flow                                                 | implemented | local protocol client           | DPoP nonce challenge is not implemented                                          |
| JAR, JARM, RAR, mTLS, token exchange, DCR, CIBA, OpenID Federation     | implemented | Workers runtime integration     | JWE, remote request-object fetch, and `form_post.jwt` are not claimed            |
| SAML 2.0 SP (inbound) and IdP (outbound)                               | implemented | local fake IdP and fake SaaS SP | Not verified against Okta, Entra ID, or Google Workspace                         |
| SCIM 2.0 Service Provider and outbound provisioning                    | implemented | local fake SaaS SCIM            | Not verified against a real directory or SaaS target                             |
| WebAuthn / passkeys                                                    | implemented | Workers runtime integration     | Four-step verification with no bypass path                                       |
| LDAP direct bind, WS-Federation, SWA, header-based SSO                 | implemented | local harness                   | Kerberos is documentation only                                                   |
| Social OAuth relying party (Google, GitHub, Microsoft, Apple)          | implemented | local fake provider             | Not verified with real provider secrets or callbacks                             |
| Shared Signals, CAEP, RISC                                             | planned     | unit tests                      | Endpoints return 501 and create no streams                                       |
| GNAP, UMA, HEART, OID4VP, OID4VCI                                      | stub        | Workers runtime integration     | Route stubs returning 501 or a placeholder object; not a protocol implementation |

## SDKs

Fifteen TypeScript packages under `packages/`: `core` and `backend` plus framework bindings for
React, Next.js, Remix, Astro, Vue, Nuxt, Svelte, Solid, Angular, React Native, Expo, Electron, and
Tauri -- all workspace-private and **not published to npm**.

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

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request; it covers the toolchain,
the required gates, and the Developer Certificate of Origin sign-off. Participation is governed by
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md), and [`SUPPORT.md`](SUPPORT.md) covers questions that
are not code changes. Do not open a public issue for a vulnerability -- reporting channels, scope,
and the disclosure timeline are in [`SECURITY.md`](SECURITY.md).

XID is licensed under the MIT License; see [`LICENSE`](LICENSE). You may use, modify, and
distribute it, including commercially and in closed-source products, as long as you retain the
copyright notice and the license text.
