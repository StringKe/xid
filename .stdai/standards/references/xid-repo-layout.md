---
type: references
name: xid-repo-layout
description: Where every app, kernel package, SDK, test gate, and doc tree lives in the XID repo, and which globs an applyTo entry should use
---

# XID Repository Layout

This is the authoritative directory map for the XID repo, moved out of the root overview
(`.stdai/standards/root.md`) so the always-loaded rules stay small. Read it when you need to place a
new file, decide which package owns a concern, tell a kernel library apart from a shipped SDK, or
write the `applyTo` globs of a rule -- the glob paths in this file are the authoritative ones.

## Package split: kernel libraries vs embeddable SDKs

`@xid-kit/*` packages split into two groups:

- **Kernel libraries** used inside the server Worker: `protocol`, `webauthn`, `crypto`, `saml`, `db`,
  `i18n`, `types`.
- **Embeddable SDKs** shipped to customers (optional for running XID itself): `core`, `backend`, and
  the framework packages listed below.

## Repository layout (authoritative for applyTo globs)

```
apps/
  server/        The only Worker
    worker/      Hono: OIDC/OAuth, JWKS, SCIM, SAML (SP and IdP), LDAP / WS-Fed / SWA legacy SSO,
                 Management API v1, platform console API, queue consumers, crons, Durable Objects.
                 Non-API paths fall back to SPA assets (ASSETS binding).
    src/         React SPA: sign-in / sign-up / consent / MFA / account, org + platform console,
                 landing page and public docs
    vite.config.ts   standard Vite: stylex + @vitejs/plugin-react + @cloudflare/vite-plugin +
                     lingui + babel(linguiTransformerBabelPreset)
    wrangler.jsonc   main=worker/index.ts, run_worker_first=true,
                     assets.not_found_handling=single-page-application
packages/
  Kernel libraries (imported by apps/server):
    protocol/    OIDC/OAuth/JWT/PKCE/refresh-rotation protocol kernel (in-house)
    webauthn/    WebAuthn verification orchestration (the four checks)
    crypto/      Envelope encryption + instance signing keys (Web Crypto wrapper)
    saml/        SAML processing layer over xmldsigjs + @xmldom/xmldom
    db/          Drizzle schema + tenant-scoped query layer
    i18n/        lingui runtime instance + compiled locale catalogs (lingui.config.ts is at the
                 repo root; catalogs live in packages/i18n/locales)
    types/       Shared contracts: TenantContext, JWT claims, signing keys, WebAuthn, SAML
  Embeddable SDKs:
    core/        Browser core (session store, token cache, Management API helpers)
    backend/     Server core for Web-standard runtimes (Workers/Node/Bun/Deno), networkless JWT
                 verification, request auth, webhook verification
    react/ nextjs/ vue/ nuxt/ svelte/ angular/ remix/ astro/ solid/    Web framework bindings
    react-native/ expo/ electron/ tauri/                               Mobile and desktop bindings
sdk/             13 native SDKs (go, java, rust, php, ruby, python, dotnet, ios, android, macos,
                 windows, linux, flutter). Source-only: NOT published to any registry; consumers
                 vendor the source. Maturity per platform: docs/sdks/platform-matrix.md
tests/           Repo-level gates: key-path checklist, native SDK contract, quality gate,
                 protocol source-map coverage, runtime and production smoke suites
docs/            design/ (source of truth), protocols/ (support matrices + IdP runbooks),
                 sdks/ (per-platform SDK docs), plus api-contracts / deployment / i18n /
                 soft-delete / standards-sources
```
