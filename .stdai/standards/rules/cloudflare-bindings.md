---
type: rules
name: cloudflare-bindings
description: Cloudflare binding roles - D1 relational, Durable Objects for strong consistency, KV cache, R2 objects, Queues async, plus audit / email / metering pipeline invariants
priority: high
applyTo:
  - 'apps/server/worker/**/*.ts'
  - 'wrangler.toml'
  - 'wrangler.jsonc'
  - '**/durable-objects/**/*.ts'
targets: [claude-code, codex]
---

# Cloudflare Service Mapping and Usage Boundaries

Picking the wrong store is a correctness or latency bug. Design source `docs/design/00-overview.md`
section 8. Binding names are declared in `apps/server/wrangler.jsonc` and typed in
`apps/server/worker/env.d.ts`; the reusable type-only contract is
`packages/types/src/cloudflare.d.ts`. Queue messages and optional provider configuration stay in
`packages/types/src/env.ts` -- use those sources, never invent.

## Selection rules (MUST)

- **Strong consistency, replay protection, serialization -> Durable Objects**: challenges, OAuth
  state/nonce/PKCE, PAR, device flow, session revocation sets, rate limiting, audit sequence,
  metering. Short-lived strongly consistent data MUST NOT go into D1 tables.
- **Read-heavy caching -> KV**: JWKS, discovery and protected-resource metadata, branding, feature
  flags, upstream provider JWKS, trust anchors. TTL constants live in
  `apps/server/worker/lib/ttl.ts` -- never an inline literal.
- **Async work off the critical path -> Queues**: email, SMS, WhatsApp, audit persistence, webhooks,
  metering, outbound SCIM, and privacy export/erasure. The login path MUST NOT synchronously await any
  of them.
- **Large objects -> R2**: org logos, email locale packs, private privacy exports, and compliance
  artifacts. Avatars, unrelated export files, and the GeoIP MMDB are reserved and NOT implemented.
- There is no Cloudflare Rate Limiting or WAF binding; application rate limiting runs entirely
  through the `RATE_LIMITER` Durable Object.

## Pipeline invariants (MUST)

- Audit rows are INSERT only -- never UPDATE, never DELETE. `AuditSeqDO` is the single committer of
  the per-tenant hash chain and the audit consumer runs `max_concurrency: 1`; do not add a second
  writer or raise that concurrency.
- Transactional email MUST go through the `EmailProvider` abstraction in
  `apps/server/worker/queues/email.ts`, never a concrete provider call.
- Metering MUST NOT fail the auth path: a failed queue send falls back to D1 `metering_outbox`. MAU
  deduplication is exact via `MeteringDO`; **HyperLogLog is NOT used**.

Binding names, DO classes, queue settings, message shapes, cron jobs: reference
`cloudflare-binding-inventory` -- read before any `env.<BINDING>` access. KV keys and TTLs, R2
status, session layering, audit chain, email and metering pipelines: reference
`cloudflare-storage-playbook`.
