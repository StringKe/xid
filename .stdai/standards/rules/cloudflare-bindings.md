---
type: rules
name: cloudflare-bindings
description: Cloudflare binding roles and boundaries - D1 relational, Durable Objects for strong consistency, KV cache, R2 objects, Queues async, Secrets, Analytics Engine
priority: high
applyTo:
  - 'apps/server/worker/**/*.ts'
  - 'wrangler.toml'
  - 'wrangler.jsonc'
  - '**/durable-objects/**/*.ts'
targets: [claude-code, codex]
---

# Cloudflare Service Mapping and Usage Boundaries

Every storage/service has one job. Picking the wrong one is a correctness or latency bug, not a style
preference. Design source: `docs/design/00-overview.md` section 8. Binding names are declared in
`apps/server/wrangler.jsonc` and typed in `packages/types/src/env.ts` -- use those names, never
invent new ones.

Exact binding names, the eight Durable Object classes, queue consumer settings, message shapes, and
cron job lists: reference `cloudflare-binding-inventory`. Look there before writing any
`env.<BINDING>` access or adding a queue / cron job.

## Selection Rules (MUST follow)

- **Strong consistency, replay protection, serialization -> Durable Objects**: challenges, OAuth
  state/nonce/PKCE, PAR, device flow, session revocation sets, rate limiting, audit sequence, metering.
  Short-lived strongly consistent data MUST NOT go into D1 relational tables.
- **Read-heavy caching -> KV**: JWKS, discovery and protected-resource metadata, branding, feature
  flags, upstream social provider JWKS, federation trust anchors. TTL constants live in
  `apps/server/worker/lib/ttl.ts` -- add new ones there, never as inline literals.
- **Async work off the critical path -> Queues**: email, SMS, WhatsApp, audit persistence, webhooks,
  metering. The login path MUST NOT synchronously await any of them. Audit writes go through the queue
  so login stays under the P99 budget.
- **Large objects -> R2**: org logos and email locale packs are the only implemented uses. Avatars,
  export files, and the GeoIP MMDB are reserved uses of the same bucket and are NOT implemented yet.
  Do not write code that assumes those objects exist.

There is no Cloudflare Rate Limiting binding and no WAF binding. Application-level rate limiting runs
entirely through the `RATE_LIMITER` Durable Object.

## Pipeline invariants

- Audit rows are INSERT only -- never UPDATE, never DELETE. `AuditSeqDO` is the single committer of
  the per-tenant hash chain, and the audit consumer runs with `max_concurrency: 1`. Do not add a
  second writer and do not raise that concurrency.
- Transactional email MUST go through the `EmailProvider` abstraction in
  `apps/server/worker/queues/email.ts`, never a concrete provider call.
- Metering MUST NOT fail the auth path: a failed queue send falls back to the D1 `metering_outbox`
  table. MAU deduplication is exact via `MeteringDO`; **HyperLogLog is NOT used**.

KV key names and TTLs, R2 implemented-vs-reserved status, session storage layering across D1 /
`SessionDO` / KV, audit chain mechanics, and the email / notification / metering pipelines: reference
`cloudflare-storage-playbook`. Read it before changing any of those pipelines or adding a cache key.
