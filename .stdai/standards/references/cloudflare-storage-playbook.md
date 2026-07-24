---
type: references
name: cloudflare-storage-playbook
description: KV key naming and TTLs, which R2 objects actually exist versus reserved, how session state is split across D1 / SessionDO / KV, how the audit hash chain commits, and how email, notification, and metering pipelines run
---

# Cloudflare storage and pipeline playbook

Detail extracted from the `cloudflare-bindings` rule. Read this when you need a concrete KV key name
or TTL, need to know whether an R2 object is implemented or only reserved, or need the mechanics of
the session / audit / email / notification / metering pipelines before touching one of them. The
short "which service for which job" decision list stays in the `cloudflare-bindings` rule; the
version below is the full original text of that list.

## Selection Rules (MUST follow)

- **Strong consistency, replay protection, serialization -> Durable Objects**: challenges, OAuth
  state/nonce/PKCE, PAR, device flow, session revocation sets, rate limiting, audit sequence, metering.
  Short-lived strongly consistent data MUST NOT go into D1 relational tables.
- **Read-heavy caching -> KV**: JWKS (`jwks:{issuer}:{active_kid}`, TTL 3600s), discovery and
  protected-resource metadata (TTL 3600s), branding (`brand:{tenant_id}:{org_id}`), feature flags
  (`flag:{tenant_id}:{flag_name}` for per-org overrides, `flag:global:{flag_name}` for the global
  default), upstream social provider JWKS (`provider_jwks:{jwks_uri}`, TTL 3600s), federation trust
  anchors (TTL 86400s). TTL constants live in `apps/server/worker/lib/ttl.ts` -- add new ones there,
  never as inline literals.
- **Async work off the critical path -> Queues**: email, SMS, WhatsApp, audit persistence, webhooks,
  metering. The login path MUST NOT synchronously await any of them. Audit writes go through the queue
  so login stays under the P99 budget.
- **Large objects -> R2**: org logos (`PUT` on org logo upload, public read served by
  `worker/storage.ts` at `/storage/logos/*`) and email locale packs (`loadR2Template`, falling back to
  the built-in en / zh-Hans templates). Avatars, export files, and the GeoIP MMDB are reserved uses of
  the same bucket and are NOT implemented yet -- `GET /v1/users/export` streams NDJSON directly in the
  response and never touches R2. Do not write code that assumes those objects exist.

## Session Storage

- D1 `sessions` table is the durable record (refresh token hash, device, status, `expires_at`).
- `SessionDO` (per user) holds that user's active session id set. Revocation updates the DO first and
  persists to D1 afterward; the DO serializes all operations for one user so concurrent revokes cannot
  race. An already-issued JWT stays valid for up to its 60s window.
- KV caches JWKS public keys (TTL 1h) so JWT verification reads KV instead of going back to origin.

## Audit Chain

Audit rows are INSERT only -- never UPDATE, never DELETE. Each row carries a monotonically increasing
`seq` plus `prev_hash`, the SHA-256 of the previous entry, forming an append-only chain
(genesis hash is 64 zeros).

`AuditSeqDO` is the single committer per tenant (`audit-seq:{tenantId}`). A Queue batch is not a stable
identity boundary -- retries may split or reorder it -- so the DO persists pending rows keyed by
`source_message_id`, writes D1, and only then advances `next`. Unconfirmed predecessors block their
successors, which guarantees the chain has no duplicates and no gaps. The audit consumer runs with
`max_concurrency: 1` so hashing stays single-threaded and ordered.

## Email Delivery

- Transactional email goes through **Cloudflare Email Service** (`send_email` binding named `EMAIL`):
  `env.EMAIL.send({ to, from: { email, name }, subject, html, text })`. No API key needed; it can send
  to arbitrary external recipients.
- The sending domain MUST be onboarded (`wrangler email sending enable {domain}`) with DKIM / SPF /
  DMARC. Transactional only. Both `html` and `text` are required.
- The provider abstraction is the `EmailProvider` type in `apps/server/worker/queues/email.ts`
  (`{ name, send(input) }`). `CloudflareEmailProvider` is the only implementation wired up --
  `resolveProvider` returns it unconditionally. Resend / SendGrid / SMTP are deliberately not
  configurable paths in this version. The email consumer MUST go through `EmailProvider`, never call a
  concrete provider directly.

## Notifications and Metering

- Notifications are async through Queues: `queue.send({ type, recipient, payload })`. The consumer
  renders the Mustache-subset template (R2 locale pack first, built-in fallback second) and sends via
  `EmailProvider`. Failures retry with exponential backoff up to 5 attempts; exhausted messages land in
  D1 `notification_failures` (and in the `xid-dlq` dead letter queue).
- Metering: on a successful authentication the worker writes `{ tenantId, userId, ts }` to
  `METERING_QUEUE`. If the queue send fails, the event is persisted to the D1 `metering_outbox` table
  and redelivered by the hourly cron -- the auth path never fails because metering is unavailable.
- The metering consumer groups by tenant and routes to `MeteringDO` (`metering:{tenantId}`) for
  serialized deduplication. DO storage holds exact per-user membership keys
  `member:month:{ym}:{userId}` and `member:day:{day}:{userId}` plus a `count:month:{ym}` counter.
  **HyperLogLog is NOT used** -- 0.8% error is unacceptable for billing. `metering_user_index` is a
  leftover table from the abandoned Roaring Bitmap design and has no readers or writers.
- The hourly cron aggregates DAU into `usage_daily`; the daily cron snapshots and reports monthly MAU
  into `usage_monthly` and prunes old rows.
