# Self-Hosting Deployment Guide

Chinese version: [zh-Hans/deployment.md](./zh-Hans/deployment.md)

This document answers one question: how do you deploy XID into your own Cloudflare account and get it running. The reader is the operator or developer who is self-hosting XID.

XID is MIT-licensed open source. Self-hosting gives you the complete feature set. There is no feature tiering and no license key that phones home.

XID deploys three Workers: Nimbus Site, Console, and Core. Their Wrangler configurations and the
shared route ownership contract are the deployment sources of truth. Every value written as `<...>`
in this document is a placeholder that you must replace with your own resource identifier.

## Prerequisites

- A Cloudflare account on the Workers Paid plan (required by Durable Objects, Queues and D1)
- A domain whose DNS you control
- Node.js and pnpm, then `pnpm install` at the repository root
- `wrangler` logged in (`pnpm exec wrangler login`)

## Deployment units

| Deployment  | Responsibility                                                                                              | Bindings                                                                                             | Static asset behavior                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Nimbus Site | Canonical apex documentation hub, 8-locale public docs, SEO, Pagefind, OG, sitemap, Markdown and LLM output | `ASSETS` only                                                                                        | Static output, 404 page fallback, `run_worker_first=true`     |
| Console     | One org and instance management SPA on apex and tenant-host `/console`                                      | `ASSETS` only                                                                                        | Explicit Console navigation fallback, `run_worker_first=true` |
| Core        | Protocols, Hosted Auth, account, Management API, data, jobs, crons, Durable Objects and identity logic      | `ASSETS` plus every D1, KV, R2, Queue, Durable Object, Analytics, Email, variable and secret binding | Hosted UI and account SPA fallback                            |

Core uses `worker/index.ts`, `compatibility_date=2025-04-08`, and `nodejs_compat`.
`compatibility_date` must not be earlier than `2025-04-08`: the SAML processing layer depends on the
`nodejs_compat` behaviour that takes effect from that date. Site and Console MUST NOT receive a Core
binding, secret, queue consumer, or cron.

### Routes and issuer

The apex domain remains the instance issuer, API base URL, Console base URL, and Hosted Auth base URL.
Runtime separation changes only route ownership. It does not create another issuer or identity core.
Do **not** make `admin.<your-domain>` or `app.<your-domain>` the default issuer or the default sign-in
entry point. Once an issuer has been published to relying parties it is very hard to change.

Cloudflare route ownership is:

| Owner       | Routes                                                                                                                                                                                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nimbus Site | Exact apex hub and English detail routes; `/docs` and `/docs/*` compatibility routes; each supported non-English locale root and subtree; `/_astro/*`, `/_nimbus/*`, `/pagefind/*`, `/og/*`, `/brand/*`, `/icons/*`, `/fonts/*`; exact sitemap, robots, LLM, manifest and icon files; `www.<your-domain>/*` |
| Console     | `<your-domain>/console`, `<your-domain>/console/*`, `*.<your-domain>/console`, `*.<your-domain>/console/*`                                                                                                                                                                                                  |
| Core        | Custom Domain `<your-domain>` plus the organization wildcard fallback `*.<your-domain>/*`; Core SPA chunks are isolated under `/_core/*`                                                                                                                                                                    |

Site and Console routes are explicit, more-specific Worker Routes over the Core Custom Domain and
tenant wildcard fallback. Neither frontend Worker may claim `<your-domain>/*`. There is no front
proxy Worker.

`*.<your-domain>/*` requires that the subdomain DNS record already exists, or is created by an
explicit custom domain. In multi-tenant mode the passkey RPID is isolated per tenant subdomain. The
same Console Worker serves `/console` on the apex and tenant host, so its same-origin Core API calls
and host-only `__Host-` session cookies stay on the original host.

`www.<your-domain>` is a reserved tenant slug. Every request to
`https://www.<your-domain>/{path}?{query}` returns 308 to
`https://<your-domain>/{path}?{query}` with the path and query preserved. Site owns the production
`www` routes, including the more-specific Console paths. The Console handler retains the same 308 as
a defensive check, but `www` never enters TenantContext.

Worker Routes do not create DNS. Before route activation, create a proxied `www` DNS record in the
zone. A placeholder A record may target `192.0.2.0`, or an AAAA record may target `100::`, because
the Site Worker terminates the request and returns the redirect. Confirm
`https://www.<your-domain>/` resolves before marking the release preflight PASS. This follows the
Cloudflare redirect prerequisite documented at
`https://developers.cloudflare.com/workers/configuration/routing/custom-domains/#redirect-between-www-and-root-domain`.

### Public docs routes

Nimbus Site renders public technical documentation from the explicit public docs registry and the
locale-neutral `apps/site/src/content-source/docs/documents.json` AST. The build generates 40
documents plus one documentation hub for each of 8 locales, for 328 canonical pages. English uses
`/` and `/{slug}`. Other locales use `/{locale-segment}` and
`/{locale-segment}/{slug}`. It also produces Pagefind search data, canonical
and hreflang metadata, Open Graph metadata, JSON-LD, sitemap entries, `.md` and `.mdx` twins, section
LLM files, root `llms.txt`, and `llms-full.txt`.

Global `/llms.txt` and `/llms-full.txt` each cover all 328 pages. English locale agent files are
`/en/llms.txt` and `/en/llms-full.txt`; the other 7 locales use their locale segment. Every locale
index and corpus covers 41 pages.

Registered legacy `/docs` paths return a single 308 to the root canonical tree, with query
parameters preserved. The same applies to old `.md`, `.mdx`, and English `llms*.txt` paths. Any
unregistered `/docs/*` subpath returns the Nimbus 404. It does not enter Core, the Hosted UI SPA, or
`/sign-in`. Repository-internal design, deployment, and API contract documents therefore remain
private even when a requested URL resembles a repository path. Adding a public documentation page
requires a matching registry entry and generated content for every supported locale.

The English SCIM document is the route exception: Site declares only exact `/scim`, `/scim/`,
`/scim/index.md`, and `/scim/index.mdx` routes. Never declare `<your-domain>/scim/*` for Site,
because `/scim/v2/*` is a Core protocol surface.

The installed Nimbus Registry features are `pagefind-search`, `ai-native`, `404-page`, `mermaid`,
and `lint-prose-textlint`. Registry recipes such as `changelog`, `new-version`, and `new-collection`
are not enabled merely because the upstream CLI can print them.

Mermaid source is authored only as a CodeBlock in `documents.json` with `kind: "code"` and
`language: "mermaid"`. The generator carries the fence into every locale and both Markdown twins;
the Site turns it into a theme-aware browser diagram. Generated MDX is never edited directly.

The prose gate regenerates content and runs textlint only on the generated English docs subtree.
Translated content continues through the Lingui extract, compile, and audit workflow instead of
English prose rules.

`apps/site/public/_headers` assigns explicit UTF-8 media types to agent-readable static output:

```text
/*.md
  Content-Type: text/markdown; charset=utf-8

/*.mdx
  Content-Type: text/markdown; charset=utf-8

/*.txt
  Content-Type: text/plain; charset=utf-8
```

Before publishing a Site or docs change, run:

```bash
pnpm --filter @xid-kit/site check
pnpm --filter @xid-kit/site test
pnpm --filter @xid-kit/site build
```

### Platform management routes

- Main entry `/console/platform`
- Sub-pages `/console/platform/organizations`, `/console/platform/users`, `/console/platform/events`, `/console/platform/flags`, `/console/platform/billing`

Platform management and tenant management are served by the same React Console Worker and the same
Console product. Authorization stays in Core and is decided by the cookie session plus
`ManagerAssignment(instance_manager)`. There is no second platform-admin SPA, no separate admin API,
no separate admin tenant, and no separate admin RBAC.

## Cloudflare bindings

The following resources must be created in your account, and their identifiers written into `apps/server/wrangler.jsonc`:

| Binding          | Type                     | Resource to create                            |
| ---------------- | ------------------------ | --------------------------------------------- |
| `DB`             | D1                       | database, id set to `<your-d1-database-id>`   |
| `CACHE`          | KV                       | namespace, id set to `<your-kv-namespace-id>` |
| `STORAGE`        | R2                       | bucket                                        |
| `EMAIL`          | Cloudflare Email Service | `send_email` binding                          |
| `ANALYTICS`      | Analytics Engine         | dataset                                       |
| `EMAIL_QUEUE`    | Queue producer           | queue                                         |
| `WHATSAPP_QUEUE` | Queue producer           | queue                                         |
| `SMS_QUEUE`      | Queue producer           | queue                                         |
| `AUDIT_QUEUE`    | Queue producer           | queue                                         |
| `WEBHOOK_QUEUE`  | Queue producer           | queue                                         |
| `METERING_QUEUE` | Queue producer           | queue                                         |

Queue consumer settings (repository defaults):

| Queue purpose | batch | timeout | retries | Notes              |
| ------------- | ----- | ------- | ------- | ------------------ |
| email         | 100   | 5       | 5       | DLQ                |
| whatsapp      | 100   | 5       | 5       | DLQ                |
| sms           | 100   | 5       | 5       | DLQ                |
| audit         | 100   | 5       | 5       | concurrency 1, DLQ |
| webhook       | 50    | 5       | 5       | DLQ                |
| metering      | 100   | 5       | 5       | DLQ                |

`concurrency 1` on the audit consumer is mandatory: the audit chain uses a monotonically increasing seq plus a SHA256 hash of the previous entry, and concurrent writes break the chain.

Durable Objects:

| Binding              | Class             |
| -------------------- | ----------------- |
| `SESSION_REVOCATION` | `SessionDO`       |
| `WEBAUTHN_CHALLENGE` | `ChallengeStore`  |
| `OAUTH_STATE`        | `OAuthFlowDO`     |
| `PAR_STORE`          | `ParStore`        |
| `DEVICE_FLOW`        | `DeviceFlowStore` |
| `RATE_LIMITER`       | `RateLimitStore`  |
| `AUDIT_SEQ`          | `AuditSeqDO`      |
| `METERING`           | `MeteringDO`      |

DO migration tag `v1`.

Cron triggers:

| Cron        | Handler                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| `0 * * * *` | hourly cleanup plus `usage_daily` gap backfill                                |
| `0 2 * * *` | signing key, certificate, domain, SAML metadata and monthly usage maintenance |

## Secrets

Required Workers Secrets:

| Secret   | Format                                     | Used for                                                                                         |
| -------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `KEK`    | 32 bytes, standard base64                  | Envelope encryption of OIDC signing keys, SAML private keys, webhook secrets and provider tokens |
| `PEPPER` | 32 bytes, base64url, or `v<N>:<base64url>` | HMAC for passwords, reset tokens, backup codes and step-up tokens                                |

Losing `KEK` means every signing private key and provider credential becomes undecryptable. Losing `PEPPER` means no password hash can be verified any more. Back both up independently into your own secret management system before you deploy. `PEPPER` accepts a `v<N>:` version prefix so that rotation can keep verifying values derived from an older version.

Optional Workers Secrets:

| Secret                      | Used for                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `BOOTSTRAP_TOKEN`           | Once set, `/admin/bootstrap` requires a constant-time matching `X-Bootstrap-Token` header |
| social provider secret refs | The Workers Secret pointed at by `TenantContext.policy.socialProviders[].clientSecretRef` |

Set `BOOTSTRAP_TOKEN` before the first bootstrap. Without it, anyone can call `/admin/bootstrap` against an empty database and claim the initial super admin account.

Write the secrets:

```bash
pnpm --dir apps/server exec wrangler secret put KEK
pnpm --dir apps/server exec wrangler secret put PEPPER
pnpm --dir apps/server exec wrangler secret put BOOTSTRAP_TOKEN
```

This repository never commits a `.env` file or any secret value.

### Social provider readiness

Console responses distinguish `hasClientSecret` from `credentialsReady`. `hasClientSecret=true` only means the D1 policy stored a `clientSecretRef`. `credentialsReady=true` means `enabled`, `clientId`, `authorizationEndpoint`, `tokenEndpoint`, `clientSecretRef` and the referenced Workers Secret are all present, and that an OIDC provider additionally has both an issuer and a JWKS URI. The Hosted UI only shows providers with `credentialsReady=true`.

Writing or deleting a secret does not require a D1 policy change. Refreshing `/v1/organizations/:orgId/social-providers` recomputes readiness from the current Workers env.

## D1 migrations

Migrations live in `packages/db/drizzle`, and `packages/db/drizzle/meta/_journal.json` is the authority on their order.

Apply migrations locally:

```bash
pnpm --filter @xid-kit/server db:migrate:local
```

**Migrations are expand-contract only**: new tables, new columns, new indexes and new data. Dropping a table or column, renaming a table or column, and altering a column in place are all forbidden. A drop or rename may only land in a release that ships after the old Worker has stopped reading that schema. The reason is that old and new Worker versions briefly coexist during a deployment, and destructive DDL makes the old version fail immediately.

The repository ships a migration compatibility gate that rejects non-additive SQL or incomplete Drizzle metadata before a production deployment:

```bash
node apps/server/scripts/assert-migration-compatibility.mjs
```

A schema change must add a new migration. Never edit an existing baseline file.

### Wiping and rebuilding a live database

Collapsing a migration chain, or starting over, means wiping the live D1 and rebuilding it. That discards every row of production data, it is a one-off operation, and the routine flow above does not apply to it. Confirm these four things before you start.

**1. The signing keys go with the database.** `instance_signing_keys` lives in D1, so a rebuild plus bootstrap mints a brand new kid. Every access token, ID token and refresh token issued before the rebuild fails verification, so every RP session and every SDK session dies and users must sign in again. That is expected, not a defect. There is no stale-cache risk on your side: the JWKS cache key is `jwks:{issuer}:{activeKid}` (it contains the kid, see `apps/server/worker/oidc/jwks.ts`) and the discovery cache key is `discovery:{tenantId}:{issuer}`, so a new tenant id simply lands on a new key. The risk is on the RP side: relying parties and third-party libraries cache JWKS on their own TTL (this repository defaults to `JWKS_CACHE_TTL_SEC = 3600`), and until they refresh, newly signed tokens are rejected as an unknown kid. If you have RPs connected, tell them to refresh JWKS or wait one TTL cycle.

**2. Do not clear the Durable Objects, and never reuse the old org id.** Every DO instance name derives from a tenant id or user id (`audit-seq:{tenantId}`, `metering:{tenantId}`, `session:{userId}`, and the rate limit keys likewise). Once bootstrap mints new ids, the old DOs are never addressed again; the fresh `AuditSeqDO` has empty storage, its constructor finds no `next` or `last_hash`, so `initialize()` reads back an empty D1 and the chain restarts at seq 1 with `prev_hash` at GENESIS. The chain is clean by construction. Reusing the pre-rebuild org id does the opposite: it re-addresses the old DO, whose storage still holds a `next` and a `last_hash` pointing at rows that no longer exist. The constructor sees that storage, sets `initialized=true` and skips `initialize()`, so the new chain continues from the old seq with a dangling `prev_hash`. That corrupts the audit chain permanently, and chain validation cannot detect it. Durable Objects also cannot be wiped through a wrangler migration; the reasoning is in the comment above `migrations` in `apps/server/wrangler.jsonc`.

**3. Pushing to the production branch runs migrations against the live D1.** The deploy command is `wrangler d1 migrations apply DB --remote && wrangler deploy`, and `&&` carries real shell semantics: a non-zero exit from the migration step aborts before `wrangler deploy`, so the previous Worker stays online. When you collapse a migration chain, the existing `d1_migrations` rows do not carry the new baseline tag, Workers Builds treats it as unapplied and applies it, and `CREATE TABLE` against an existing table fails. That failure is expected; it must land in `d1 migrations apply`, and at that point the production database is untouched.

**4. Storage under the old ids is orphaned but still billed.** DO storage for the old org and user ids, KV entries such as `brand:{oldOrgId}` and `discovery:{oldOrgId}` (these expire on their own TTL), and R2 objects holding the org logo under the old org id. None of this affects correctness. Schedule a separate cleanup rather than folding another variable into the rebuild.

The wipe itself is one `DROP TABLE` per table through `wrangler d1 execute DB --remote`. `_cf_KV` and `sqlite_sequence` are D1 internal tables and must never be dropped. The only platform-side safety net is D1 Time Travel (`wrangler d1 time-travel info` / `restore`), which restores the whole database to a point in time and is not an application-level export. If you need a record of the old data, `SELECT` it out before the wipe.

The L3 outbound SAML fake-SaaS test needs `XID_L3_SAML_IDP_KEY_PKCS8_B64` (the test IdP private key) injected. Never write that value into `.dev.vars`, git, or your shell history.

## Bootstrap

Initialization endpoint:

```text
POST /admin/bootstrap
```

Behaviour:

- Must run against an empty D1 database.
- Returns `409 already_initialized` when any `instances` row already exists; it never creates a second one.
- Once `BOOTSTRAP_TOKEN` is configured, the request must carry `X-Bootstrap-Token`.
- The first run creates the instance, the default organization, the instance ES256 signing key, the initial super admin user, and an `instance_manager` manager assignment.
- The initial super admin user's `users.primary_email_id` must point at a `user_emails` row with `is_primary=1`.
- In multi-tenant mode the instance signing key signs every default JWT: OIDC, Magic Link, email verification, password reset. The default organization is not an independent issuer. Email OTP signs no JWT at all; it sends a short-lived code and stores only its hash in D1.
- The default organization is written with a minimal Hosted Auth policy: email magic link and email OTP are enabled for sign-in and user creation; password, passkey, WhatsApp OTP, SMS OTP, social OAuth and enterprise SSO are disabled. Every other method must be enabled explicitly in the console with its provider configured.
- Because that default policy depends on email delivery, bootstrap is not a usable login path until transactional email actually sends. Complete the **Sending domain** steps under [Notifications and templates](#notifications-and-templates) before you expect magic links or email OTP to work.
- The response returns no private key, no ciphertext and no KEK.

Repair endpoint:

```text
POST /admin/bootstrap/repair
```

Behaviour:

- Requires `BOOTSTRAP_TOKEN` to be configured, and the request must carry `X-Bootstrap-Token`.
- Scans active top-level orgs only.
- Creates an ES256 active signing key only for instances that have no active, next or retiring signing key.
- Envelope-encrypts the private key with the Worker runtime `env.KEK`; the response returns only `instanceId` and `kid`.
- Use it to repair legacy data where the instance signing key is missing or a user has no `primary_email_id`.

Run and seed locally:

```bash
pnpm --filter @xid-kit/server db:migrate:local
pnpm --filter @xid-kit/server dev
pnpm --filter @xid-kit/server db:seed:local
```

Production initialization request:

```bash
curl -X POST https://<your-domain>/admin/bootstrap \
  -H 'content-type: application/json' \
  -H 'X-Bootstrap-Token: <BOOTSTRAP_TOKEN>' \
  --data '{"primaryDomain":"<your-domain>","mode":"multi_tenant","adminEmail":"<admin@your-domain>"}'
```

For a single-tenant self-hosted deployment, set `mode` to `single_tenant`.

## Build and deploy

Verify before you commit:

```bash
pnpm check
pnpm smoke:l2-l3
pnpm test
pnpm build
```

`smoke:l2-l3` uses its own temporary Miniflare state; it neither reads nor modifies your `apps/server/.dev.vars`.

### Automated build and coordinated release

Connect three Cloudflare Workers Builds projects to the same repository. A build may upload an
immutable version, but independent projects MUST NOT promote themselves or mutate production routes
on every push. One release job coordinates all three artifacts and records the result.

Dashboard -> Worker -> Settings -> Build configuration:

| Worker      | Root directory | Build command                                                       | Upload behavior                                                                              |
| ----------- | -------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Core        | `apps/server`  | `node scripts/assert-migration-compatibility.mjs && pnpm run build` | Upload an immutable version; run remote D1 migrations only during an approved Core promotion |
| Console     | `apps/console` | `pnpm run build`                                                    | Upload an immutable version without attaching production routes                              |
| Nimbus Site | `apps/site`    | `pnpm run build`                                                    | Upload an immutable version without attaching production routes                              |

Feature branches upload preview versions only. They do not run production D1 migrations, shift
production traffic, or change routes.

The Core production trigger is a hard pre-merge gate. Before a commit that removes the old UI
reaches `main`, its deploy command must be upload-only: `pnpm exec wrangler versions upload`.
Disable the trigger instead if it cannot be changed in time. A Core trigger that runs
`wrangler deploy`, `wrangler versions deploy`, `wrangler triggers deploy`, or remote D1 migrations
can publish the tight Core before the frontend routes exist.
The gate resolves Worker `xid` through `GET /workers/scripts`, then reads
`GET /builds/workers/{tag}/triggers`. An empty trigger list fails. At least one `main` trigger must
be rooted at `apps/server` and upload-only, and no other `main` trigger may promote, change routes,
or apply D1 migrations.

Production promotion runs only from `.github/workflows/release-web.yml`. Dispatch it from `main`
with a unique release ID, the reviewed release SHA, the fixed compatibility Core SHA, and the exact
confirmation `DEPLOY_XID_WEB`. The `production` GitHub environment should require a reviewer.
`production-rollback` MUST NOT require an approval because it has to run after the source workflow
is cancelled or times out.
`CLOUDFLARE_API_TOKEN` needs Workers Scripts Edit, Workers Routes Edit, Zone DNS Read, and Workers
Builds Read. `CLOUDFLARE_ACCOUNT_ID` is a repository variable. Both workflows need
`deployments: write` for the durable GitHub Deployment checkpoint.

### Staged production rollout

The required release order is:

1. Create and verify the proxied `www` DNS record. Record the preflight result in the release
   manifest. Resolve the zone ID, record the exact expected Console and Site route patterns, and
   require `xid`, `xid-console`, and `xid-site` to have an active deployment before mutation.
   Record every active version and percentage, require that Console and Site own no live routes,
   and verify the old Core fallback on apex, Console, and `www`.
2. Build and deploy a compatibility Core version that still contains the old public UI and old
   Console fallback. Record its immutable Cloudflare version ID.
3. Build and upload the Console version without production routes. Verify its preview, artifact
   contents, security headers, apex Console navigation, tenant-host Console navigation, account
   redirects, and same-origin API boundary. Deploy that immutable version at 100 percent before
   attaching routes. A first `versions upload` creates the Worker but does not create its production
   deployment.
4. Build and upload the Nimbus Site version without production routes. Verify its preview, all 8
   locales, public docs, Pagefind, Markdown twins and their media types, LLM outputs, JSON-LD,
   Mermaid rendering and expansion, assets, 404 behavior, and the `www` redirect. Deploy that
   immutable version at 100 percent before attaching routes.
5. Activate the Console routes, then the Site routes. Run edge smoke checks after each route group.
   Confirm that protocol, Hosted Auth, account, and API paths still resolve to Core.
6. Build and deploy the tight Core version that removes the old public UI and old Console fallback.
   Do this only after the new routes have passed edge smoke.

Before the old UI is removed, build the compatibility Core artifact from a fixed git SHA in an
isolated checkout. The artifact must include the Worker bundle, its static assets, Wrangler
configuration, and build metadata. The only allowed compatibility SHA is
`995f65c6aae0bdc77e8a0fdbf0222f51143ce2d2`; it must be an ancestor of both `origin/main` and the
reviewed release SHA. The detached install and build receive a minimal environment without
`CLOUDFLARE_API_TOKEN` or `GITHUB_TOKEN`.

The release manifest records, for compatibility Core, Console, Nimbus Site, and tight Core:

- proxied `www` DNS resolution preflight
- Worker name and git SHA
- lockfile SHA-256 and deployable artifact SHA-256
- immutable Cloudflare version ID
- preview command and result
- route activation command and result
- rollback command and result

The manifest contains no secret. A release is incomplete if any artifact digest or version ID is
missing.

Initialize the ignored release workspace only after the compatibility Core commit and lockfile are
fixed:

```bash
node scripts/web-release-manifest.mjs init \
  --release-id xid-web-YYYYMMDD-NNN \
  --release-git-sha <release-git-sha> \
  --release-lockfile-sha256 <release-lockfile-sha256> \
  --compat-core-git-sha <compat-core-git-sha> \
  --compat-core-lockfile-sha256 <compat-core-lockfile-sha256>
node scripts/build-core-compat-artifact.mjs \
  --git-sha <compat-core-git-sha> \
  --print-plan
node scripts/web-release-manifest.mjs validate \
  .xid/releases/xid-web-YYYYMMDD-NNN/manifest.json
```

Remove `--print-plan` only in the approved release job to build the local compatibility artifact.
That command uses a detached temporary worktree, runs a frozen install and Core build, runs
`wrangler versions upload --dry-run` to produce the deployable bundle, and writes the archive plus
SHA-256 metadata under `.xid/releases/`. It does not upload a Worker. Production upload passes that
bundle with `--no-bundle` and rejects any SHA-256 difference in the complete module graph, including
the entry and every additional ESM module, between the dry-run bundle and upload outdir. The
generated upload config sets `no_bundle=true`, `find_additional_modules=true`,
`base_dir=./worker-bundle`, and an `ESModule` rule for `**/*.js` and `**/*.mjs`, so Wrangler uploads
the archived additional modules instead of only checking that they exist.

The coordinated job uses these Cloudflare operations in order:

```bash
pnpm exec wrangler versions upload --config apps/server/wrangler.jsonc
pnpm exec wrangler versions deploy <compat-core-version-id>@100% --config apps/server/wrangler.jsonc --yes
pnpm exec wrangler versions upload --config apps/console/wrangler.jsonc
pnpm exec wrangler versions deploy <console-version-id>@100% --config apps/console/wrangler.jsonc --yes
pnpm exec wrangler versions upload --config apps/site/wrangler.jsonc
pnpm exec wrangler versions deploy <site-version-id>@100% --config apps/site/wrangler.jsonc --yes
pnpm exec wrangler triggers deploy --config apps/console/wrangler.jsonc
pnpm exec wrangler triggers deploy --config apps/site/wrangler.jsonc
pnpm exec wrangler versions upload --config apps/server/wrangler.jsonc
pnpm exec wrangler versions deploy <tight-core-version-id>@100% --config apps/server/wrangler.jsonc --yes
```

All three Wrangler configurations set `preview_urls: true`. `versions upload` has no JSON flag.
The release runner sets `WRANGLER_OUTPUT_FILE_PATH`, reads the `version-upload` NDJSON entry, and
records `version_id`, `preview_url`, and `preview_alias_url`. It then independently confirms the
same ID and tag through `wrangler versions list --json`; it never scrapes human console output.
Console and Site require both preview URLs. A Core version may omit them because Durable Object
bindings can prevent a version preview. In that case the runner verifies the exact Worker bundle
and static asset instead; after promotion it always runs the complete production health,
discovery, JWKS, and SCIM edge checks.

Immediately before the first production traffic mutation, the runner re-reads all three active
deployments and the frontend route baseline. Any drift fails closed. It then creates a GitHub
Deployment whose immutable payload contains the source workflow run ID and attempt, repository ID,
release identity, exact pre-release Core version split, zone ID, and expected route patterns.
Deployment statuses persist `PREPARED`, each mutation intent, `SUCCESS`, `ROLLBACK_INTENT`, and
`ROLLED_BACK`. An intent status must be durable before the corresponding Cloudflare mutation
starts. Recovery validates each phase against its required GitHub state and always re-reads the
remote checkpoint instead of trusting the local manifest phase.

For a full rollback, deploy the exact pre-release Core version split from that checkpoint first.
Do not use the newly built compatibility version as the rollback target. Then list
`GET /zones/{zone_id}/workers/routes`, match only the recorded patterns owned by `xid-console` or
`xid-site`, and delete each resolved route ID through the Cloudflare Zone Workers Routes API.
Delete Console routes first, Site non-`www` routes second, and Site `www` routes last. Re-list and
run the stage smoke after every group. An unexpected pattern fails closed before deletion. The
runner verifies that the restored Core deployment exactly matches the recorded immutable baseline
before deleting a route. If a staged smoke fails, it restores every route deleted by that stage
before returning failure. Stage smoke derives the expected `www` owner from the live route
inventory, so recovery remains idempotent when an intent was recorded before its mutation ran.
Empty-route Wrangler configurations are not a rollback mechanism because `wrangler triggers deploy`
does not remove existing zone routes. Use `wrangler rollback <version-id>` only for a Worker code
rollback; it does not change Worker Routes. Version command behavior is pinned to Wrangler 4.114.0
and follows
`https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/`.

Worker code versions and zone routes are separate Cloudflare state. Route activation happens after
the Console and Site previews pass and is recorded independently from version upload or deployment.
`wrangler rollback` changes Worker code only. It does not restore Worker Routes or bindings.

The manual workflow preserves `.xid/releases/<release-id>` as a GitHub Actions audit artifact, but
the artifact is not the cancellation checkpoint. Release execution has its own bounded timeout. The
independent
`.github/workflows/rollback-web.yml` workflow listens for the completed `Coordinated web release`
run. It runs only when a same-repository `workflow_dispatch` on `main` does not succeed. It checks
out the current trusted default branch, verifies that the source run `head_sha` is its ancestor,
passes the source run ID and release SHA to `recover-rollback`, and never executes code from the
failed source checkout. It does not read dispatch inputs from the `workflow_run` event. The recovery
command finds the GitHub Deployment by source run ID, source run attempt, and release SHA. No
checkpoint means no production intent and therefore a recorded `SKIP`. `PREPARED` also skips
mutation. Any intent restores the exact baseline. `SUCCESS` keeps the release and runs strict
production smoke. `ROLLED_BACK` is idempotent and only re-runs the baseline smoke.

Release and rollback workflows share the fixed `xid-web-production` concurrency group. A new
release rejects the latest checkpoint unless it is `SUCCESS` or `ROLLED_BACK`. Workflow run attempt
is part of the checkpoint identity and every artifact name, so rerunning a GitHub Actions run cannot
reuse an older checkpoint or collide with immutable artifacts. The release fetches `origin/main`
again immediately before execution and again before the first production mutation; both checks
require `HEAD`, the reviewed release SHA, and `origin/main` to be identical.

Rollback runs in the separate `production-rollback` environment without an approval gate. It must
restore the pre-release Core successfully before changing any frontend route. Only then may it
remove Console routes, remove Site public routes while retaining `www`, and finally remove `www`.
The staged edge gates cover health, discovery, JWKS, SCIM, root fallback, Console fallback, the Site
owned `www` redirect before its removal, and the Core-owned `www` fallback after removal. The
workflow preserves `.xid/releases` as separate recovery evidence even when rollback fails.

### Rollback

Rollback order is:

1. Deploy the exact pre-release Core version split recorded before any mutation.
2. Remove Nimbus Site and Console production routes. Remove `www` last so it cannot fall into the
   Core tenant wildcard while other frontend routes are still changing.
3. Verify the apex, protocol paths, Hosted Auth, account, Console fallback, tenant hosts, and `www`.

Do not treat `wrangler rollback` as a complete rollback. The independent rollback workflow must
execute and record the separate route rollback. The release workflow does not contain a rollback
job.

### Do not deploy by hand

Production releases go through Workers Builds and the coordinated release job. **Do not run
`wrangler deploy`, `wrangler versions upload`, or production route mutations locally.** A local
deployment bypasses the repository gates and release manifest, and it produces state that cannot be
reconstructed from a reviewed commit.

### CI

`.github/workflows/ci.yml` triggers on `pull_request`, on `push` to `main`, and on manual `workflow_dispatch`. It defines six jobs, all on `ubuntu-latest`, and every one of them starts with `pnpm install --frozen-lockfile`:

| Job                               | Runs on                                | Command after install                                                            |
| --------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------- |
| `check`                           | every trigger                          | `pnpm check`                                                                     |
| `test`                            | every trigger                          | `pnpm test`                                                                      |
| `build`                           | every trigger                          | `pnpm build`                                                                     |
| `smoke`                           | every trigger **except pull requests** | `pnpm smoke:l2-l3`, after verifying headless Chrome is installed                 |
| `security`                        | every trigger                          | `pnpm run security:secret-scan`                                                  |
| `dependency audit (non-blocking)` | every trigger **except pull requests** | `pnpm run security:dependencies`, that is `pnpm audit --prod --audit-level high` |

Two jobs carry `if: github.event_name != 'pull_request'` on purpose. `smoke` starts a wrangler dev server plus headless Chrome per file, which makes it the longest and the most flake-prone stage, so it guards `main` after the merge rather than gating the pull request. `dependency-audit` queries a live advisory database, so the same commit can be green today and red tomorrow with no code change; it reports its real verdict but stays out of the required checks.

There is no native SDK job and no job matrix. Native SDK verification rides inside `check`: `pnpm check` chains `pnpm native:verify` (`node --test tests/native-sdk-contract.test.mjs`), which validates the platform contract matrix itself -- every platform has at least one step and every step points at a directory that exists. It runs no language toolchain, and CI installs none. Executing a platform's real test suite is a local opt-in: `XID_NATIVE_SDK_PLATFORM=go pnpm native:verify` runs the Go steps from that same matrix, and only then.

CI never runs `wrangler deploy`, so it needs no `CLOUDFLARE_API_TOKEN`.

## Post-deployment verification

```bash
curl -fsS https://<your-domain>/v1/health
curl -fsS https://<your-domain>/.well-known/openid-configuration
curl -fsS https://<your-domain>/jwks
curl -fsS https://<your-domain>/auth/config
curl -fsS https://<your-domain>/
curl -fsSI https://<your-domain>/getting-started/index.md
curl -fsSI https://<your-domain>/getting-started/index.mdx
curl -fsSI https://<your-domain>/llms.txt
curl -fsSI https://<your-domain>/llms-full.txt
curl -fsSI https://<your-domain>/en/llms.txt
curl -fsSI https://<your-domain>/en/llms-full.txt
curl -fsSI https://<your-domain>/docs/getting-started
curl -fsSI https://<your-domain>/scim/v2/ServiceProviderConfig
curl -fsSI https://<your-domain>/console
curl -fsSI https://<tenant>.<your-domain>/console
curl -fsSI 'https://www.<your-domain>/docs?locale=en'
```

The Markdown and MDX responses must use `text/markdown; charset=utf-8`; LLM responses must use
`text/plain; charset=utf-8`. The legacy docs response must be a 308 to
`https://<your-domain>/getting-started`, while the SCIM protocol response must still come from
Core. Open `https://<your-domain>/getting-started` in a browser and
confirm the authorization Mermaid diagram renders, re-renders after a light or dark theme change,
and opens and closes its full-screen dialog.

The repository also ships a set of `pnpm smoke:production*` scripts. Read them as maintainer tooling
for the hosted instance rather than as a self-hosting verification step. The production harness pins
the hosted Cloudflare targets, while D1 probes target Core. Running them against your own deployment
means changing those pins to your own three Workers first, then pointing
`XID_PRODUCTION_TENANT_ID` at your default organization and `XID_PRODUCTION_EMAIL` at a mailbox you
control.

`pnpm smoke:production` covers Core health, Nimbus public docs, internal docs 404, the Hosted Auth
entry, the default auth config, the default profileFields, the root resolver, the default
organization bootstrap shape, the default authentication policy gate, the Magic Link verify route
gate, the forgot-password disabled gate, root discovery and JWKS.

It cannot prove that a Magic Link email click, the Email OTP cookie flow, active organization
handling, apex and tenant-host Console routing, real provider delivery, or a real cookie session
work. Those need the per-feature smokes below.

### Per-feature smokes

Smokes that involve a real provider need real credentials or a code that was really received. Always pass that kind of input through a **file variable** rather than a plain environment variable, so it never lands in shell history, the process environment or command logs.

| Command                                   | Covers                                                | Required input                                                                               |
| ----------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm smoke:production:auth`              | Email OTP real cookie plus `/v1/me`                   | `XID_PRODUCTION_EMAIL`                                                                       |
| `pnpm smoke:production:browser`           | Headless Chrome checks on DOM, console and navigation | `XID_PRODUCTION_EMAIL`                                                                       |
| `pnpm smoke:production:magic-link-send`   | Magic Link send and audit path                        | `XID_PRODUCTION_EMAIL`                                                                       |
| `pnpm smoke:production:magic-link`        | Magic Link sign-in from a real click                  | `XID_PRODUCTION_MAGIC_LINK_URL_FILE`                                                         |
| `pnpm smoke:production:whatsapp-otp-send` | WhatsApp OTP send side                                | `XID_PRODUCTION_PHONE_OTP_PHONE_FILE` (SKIP when no provider is configured)                  |
| `pnpm smoke:production:sms-otp-send`      | SMS OTP send side                                     | Same as above                                                                                |
| `pnpm smoke:production:whatsapp-otp`      | Full WhatsApp OTP verification                        | `XID_PRODUCTION_PHONE_OTP_ORGANIZATION_ID` plus phone file plus code file                    |
| `pnpm smoke:production:sms-otp`           | Full SMS OTP verification                             | Same as above                                                                                |
| `pnpm smoke:production:social-oauth`      | Social OAuth real callback                            | `XID_PRODUCTION_SOCIAL_OAUTH_CALLBACK_URL_FILE`                                              |
| `pnpm smoke:production:enterprise-sso`    | Enterprise SSO real IdP callback                      | `..._CALLBACK_URL_FILE` for OIDC; `..._SAML_RESPONSE_FILE` plus `..._CONNECTION_ID` for SAML |
| `pnpm smoke:production:mfa-sms`           | MFA SMS step-up                                       | `XID_PRODUCTION_MFA_SMS_COOKIE_FILE` plus `XID_PRODUCTION_MFA_SMS_CODE_FILE`                 |

The correct order for a full Magic Link smoke is: run `magic-link-send` first, take the link from **this** run out of the real inbox into a temporary file, then run `magic-link`. Otherwise you end up with mismatched evidence: a new email was sent, but an older link was consumed.

A full phone OTP smoke requires the real 6-digit code received on the device. It cannot be derived from the D1 `code_hash`. When no provider is configured the send-side script prints `SKIP`, and SKIP is not PASS.

Running `pnpm smoke:production:auth` repeatedly trips the send rate limit. On HTTP 429, wait for the window to recover and rerun; do not investigate a 429 as a failure.

### Active organization verification

After touching the console, the auth context or any active-organization code, the minimum verification is:

- Call `/v1/me` with a host-only cookie from a real sign-in and record the state before the active org changes.
- Call `POST /v1/sessions/active-organization` with the same cookie.
- Call `/v1/me` again immediately with the same cookie and confirm the active org changed.
- Open `/console/organizations`, `/console/users` and `/console/settings` in a browser and confirm there is no dead state when no active organization is set.
- Repeat a nested Console navigation on the apex and tenant host, and confirm both are served by the
  Console Worker while `/v1/me` stays on the same host and reaches Core.
- After clearing the active org, an Instance Manager can still reach `/console/platform/*`, and an Org Admin lands on the organization switcher or on a usable org view.

## WhatsApp and SMS OTP providers

WhatsApp OTP and SMS OTP are the same phone OTP capability. The default bootstrap policy disables both. Even when the organization policy enables them, `/auth/config` hides the method while no provider is configured, and calling the API directly is rejected by policy with an `auth.policy_denied` audit entry.

The `/v1/organizations/:orgId/auth-policy` response carries a read-only `deliveryChannelReadiness.whatsappOtp/smsOtp`. That field describes the WhatsApp and SMS delivery channels only, not Social OAuth providers. It does not come from the D1 policy and does not accept PATCH; the server recomputes it from the current Workers env on every request.

WhatsApp providers:

| Provider                   | Required configuration                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `WHATSAPP_PROVIDER=meta`   | `WHATSAPP_META_PHONE_NUMBER_ID`, `WHATSAPP_META_ACCESS_TOKEN`; optional `WHATSAPP_META_API_VERSION`, default `v25.0` |
| `WHATSAPP_PROVIDER=twilio` | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, plus `WHATSAPP_FROM`, `SMS_FROM` or `TWILIO_MESSAGING_SERVICE_SID`        |

SMS providers:

| Provider                   | Required configuration                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `SMS_PROVIDER=twilio`      | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, plus `SMS_FROM` or `TWILIO_MESSAGING_SERVICE_SID` |
| `SMS_PROVIDER=vonage`      | `VONAGE_API_KEY`, `VONAGE_API_SECRET`, `SMS_FROM`                                            |
| `SMS_PROVIDER=infobip`     | `INFOBIP_API_KEY`, `INFOBIP_BASE_URL`, `SMS_FROM`                                            |
| `SMS_PROVIDER=messagebird` | `MESSAGEBIRD_ACCESS_KEY`, `SMS_FROM`                                                         |

Write the credentials:

```bash
pnpm --filter @xid-kit/server exec wrangler secret put WHATSAPP_META_ACCESS_TOKEN
pnpm --filter @xid-kit/server exec wrangler secret put TWILIO_AUTH_TOKEN
pnpm --filter @xid-kit/server exec wrangler secret put VONAGE_API_SECRET
pnpm --filter @xid-kit/server exec wrangler secret put INFOBIP_API_KEY
pnpm --filter @xid-kit/server exec wrangler secret put MESSAGEBIRD_ACCESS_KEY
```

Non-sensitive provider names and sender numbers can live in Workers variables. Credentials go into Workers Secrets only.

## Notifications and templates

The email, WhatsApp and SMS consumers write a `notification.sent` audit event after a successful send. The audit payload contains only a recipient hash, the email domain, the channel, the type and the provider; it never contains the full address, the phone number, a token or an OTP code. Failed sends are written to `notification_failures` and acked once the retry limit is reached, so a poison message cannot block the queue. In that table `recipient` stores only `sha256:<hash>` and `payload` stores only non-secret metadata.

The email consumer uses the Cloudflare Email Service structured send by default and always sends both `html` and `text`. Built-in templates cover `verify_email`, `magic_link`, `otp` and `password_reset`, each with branded HTML plus a plain-text fallback, and none of them reference a remote image.

### Sending domain (required for self-hosting)

The Worker binding alone is not enough. Cloudflare Email Service only delivers mail whose `from`
domain has been onboarded on **your** account. XID hardcodes the default sender to
`no-reply@xid.dev` (`DEFAULT_FROM` in `apps/server/worker/queues/email.ts`). That address is correct
for the upstream hosted product; on a fork it is **not** a domain you control, so every send fails
until you change one of the two sides below.

Do this before bootstrap if you will rely on the default Hosted Auth policy (email magic link and
email OTP only):

1. Pick the domain that will appear in `From` (usually the same apex you pass as `primaryDomain` at
   bootstrap, for example `auth.example.com`).
2. Onboard it for Email Sending and finish DNS:

   ```bash
   npx wrangler email sending enable <your-domain>
   ```

   Complete DKIM, SPF and DMARC as the Cloudflare dashboard instructs. After onboarding you may send
   from any local-part on that domain (`anything@<your-domain>`).

3. Make the Worker send from that domain. Today the code default is still `no-reply@xid.dev`; either
   patch `DEFAULT_FROM` in `apps/server/worker/queues/email.ts` to `{ email: 'no-reply@<your-domain>', name: 'XID' }`
   before deploy, or ensure every enqueued message carries an explicit `payload.from` with an address
   on your onboarded domain. There is no Workers Secret or wrangler variable for the default sender
   yet; changing the constant is a product decision, not a runtime knob.
4. Confirm a real message leaves the queue (for example `pnpm smoke:production:magic-link-send` with
   `XID_PRODUCTION_EMAIL` set) before treating the deployment as self-host complete.

Without steps 2 and 3, magic-link and email-OTP sign-in appear configured but nobody can log in.
Workers Paid is also required for sending to arbitrary external recipients through `send_email`.

The SMS and WhatsApp OTP queues do not assemble message bodies at enqueue time. `/auth/otp/send` writes only structured fields such as `code`, `expiresInMin` and `locale` into the queue, and the consumer renders the body immediately before sending.

R2 can override the phone OTP text templates. Load order:

1. `phone-otp-templates/<channel>/<locale>/<type>.txt`
2. `phone-otp-templates/<channel>/en/<type>.txt`
3. The worker built-in template

`<channel>` is either `sms` or `whatsapp`, and nothing else. The built-in `otp` template covers `en` and `zh-Hans`. Templates support a Mustache subset, and an OTP payload carries at least `{{ code }}` and `{{ expiresInMin }}`. Failure records never store the rendered body.

R2 can override the email templates. Load order:

1. `email-templates/<locale>/<type>.json`
2. `email-templates/en/<type>.json`
3. The worker built-in template

An R2 template JSON must carry a complete `subject`, `html` and `text`:

```json
{
  "subject": "Verify your email",
  "html": "<!doctype html><html><body><p>Use this link:</p><a href=\"{{ link }}\">Verify email</a></body></html>",
  "text": "Use this link: {{ link }}"
}
```

## Brand assets

Public documentation brand and icon assets belong to Nimbus Site. Hosted Auth and Console consume the
shared brand contract but do not become alternate owners of public asset routes. When you change the
logo, regenerate the Nimbus public outputs and the shared UI assets from the same source image, then
verify both light and dark rendering in Site, Hosted Auth, and Console.

## Runtime observation

For production queues, cron, email, D1 and R2, the Cloudflare dashboard and the Worker logs are the source of truth. Cron can be exercised locally through the dev scheduled dispatch:

```bash
pnpm --filter @xid-kit/server dev
```
