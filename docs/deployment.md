# Self-Hosting Deployment Guide

Chinese version: [zh-Hans/deployment.md](./zh-Hans/deployment.md)

This document answers one question: how do you deploy XID into your own Cloudflare account and get it running. The reader is the operator or developer who is self-hosting XID.

XID is MIT-licensed open source. Self-hosting gives you the complete feature set. There is no feature tiering and no license key that phones home.

XID deploys three Workers: Nimbus Site, Console, and Core. Their Wrangler configurations and the
shared route ownership contract are the deployment sources of truth. Every value written as `<...>`
in this document is a placeholder that you must replace with your own resource identifier.

## Prerequisites

- A Cloudflare account. Workers Free includes D1, Durable Objects and Queues within their Free
  limits. Workers Paid is required when Cloudflare Email Service must deliver transactional mail
  to arbitrary recipients, so it is the expected plan for a real production identity service.
  See `https://developers.cloudflare.com/workers/platform/pricing/`,
  `https://developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan/`, and
  `https://developers.cloudflare.com/email-service/platform/pricing/`.
- A domain whose DNS you control
- Node.js and pnpm, then `pnpm install` at the repository root
- `wrangler` logged in (`pnpm exec wrangler login`)

## Deployment units

| Deployment  | Responsibility                                                                                              | Bindings                                                                                                                               | Static asset behavior                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Nimbus Site | Canonical apex documentation hub, 8-locale public docs, SEO, Pagefind, OG, sitemap, Markdown and LLM output | `ASSETS` only                                                                                                                          | Static output, 404 page fallback, `run_worker_first=true`     |
| Console     | One org and instance management SPA on apex and tenant-host `/console`                                      | `ASSETS` only                                                                                                                          | Explicit Console navigation fallback, `run_worker_first=true` |
| Core        | Protocols, Hosted Auth, account, Management API, data, jobs, crons, Durable Objects and identity logic      | `ASSETS`, `SITE_WORKER`, `CONSOLE_WORKER`, plus every D1, KV, R2, Queue, Durable Object, Analytics, Email, variable and secret binding | Hosted UI and account SPA fallback                            |

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
| Core        | Custom Domain `<your-domain>`, organization fallback `*.<your-domain>/*`, and Cloudflare for SaaS zone fallback `*/*`; Core SPA chunks are isolated under `/_core/*`                                                                                                                                        |

Site and Console routes are explicit, more-specific Worker Routes over the Core Custom Domain,
tenant wildcard, and zone-wide `*/*` fallback. Neither frontend Worker may claim
`<your-domain>/*`. There is no front proxy Worker. The zone-wide fallback lets the same Core Worker
receive external Cloudflare for SaaS Custom Hostnames; more-specific Site and Console routes
continue to win.

Cloudflare matches a Worker Route against the complete URL, including its query string, and route
patterns cannot declare query parameters. An exact pattern such as
`<your-domain>/getting-started` therefore does not match
`<your-domain>/getting-started?source=...`. Core receives that narrow fallback through its Custom
Domain, resolves the same route ownership contract, and forwards the unchanged Request through the
one-way `SITE_WORKER` or `CONSOLE_WORKER` Service Binding. Site and Console remain binding-free
apart from `ASSETS`, do not bind back to Core, and reject paths outside their exact ownership. This
preserves query strings and avoids broad frontend catch-all routes. See
`https://developers.cloudflare.com/workers/configuration/routing/routes/#matching-behavior` and
`https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/`.

`*.<your-domain>/*` requires that the subdomain DNS record already exists, or is created by an
explicit custom domain. In multi-tenant mode the passkey RPID is isolated per tenant subdomain. The
same Console Worker serves `/console` on the apex and tenant host, so its same-origin Core API calls
and host-only `__Host-` session cookies stay on the original host.

Before enabling the tenant wildcard routes, create a proxied wildcard DNS record such as
`*.<your-domain> AAAA 100::`. The address is an originless placeholder: the Core and Console
Workers terminate matching requests. Verify a fresh, previously unconfigured hostname such as
`https://xid-preflight-<random>.<your-domain>/auth/config?source=preflight` returns Core's opaque
unknown-tenant 404, and that the same host's `/console?source=preflight` returns the Console shell.
Checking only a known host such as `default.<your-domain>` can hide a missing wildcard DNS record or
route. A configured Worker Route without the proxied wildcard DNS record is not a reachable tenant
entry and the release preflight is `FAIL`.

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

### Cloudflare for SaaS custom hostname readiness

Custom sign-in hostnames are optional. When enabled, Core creates and polls Cloudflare for SaaS
Custom Hostnames through the organization Console and Management API. Prepare the provider zone
before allowing an organization to create one:

1. Enable Cloudflare for SaaS on `<your-domain>`.
2. Create an active fallback origin in that zone. For a Worker origin, Cloudflare documents an
   originless proxied DNS record such as `service.<your-domain> AAAA 100::`.
3. Keep the Core Worker route `*/*` on the same zone. Cloudflare applies it to traffic entering
   through customer CNAMEs, while the more-specific Nimbus and Console routes keep their existing
   ownership.
4. Create a zone-scoped API token with `SSL and Certificates Write` for that provider zone. Store it
   only as the Workers Secret `CLOUDFLARE_FOR_SAAS_API_TOKEN`.
5. Configure `CLOUDFLARE_FOR_SAAS_ZONE_ID`. Optionally configure
   `CLOUDFLARE_FOR_SAAS_CNAME_TARGET` to a friendly CNAME target such as
   `customers.<your-domain>`; otherwise Core reads and requires the active fallback origin.

All three values absent leaves this optional feature disabled. A partial required pair fails closed.
Do not put the token in `wrangler.jsonc`, a build variable, D1, or Console input. The official setup
and Worker-origin references are:

- `https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/`
- `https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/`

For each hostname, the Console returns the ownership TXT record, DCV CNAME records once Cloudflare
returns them asynchronously, and the traffic CNAME pointing at the configured target or active
fallback origin. The hostname is not ready until both the Cloudflare hostname status and SSL status
are `active` and customer DNS points at the SaaS target.

Daily maintenance polls state and cleans up expired unverified reservations. Explicit deletion and
expiry cleanup call Cloudflare before releasing local state. The Console warns that moving WebAuthn
to the custom hostname changes the RPID and requires users to register passkeys again.

Repository tests prove the local API, tenant isolation, resolver and maintenance behavior only.
Until a real customer hostname completes DNS, certificate issuance and traffic verification in the
target account, production readiness for this feature is `UNKNOWN`.

### Public docs routes

Nimbus Site renders public technical documentation from the explicit public docs registry and the
locale-neutral `apps/site/src/content-source/docs/documents.json` AST. The build generates 40
documents plus one documentation hub for each of 8 locales, for 328 generated collection pages.
The localized status surface adds one page per locale, so the complete published Site contains
336 canonical pages, or 42 pages per locale. English uses `/` and `/{slug}`. Other locales use
`/{locale-segment}` and
`/{locale-segment}/{slug}`. It also produces Pagefind search data, canonical
and hreflang metadata, Open Graph metadata, JSON-LD, sitemap entries, `.md` and `.mdx` twins, section
LLM files, root `llms.txt`, and `llms-full.txt`.

Global `/llms.txt` and `/llms-full.txt` each cover all 336 pages. English locale agent files are
`/en/llms.txt` and `/en/llms-full.txt`; the other 7 locales use their locale segment. Every locale
index and corpus covers 42 pages. Nimbus-compatible SDK content-section files live at
`/sdks/llms.txt` and `/sdks/llms-full.txt` for English, and below
`/{locale-segment}/sdks/llms*.txt` for the other locales. Each SDK section contains exactly its
locale's 29 SDK pages.

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
- Sub-pages `/console/platform/organizations`, `/console/platform/users`, `/console/platform/events`,
  `/console/platform/flags`, `/console/platform/billing`, `/console/platform/plans`,
  `/console/platform/announcements`, `/console/platform/status`, `/console/platform/compliance`,
  `/console/platform/managers`, `/console/platform/dead-letters`, and
  `/console/platform/settings`

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
| `SCIM_QUEUE`     | Queue producer           | queue                                         |
| `PRIVACY_QUEUE`  | Queue producer           | queue                                         |
| `SITE_WORKER`    | Worker Service Binding   | deployed `xid-site` Worker                    |
| `CONSOLE_WORKER` | Worker Service Binding   | deployed `xid-console` Worker                 |

Queue consumer settings (repository defaults):

| Queue purpose | batch | timeout | retries | Notes              |
| ------------- | ----- | ------- | ------- | ------------------ |
| email         | 100   | 5       | 5       | DLQ                |
| whatsapp      | 100   | 5       | 5       | DLQ                |
| sms           | 100   | 5       | 5       | DLQ                |
| audit         | 100   | 5       | 5       | concurrency 1, DLQ |
| webhook       | 50    | 5       | 5       | DLQ                |
| metering      | 100   | 5       | 5       | DLQ                |
| outbound SCIM | 1     | 1       | 5       | concurrency 1, DLQ |
| privacy       | 10    | 5       | 5       | concurrency 1, DLQ |

The complete deployment inventory is 24 Queue resources: 8 source Queues, 8 source-specific DLQs,
and 8 `*-dlq-persistence-failures` quarantine Queues. Core is the only Worker with Queue producers
or consumers.

`concurrency 1` on the audit consumer is mandatory: the audit chain uses a monotonically increasing seq plus a SHA256 hash of the previous entry, and concurrent writes break the chain.

Each business queue uses its own `<source>-dlq`; a shared `xid-dlq` is not supported because it loses
the original source identity needed for safe replay. Core persists only redacted metadata and a
KEK-envelope-encrypted original message in D1 migration `0003_queue-dead-letters.sql`. DLQ
persistence retries use per-source `*-dlq-persistence-failures` quarantine queues after 100 failures.
An Instance Manager operates records from `/console/platform/dead-letters`.
Replay claims have a five-minute lease; the hourly cron releases stale claims, and a later replay
request can reclaim one directly. Source consumers must remain idempotent because a crash after
Queue acceptance but before the D1 completion write produces at-least-once recovery.

### Queue quarantine incident runbook

Every `*-dlq-persistence-failures` Queue is terminal isolation, not another automatic retry stage.
The checked-in Wrangler configuration deliberately attaches no consumer to these Queues. A message
there means Core exhausted 100 attempts to persist the corresponding DLQ record, so
`/v1/platform/dead-letters` cannot list or replay that message until an operator restores the
encrypted D1 record. Messages remain subject to the Cloudflare Queue retention configured in the
active account.

Treat any non-zero quarantine backlog as an incident:

1. Identify the exact Queue and time window. Use `pnpm exec wrangler queues info <queue-name>` and
   `pnpm exec wrangler queues consumer worker list <queue-name> --json` as read-only inventory
   checks. The normal result is no consumer.
2. In Cloudflare Dashboard -> Queues -> the quarantine Queue, check `backlog_count`,
   `backlog_bytes`, and `oldest_message_timestamp_ms`. The same metrics are available through the
   Cloudflare REST or GraphQL Analytics APIs. Alert when `backlog_count > 0`, and escalate while the
   oldest-message age grows. This repository does not provision the external alert policy or its
   notification destination, so both remain deployment evidence rather than code evidence.
3. Before attaching any incident consumer, stop delivery with
   `pnpm exec wrangler queues pause-delivery <queue-name>`. Pausing does not stop producers from
   adding messages.
4. For read-only triage, leave the Queue paused and inspect only queue-level metrics and consumer
   configuration. A Worker consumer is not read-only: delivery can change retry or acknowledgement
   state. Do not list or log message bodies unless break-glass access is explicitly approved,
   because a quarantined body can contain a recipient, token, provider payload, or other sensitive
   business data.
5. Repair and verify the original persistence dependency first: D1 availability/schema, KEK
   configuration, and the DLQ envelope/redaction path. There is no shipped quarantine recovery API
   or generic recovery Worker. A temporary Worker must be incident-specific, reviewed, restricted
   to the exact Queue, use batch size 1 and concurrency 1, never log plaintext, and acknowledge only
   after the same redacted-metadata plus KEK-envelope ciphertext contract has committed durably to
   `queue_dead_letters`.
6. While delivery is still paused, attach the approved Worker with
   `pnpm exec wrangler queues consumer worker add <queue-name> <incident-worker> --batch-size 1 --max-concurrency 1`,
   confirm the exact attachment with the read-only consumer-list command, then use
   `pnpm exec wrangler queues resume-delivery <queue-name>` for a monitored recovery window. Stop
   and pause again on any persistence error. Consumer add/remove and pause/resume are Cloudflare
   account mutations and require the deployment operator's change approval.
7. After re-persistence, use the existing Instance Manager dead-letter detail and replay action.
   This preserves the `pending -> replaying -> replayed` claim, source-Queue routing, idempotency,
   and `platform.queue_dead_letter.replayed` audit event. Never send a quarantine body directly to a
   source Queue, because that bypasses those controls.
8. When backlog reaches zero, pause delivery, remove the temporary attachment with
   `pnpm exec wrangler queues consumer worker remove <queue-name> <incident-worker>`, verify the
   consumer list is empty, and return the Queue to its normal unpaused/no-consumer state with
   `pnpm exec wrangler queues resume-delivery <queue-name>`.

Quarantine disposal is separate from replay. No repository API implements quarantine purge or
discard. If a message is intentionally not re-persisted, obtain security and data-owner approval
before any external ack or purge, and record the Queue name, count, bounded time range, reason,
approvers, and exact Cloudflare action in the append-only operational audit or incident record.
Never place plaintext bodies or secrets in that record.

Cloudflare references:

- Queue metrics: `https://developers.cloudflare.com/queues/observability/metrics/`
- Pause and resume delivery: `https://developers.cloudflare.com/queues/configuration/pause-purge/`
- Consumer configuration: `https://developers.cloudflare.com/queues/configuration/pull-consumers/`

Create or reconcile the complete Queue set before enabling a Core build that references it:

```bash
pnpm run cloudflare:queues:plan
pnpm run cloudflare:queues:check
pnpm run cloudflare:queues:create
```

The plan command is offline and derives all names from Wrangler. The check command is read-only: it
lists the account inventory, reports every missing required Queue as `FAIL`, and also reports the
obsolete shared `xid-dlq` as `FAIL` pending a reviewed disposition. The apply command skips matching
resources and creates only missing names, so it is safe to repeat when an older deployment already
has the source Queues. Neither command deletes `xid-dlq`; remove that unused Queue separately only
after its backlog and retention requirements have been reviewed. Apply also remains non-zero while
that obsolete Queue exists so the release cannot silently call the inventory closed.

The privacy source Queue is `xid-privacy`, with `xid-privacy-dlq` and the same encrypted DLQ
persistence boundary as the other business Queues. Its messages contain request, tenant, user, and
operation identifiers only. Export objects are private R2 objects under
`privacy-exports/{tenantId}/{userId}/{requestId}.json`; authenticated account downloads expire after
48 hours, and daily Cron removes expired objects and enqueues due 30-day erasures.

Compliance evidence is stored as immutable private R2 objects under `compliance/`. D1 holds the
document metadata and required lowercase `sha256:` checksum. Core is the only download path: it
requires the applicable management session, rejects unsafe keys and objects over 10 MiB, re-hashes
the retrieved bytes, and returns `private, no-store` only when the checksum matches. The bucket is
never exposed as a public origin.

Durable Objects:

| Binding                | Class                  |
| ---------------------- | ---------------------- |
| `SESSION_REVOCATION`   | `SessionDO`            |
| `WEBAUTHN_CHALLENGE`   | `ChallengeStore`       |
| `OAUTH_STATE`          | `OAuthFlowDO`          |
| `PAR_STORE`            | `ParStore`             |
| `DEVICE_FLOW`          | `DeviceFlowStore`      |
| `RATE_LIMITER`         | `RateLimitStore`       |
| `AUDIT_SEQ`            | `AuditSeqDO`           |
| `METERING`             | `MeteringDO`           |
| `GUEST_STORE`          | `GuestStore`           |
| `CIBA_STATE`           | `CibaStore`            |
| `IMPERSONATION_GRANTS` | `ImpersonationGrantDO` |

The first eight classes use DO migration tag `v1`; `GuestStore`, `CibaStore`, and
`ImpersonationGrantDO` use `v2`, `v3`, and `v4` respectively. All are SQLite-backed
`new_sqlite_classes`.

Cron triggers:

| Cron        | Handler                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| `0 * * * *` | hourly cleanup plus `usage_daily` gap backfill                                                            |
| `0 2 * * *` | signing key, custom hostname, domain, SAML, usage, privacy, guest GC, and optional Stripe MAU maintenance |

## Secrets

Required Workers Secrets:

| Secret   | Format                                     | Used for                                                                                         |
| -------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `KEK`    | 32 bytes, standard base64                  | Envelope encryption of OIDC signing keys, SAML private keys, webhook secrets and provider tokens |
| `PEPPER` | 32 bytes, base64url, or `v<N>:<base64url>` | HMAC for passwords, reset tokens, backup codes and step-up tokens                                |

Losing `KEK` means every signing private key and provider credential becomes undecryptable. Losing `PEPPER` means no password hash can be verified any more. Back both up independently into your own secret management system before you deploy. `PEPPER` accepts a `v<N>:` version prefix so that rotation can keep verifying values derived from an older version.

Optional Workers Secrets:

| Secret                          | Used for                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `BOOTSTRAP_TOKEN`               | Once set, `/admin/bootstrap` requires a constant-time matching `X-Bootstrap-Token` header |
| `TURNSTILE_SECRET`              | Server-side Turnstile Siteverify secret; valid only with `TURNSTILE_SITE_KEY`             |
| `CLOUDFLARE_FOR_SAAS_API_TOKEN` | Zone-scoped Cloudflare for SaaS Custom Hostnames create/read/delete token                 |
| `STRIPE_SECRET_KEY`             | Optional managed-service Checkout, Billing Portal, and meter-event API credential         |
| `STRIPE_WEBHOOK_SECRET`         | Optional Stripe webhook HMAC secret for plan reconciliation                               |
| `SCIM_TARGET_TOKEN_<id>`        | One downstream bearer token for the matching outbound SCIM target                         |
| `GOOGLE_CLIENT_SECRET`          | Google Social OAuth client secret                                                         |
| `GITHUB_CLIENT_SECRET`          | GitHub Social OAuth client secret                                                         |
| `MICROSOFT_CLIENT_SECRET`       | Microsoft Social OAuth client secret                                                      |
| `APPLE_CLIENT_SECRET`           | Apple Social OAuth client secret                                                          |
| `GITHUB_EMU_CLIENT_SECRET`      | GitHub Enterprise Managed Users OAuth client secret                                       |

Set `BOOTSTRAP_TOKEN` before the first bootstrap. Without it, anyone can call `/admin/bootstrap` against an empty database and claim the initial super admin account.

Write the secrets:

```bash
pnpm --dir apps/server exec wrangler secret put KEK
pnpm --dir apps/server exec wrangler secret put PEPPER
pnpm --dir apps/server exec wrangler secret put BOOTSTRAP_TOKEN
pnpm --dir apps/server exec wrangler secret put TURNSTILE_SECRET
pnpm --dir apps/server exec wrangler secret put CLOUDFLARE_FOR_SAAS_API_TOKEN
pnpm --dir apps/server exec wrangler secret put STRIPE_SECRET_KEY
pnpm --dir apps/server exec wrangler secret put STRIPE_WEBHOOK_SECRET
```

### Social OAuth secret bindings

Social OAuth configuration is split deliberately:

- Organization policy controls whether a provider is enabled and its client id, public endpoints,
  scopes, and claim mapping.
- Deployment configuration controls which Workers Secret contains the client credential. Tenant
  data never selects an arbitrary Env key, and Console shows the resolved binding as read-only.

Built-in provider names always resolve to the five fixed secret names listed above. Add only the
provider credentials you actually enable, for example:

```bash
pnpm --dir apps/server exec wrangler secret put GOOGLE_CLIENT_SECRET
pnpm --dir apps/server exec wrangler secret put GITHUB_CLIENT_SECRET
```

For a custom provider, set the non-secret Workers variable
`SOCIAL_PROVIDER_SECRET_BINDINGS` to a JSON object whose keys are provider names and whose values
match `SOCIAL_<NAME>_CLIENT_SECRET`, then create that named Workers Secret separately:

```text
SOCIAL_PROVIDER_SECRET_BINDINGS={"acme":"SOCIAL_ACME_CLIENT_SECRET"}
```

```bash
pnpm --dir apps/server exec wrangler secret put SOCIAL_ACME_CLIENT_SECRET
```

The map does not create a secret and must never contain the credential value. Invalid JSON, invalid
provider names, or mappings to unrelated bindings such as `KEK` are ignored and the provider remains
unavailable.

This repository never commits a `.env` file or any secret value.

### Optional Stripe billing adapter

Stripe is an optional adapter for operators that sell a managed XID service. It is not a license
check or a self-hosting feature gate: leaving every `STRIPE_*` value unset keeps the complete
MIT-licensed product available and disables only Checkout, Billing Portal, webhook reconciliation,
and Stripe MAU reporting.

The complete adapter configuration is:

| Name                         | Kind               | Purpose                                                        |
| ---------------------------- | ------------------ | -------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`          | Workers Secret     | Stripe REST API credential                                     |
| `STRIPE_WEBHOOK_SECRET`      | Workers Secret     | Verifies the raw body of `POST /v1/billing/stripe/webhook`     |
| `STRIPE_STARTER_PRICE_ID`    | Variable or secret | Checkout price for the `starter` accounting plan               |
| `STRIPE_PRO_PRICE_ID`        | Variable or secret | Checkout price for the `pro` accounting plan                   |
| `STRIPE_ENTERPRISE_PRICE_ID` | Variable or secret | Checkout price for the `enterprise` accounting plan            |
| `STRIPE_METER_EVENT_NAME`    | Variable or secret | Stripe Billing meter event name used by the daily MAU reporter |

Checkout and Portal creation remain disabled until both secrets are present. Each plan button also
requires its matching price id. Configure the Stripe webhook destination as the public HTTPS
endpoint `https://<your-domain>/v1/billing/stripe/webhook`; Core validates Stripe's timestamped HMAC
before parsing JSON, deduplicates event ids, and prevents older events from reverting a newer plan.
The daily Cron stores the exact meter identifier, customer, value, event name, and timestamp in D1
before calling Stripe, so a crash between provider acceptance and local completion retries the same
idempotent payload.

Repository tests prove the local signature, ordering, deduplication, and retry contracts. A real
Stripe product, price, customer, webhook delivery, Checkout, Portal, and meter-event run remain L4
`UNKNOWN` until the operator supplies those external resources and records live evidence.

### Outbound SCIM target secrets

Create the target first with `provider` and a public HTTPS `base_url`. The response and Console show
`requiredTokenSecretName`, for example `SCIM_TARGET_TOKEN_550e8400_e29b_41d4_a716_446655440000`.
Write the downstream bearer token only to that exact Workers Secret:

```bash
pnpm --dir apps/server exec wrangler secret put SCIM_TARGET_TOKEN_550e8400_e29b_41d4_a716_446655440000
```

The API deliberately rejects `token_secret_ref`. Tenant-controlled data cannot select `KEK`,
`PEPPER`, provider secrets, or any other Worker binding. Refresh the target list and require
`hasTokenSecret=true` before starting a sync. The secret must be configured separately in every
deployment environment.

### Turnstile readiness

Create one Turnstile widget and add the instance apex hostname to its hostname allowlist. Cloudflare
authorizes that hostname and its subdomains, so the same widget covers tenant Hosted Auth hosts.
Configure its public site key as the Core Worker runtime variable
`TURNSTILE_SITE_KEY`, and write its secret as `TURNSTILE_SECRET`. The application accepts only the
complete pair: both absent disables Turnstile for development, while either value missing returns a
server configuration error. Hosted Auth obtains only the public key from `/auth/config`; the secret
never reaches HTML or JSON. The client renders the official script from
`https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`, and Siteverify requires the
expected action in addition to `success=true`.

After configuration, verify password, magic-link, OTP-send, passkey, social, enterprise SSO, guest,
and forgot-password paths on a real allowed hostname. Repository tests do not prove hostname or
widget settings in the Cloudflare account. Goal readiness checks the public site key returned by
`/auth/config` and the existence of the `TURNSTILE_SECRET` binding as two separate requirements; it
lists secret names only and never reads a secret value.

### Edge WAF and rate-limit reconciliation

The versioned expected zone policy is
[`deployment/cloudflare-security-rules.v1.json`](./deployment/cloudflare-security-rules.v1.json),
validated offline against
[`deployment/cloudflare-security-rules.schema.json`](./deployment/cloudflare-security-rules.schema.json).
It is deliberately compatible with the Cloudflare Free WAF plan: one custom rule out of the five
available slots, one rate-limiting rule, a Path-only rate expression, an IP counter, and 10-second
counting and mitigation periods. The rate rule is a coarse edge shield. `RateLimitStore` remains the
fail-closed, strongly consistent authority for exact identity-flow and tenant policy limits.

The manifest is an expected-state document, not a direct API request body. Its local `key`, plan,
source, and deployment metadata are not Cloudflare rule fields. For the hosted `xid.dev` zone,
read-only inspection currently shows the Free Managed Ruleset and platform DDoS/normalization
controls, but no user custom WAF or rate-limiting rules. Therefore the committed state remains
`EXTERNAL`; this repository does not claim that these expected rules are active.

Reconcile without mutating the zone:

1. In the Cloudflare dashboard or an authenticated Cloudflare MCP session, read the zone phase entry
   points `http_request_firewall_custom` and `http_ratelimit`.
2. Normalize each live rule to `description`, `expression`, `action`, `enabled`, and `ratelimit`.
   Ignore provider-assigned ids, versions, and timestamps.
3. Compare the normalized rules with the two manifest rules. Missing, additional, disabled, or
   changed rules are `FAIL`; keep `deploymentState=EXTERNAL`.
4. Creating, enabling, changing, or deleting a rule is a separate, explicitly authorized external
   operation. Workers Builds does not manage these zone rules.

The repository intentionally has no WAF apply script and does not read `CLOUDFLARE_API_TOKEN`.
Use the operator's existing dashboard or MCP authentication for the read-only comparison. Plan
limits and parameters are documented by Cloudflare at
`https://developers.cloudflare.com/waf/custom-rules/`,
`https://developers.cloudflare.com/waf/rate-limiting-rules/`, and
`https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/`.

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

### Invitation token cutover in migration 0006

Migration `0006_expire_legacy_invitation_tokens.sql` is an explicit security cutover. Invitation
tokens issued before the tenant-bound `xid_inv_v1` format have no recoverable Tenant locator because
D1 stores only the complete token hash. Resolving one from the Instance apex would require a
forbidden cross-Tenant hash lookup, so those capabilities cannot be transparently carried forward.

The migration adds `invitations.token_version`, marks every pre-cutover `pending` invitation as
`revoked`, and keeps those rows for an auditable resend list. Query revoked invitations through the
tenant-scoped Management API, or record the pending list before the release, then resend them after
Core is on the new revision. Do not update those rows back to `pending`: their plaintext token cannot
be recovered and a replacement invitation must mint a new capability.

Core migrations run before the Worker deploy. During that short overlap, the previous Worker does
not know how to write `token_version`; a migration trigger rejects its legacy pending insert before
that implementation reaches `EMAIL_QUEUE.send`. The new Worker explicitly writes `locator_v1` and
commits the invitation and notification outbox in one D1 batch. Invitation creation can therefore
return an error during the overlap, but it never emails a newly invalid link. A rollback to code
older than this cutover keeps
invitation creation disabled by that trigger; roll forward instead. Existing accepted, revoked, and
expired invitation history is not changed.

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
- Those relational resources are committed in one D1 batch transaction. Any statement failure rolls back the complete bootstrap, so the same request can be retried instead of being blocked by a partial `instances` row.
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

### Cloudflare Workers Builds

Connect three Cloudflare Workers Builds projects to the same repository. Each project deploys one
Worker directly from the reviewed `main` commit. GitHub Actions remains CI only and does not deploy.

Dashboard -> Worker -> Settings -> Builds:

| Worker      | Root directory | Build command                                                       | Deploy command                                                                                            |
| ----------- | -------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Core        | `apps/server`  | `node scripts/assert-migration-compatibility.mjs && pnpm run build` | `pnpm exec wrangler d1 migrations apply DB --remote --config wrangler.jsonc && pnpm exec wrangler deploy` |
| Console     | `apps/console` | `pnpm run build`                                                    | `pnpm exec wrangler deploy`                                                                               |
| Nimbus Site | `apps/site`    | `pnpm run build`                                                    | `pnpm exec wrangler deploy`                                                                               |

Core sets `keep_vars=true` in both the source `apps/server/wrangler.jsonc` and the Cloudflare Vite
plugin's programmatic config in `apps/server/vite.config.ts`. This duplication is intentional:
Cloudflare's Vite plugin redirects plain `wrangler deploy` to the generated
`apps/server/dist/xid/wrangler.json` deployment snapshot, so the source Wrangler file alone is not
the effective deployment config. The Core build fails unless that generated snapshot contains
`keep_vars=true`.

This is required because the Workers Builds deploy command intentionally stays a plain
`wrangler deploy`, while optional non-secret dashboard variables such as `TURNSTILE_SITE_KEY`,
`EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME`, `CLOUDFLARE_FOR_SAAS_ZONE_ID`,
`CLOUDFLARE_FOR_SAAS_CNAME_TARGET`, and Stripe price ids may not be declared in the repository.
Wrangler otherwise removes dashboard variables that are absent from the configuration. Secrets are
preserved independently by Wrangler and are not read by the build. Values explicitly declared under
Wrangler `vars` remain repository-controlled.

Apply the same branch policy to all three projects:

- Production branch: `main`
- Non-production branch builds: disabled
- Worker Preview URLs: disabled through `preview_urls=false` in every Wrangler configuration
- Build watch paths: `*`, so every reviewed `main` commit converges all three Workers on the same
  source revision

Do not configure feature-branch preview builds or `wrangler versions upload`. Do not enable Worker
version or alias Preview URLs either. A non-`main` commit is validated by GitHub Actions and does not
create a Cloudflare build or a public preview URL.

The three production builds run independently. This is safe because route ownership is committed in
the Wrangler configurations, Console and Site have no Core bindings, and the Core migration
compatibility gate requires D1 changes to work across the deployment boundary. A change that needs
an atomic order across Workers must be redesigned before merge.

For the first deployment, create data bindings and secrets first, deploy Nimbus Site and Console,
then enable the Core build after both Service Binding targets exist. After all three Workers have one
successful deployment, every later push to `main` uses the same independent build flow.

Before merging a change that adds or renames a Queue in `wrangler.jsonc`, run
`pnpm run cloudflare:queues:create` once against the target account, then require
`pnpm run cloudflare:queues:check` to pass. Workers Builds deploys bindings and consumers but does
not create the Queue resources themselves; a missing Queue would make the Core deployment fail
before replacing the previous Worker.

### Rollback

Roll back the affected Worker from its Cloudflare Deployments page. A code rollback does not reverse
D1 migrations, so database changes remain forward-compatible and are corrected with a new
migration. Route patterns are part of the Worker configuration and must remain stable across a code
rollback.

After a rollback, verify Core health and protocol routes, the Nimbus root and agent surfaces, and
Console navigation on both apex and tenant hosts.

### Do not deploy by hand

Production releases go through Cloudflare Workers Builds from `main`. **Do not run `wrangler deploy`
or production route mutations locally.** A local deployment bypasses the repository gates and
breaks the commit-to-deployment record.

The repository does not store a Cloudflare deployment token and GitHub Actions does not need one.
Cloudflare uses the repository connection configured on each Workers Builds project.

### CI

`.github/workflows/ci.yml` triggers on `pull_request`, on `push` to `main`, and on manual `workflow_dispatch`. It defines six jobs, all on `ubuntu-latest`, and every one of them starts with `pnpm install --frozen-lockfile`:

| Job                               | Runs on                                | Command after install                                                                         |
| --------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `check`                           | every trigger                          | `pnpm check`                                                                                  |
| `test`                            | every trigger                          | `pnpm test`                                                                                   |
| `build`                           | every trigger                          | `pnpm build`                                                                                  |
| `smoke`                           | every trigger **except pull requests** | `pnpm build`, `pnpm smoke:three-workers`, `pnpm smoke:l2-l3`, after verifying headless Chrome |
| `security`                        | every trigger                          | `pnpm run security:secret-scan`                                                               |
| `dependency audit (non-blocking)` | every trigger **except pull requests** | `pnpm run security:dependencies`, that is `pnpm audit --prod --audit-level high`              |

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
curl -fsSI https://<your-domain>/sdks/llms.txt
curl -fsSI https://<your-domain>/sdks/llms-full.txt
curl -fsSI https://<your-domain>/docs/getting-started
curl -fsSI https://<your-domain>/scim/v2/ServiceProviderConfig
curl -fsSI 'https://<your-domain>/?source=preflight'
curl -fsSI 'https://<your-domain>/getting-started?source=preflight'
curl -fsSI 'https://<your-domain>/llms.txt?source=preflight'
curl -fsSI 'https://<your-domain>/console?source=preflight'
curl -fsSI 'https://<tenant>.<your-domain>/auth/config?source=preflight'
curl -fsSI 'https://<tenant>.<your-domain>/console?source=preflight'
curl -fsSI 'https://www.<your-domain>/docs?locale=en'
```

The Markdown and MDX responses must use `text/markdown; charset=utf-8`; LLM responses must use
`text/plain; charset=utf-8`. The legacy docs response must be a 308 to
`https://<your-domain>/getting-started`, while the SCIM protocol response must still come from
Core. Open `https://<your-domain>/getting-started` in a browser and
confirm the authorization Mermaid diagram renders, re-renders after a light or dark theme change,
and opens and closes its full-screen dialog.

Local build, unit, integration, and Miniflare evidence remains L0-L3. Do not call the deployment L4
verified until the live account has exercised real Email delivery, all Queue and DLQ paths, R2
privacy export and erasure retention, both Cron schedules, Analytics writes, Turnstile when enabled,
and Cloudflare for SaaS hostname activation when enabled. Any unexercised item remains `UNKNOWN`.

The repository also ships a set of `pnpm smoke:production*` scripts. Read them as maintainer tooling
for the hosted instance rather than as a self-hosting verification step. The production harness pins
the hosted Cloudflare targets, while D1 probes target Core. Running them against your own deployment
means changing those pins to your own three Workers first, then pointing
`XID_PRODUCTION_TENANT_ID` at your default organization and `XID_PRODUCTION_EMAIL` at a mailbox you
control.

`pnpm smoke:production` covers Core health, Nimbus public docs, internal docs 404, exact Site and
Console routes with query strings, wildcard tenant-host DNS and routing, the Hosted Auth entry, the
default auth config, the default profileFields, the root resolver, the default organization
bootstrap shape, the default authentication policy gate, the Magic Link verify route gate, the
forgot-password disabled gate, root discovery and JWKS. It targets
`https://default.xid.dev` for the hosted tenant entry by default; a self-hosted operator may set
`XID_PRODUCTION_TENANT_BASE_URL` to that deployment's default tenant origin.

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

The organization policy may select a provider and sender, but provider secret binding names are fixed
by the deployment. Console renders them read-only, and the API rejects a caller-supplied binding that
does not match the fixed provider contract.

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
domain has been onboarded on **your** account. XID falls back to `no-reply@xid.dev` for the upstream
hosted product. A self-hosted deployment must override that fallback through the non-secret Workers
variables below; no source edit is required.

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

3. Configure the Core Worker non-secret variables in Cloudflare Dashboard -> Settings -> Variables,
   or in your deployment-specific Wrangler `vars`:

   ```text
   EMAIL_FROM_ADDRESS=no-reply@<your-domain>
   EMAIL_FROM_NAME=XID
   ```

   `EMAIL_FROM_ADDRESS` is trimmed and validated as an email address.
   `EMAIL_FROM_NAME` is trimmed, limited to 100 characters, and rejects line breaks. Invalid values
   fail closed before provider delivery. Both variables are ordinary runtime configuration, never
   Workers Secrets.

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

For production queues, cron, email, D1 and R2, the Cloudflare dashboard and Worker telemetry are the
source of truth. All three Worker configurations explicitly disable invocation logs because
Cloudflare includes the raw request URL in them. Automatic request traces are also disabled on all
three because automatic Fetch spans persist `url.full`, which can contain OAuth codes or one-time
authentication tokens. Application logs are structured and redact exception messages, stacks,
causes, cookies, Authorization, IPs, URLs/queries, provider payloads, and user identifiers. Core,
Site, and Console production logs sample 10%; Core staging logs sample 100%. Workers Logs retention
is 3 days on Free and 7 days on Paid, with an overall maximum of 7 days. Current read-only evidence
identifies the hosted account as Free, so its expected retention is 3 days; the active account plan
and deployed retention remain `EXTERNAL` until reconciled there. See
`https://developers.cloudflare.com/workers/observability/logs/workers-logs/`.

Before a production-readiness claim, verify in the active Cloudflare account:

1. The deployed settings match all three `apps/*/wrangler.jsonc` policies.
2. Only the incident-response role can query Workers Logs.
3. No Logpush destination extends retention unless its destination, access control, deletion policy,
   and field allowlist have a separate review.
4. Alerts exist for Worker exceptions, Queue backlog/DLQ growth, scheduled handler failures, and
   authentication error-rate regressions.
5. A sampled event contains only the fields emitted by `worker/lib/safe-log.ts`; search for
   `authorization`, `cookie`, `token`, `password`, `SAMLResponse`, `code=`, `email`, and `phone`
   before approving the release.

Cron can be exercised locally through the dev scheduled dispatch:

```bash
pnpm --filter @xid-kit/server dev
```
