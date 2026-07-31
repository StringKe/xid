---
type: references
name: cloudflare-binding-inventory
description: The exact binding names declared in wrangler.jsonc - D1, the eleven Durable Object classes, the eight queues with their consumer settings and message shapes, and the two cron expressions with their job lists
---

# Cloudflare binding inventory

Lookup tables extracted from the `cloudflare-bindings` rule. Read this when you need the literal name
of a binding, queue, Durable Object class or cron expression, or the shape of a queue message. All
business bindings below belong exclusively to the Core Worker, are declared in
`apps/server/wrangler.jsonc`, and are typed by `apps/server/worker/env.d.ts`; shared queue and optional
provider configuration contracts live in `packages/types/src/env.ts`, while the reusable type-only
Worker binding contract lives in `packages/types/src/cloudflare.d.ts` -- use those names, never invent
new ones. `apps/site` and `apps/console` each declare only their own `ASSETS` binding. Core also has
the one-way `SITE_WORKER` and `CONSOLE_WORKER` Service Bindings. Cloudflare matches Worker Routes
against the complete URL, so these bindings delegate an exact frontend path that falls through the
Core Custom Domain only because it carries a query string. Neither frontend binds back to Core. The
judgment calls about which service to pick for a given job stay in the `cloudflare-bindings` rule.

## Service Mapping (bindings as declared)

| Service             | Binding                                                                                                                | Purpose                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Core Worker + Hono  | `apps/server`, `main = worker/index.ts`, fallback route `*/*`, `SITE_WORKER`, `CONSOLE_WORKER`                         | Protocol, auth, account, Management API, Cloudflare for SaaS custom hosts, every business binding, exact-query fallback |
| Nimbus Site Worker  | `apps/site`, `ASSETS` only                                                                                             | Static apex documentation plus www canonical redirect; no business API or Core binding                                  |
| Console Worker      | `apps/console`, `ASSETS` only                                                                                          | Static management SPA and narrow redirects; same-host API calls continue to Core                                        |
| D1                  | `DB` (`xid-db`)                                                                                                        | Users, applications, credential metadata, authorization codes, refresh tokens, audit, tenants, key ciphertext, sessions |
| Durable Objects     | 11 bindings (see table below)                                                                                          | Strong consistency, replay protection, serialized writes                                                                |
| KV                  | `CACHE`                                                                                                                | JWKS / discovery / branding config / feature flags                                                                      |
| R2                  | `STORAGE`                                                                                                              | Org logos, email locale packs, private privacy exports, and immutable compliance evidence                               |
| Queues              | 8 producers + 8 source-specific dead letter queues + 8 persistence-failure quarantine queues                           | Email, SMS, WhatsApp, audit persistence, webhook delivery, metering, outbound SCIM, privacy export and erasure          |
| Email Sending       | `EMAIL` (`send_email`)                                                                                                 | Cloudflare Email Service outbound transactional mail; sends to arbitrary external addresses                             |
| Cron Triggers       | `0 * * * *` hourly, `0 2 * * *` daily                                                                                  | Expiry cleanup, key rotation, certificate/domain polling, DAU/MAU aggregation                                           |
| Workers Secrets     | `KEK`, `PEPPER`, provider credentials (`TWILIO_*`, `VONAGE_*`, `INFOBIP_*`, `MESSAGEBIRD_*`, `STRIPE_*`, ...)          | Envelope-encryption master key, password pepper, optional provider credentials                                          |
| Turnstile           | `TURNSTILE_SITE_KEY` (public variable) + `TURNSTILE_SECRET` (secret)                                                   | Atomic form-defense configuration; explicit widget plus Siteverify action validation                                    |
| Cloudflare for SaaS | `CLOUDFLARE_FOR_SAAS_ZONE_ID`, optional `CLOUDFLARE_FOR_SAAS_CNAME_TARGET`, and secret `CLOUDFLARE_FOR_SAAS_API_TOKEN` | Optional custom hostname provisioning, polling and remote-first deletion                                                |
| Stripe              | Secrets `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`; variables `STRIPE_*_PRICE_ID`, `STRIPE_METER_EVENT_NAME`         | Optional Checkout, Billing Portal, signed plan reconciliation and crash-safe MAU reporting                              |
| Analytics Engine    | `ANALYTICS` (`xid_analytics`)                                                                                          | Real-time metrics (login success, MFA adoption, active users)                                                           |

There is no Cloudflare Rate Limiting binding and no WAF binding in `wrangler.jsonc`. Application-level
rate limiting runs entirely through the `RATE_LIMITER` Durable Object. Network-layer WAF and Rate
Limiting rules, if used, are configured in the Cloudflare dashboard, not in code.

The Cloudflare for SaaS group is optional. All three values absent disables its daily maintenance;
any partial required pair fails closed. `ZONE_ID` and `CNAME_TARGET` are non-secret variables.
`API_TOKEN` is a Workers Secret and needs only the provider-zone Custom Hostnames permissions.
The friendly CNAME target is optional; without it the client requires an active fallback origin.
No value or credential is committed to `wrangler.jsonc`.

The Stripe group is also optional. Both Stripe secrets are required before Checkout or Portal
session creation is enabled. Price ids and the meter event name are non-secret variables. Stripe
webhooks enter through the public signed callback at `/v1/billing/stripe/webhook`; the daily job
reports only configured active/trialing customers and persists an exact retry cursor before the
provider call. XID remains fully functional and MIT licensed without this billing adapter.

## Durable Object bindings

| Binding                | Class                  | Responsibility                                                                        |
| ---------------------- | ---------------------- | ------------------------------------------------------------------------------------- |
| `WEBAUTHN_CHALLENGE`   | `ChallengeStore`       | WebAuthn challenges plus atomic TOTP replay claims                                    |
| `OAUTH_STATE`          | `OAuthFlowDO`          | OAuth state / nonce / PKCE plus parked `/authorize` params for unauthenticated users  |
| `PAR_STORE`            | `ParStore`             | RFC9126 PAR, `request_uri` valid 60s, single use, DO name = `tenantId`                |
| `DEVICE_FLOW`          | `DeviceFlowStore`      | RFC8628 device flow, `device_code` and `user_code` stored separately, poll throttling |
| `SESSION_REVOCATION`   | `SessionDO`            | Per-user active session id set, serialized revocation                                 |
| `RATE_LIMITER`         | `RateLimitStore`       | Per-tenant / account / IP rate limit counters in DO SQLite storage                    |
| `AUDIT_SEQ`            | `AuditSeqDO`           | Sole committer of the per-tenant audit hash chain                                     |
| `METERING`             | `MeteringDO`           | Per-tenant exact MAU/DAU deduplication                                                |
| `GUEST_STORE`          | `GuestStore`           | Per-anonymous-session guest mint deduplication                                        |
| `CIBA_STATE`           | `CibaStore`            | Per-`auth_req_id` CIBA state, poll throttling and atomic redemption                   |
| `IMPERSONATION_GRANTS` | `ImpersonationGrantDO` | Two-minute, secret-hash-only, exact-target-host impersonation handoff consumed once   |

The first eight classes are registered in migration `v1`; `GuestStore` is registered in `v2` and
`CibaStore` in `v3`; `ImpersonationGrantDO` is registered in `v4`. All use
`new_sqlite_classes`.

## Queues

| Producer binding | Queue           | Consumer settings                                                                  |
| ---------------- | --------------- | ---------------------------------------------------------------------------------- |
| `EMAIL_QUEUE`    | `xid-email`     | batch 100, timeout 5s, max_retries 5, DLQ `xid-email-dlq`                          |
| `WHATSAPP_QUEUE` | `xid-whatsapp`  | batch 100, timeout 5s, max_retries 5, DLQ `xid-whatsapp-dlq`                       |
| `SMS_QUEUE`      | `xid-sms`       | batch 100, timeout 5s, max_retries 5, DLQ `xid-sms-dlq`                            |
| `AUDIT_QUEUE`    | `xid-audit`     | batch 100, timeout 5s, **max_concurrency 1**, max_retries 5, DLQ `xid-audit-dlq`   |
| `WEBHOOK_QUEUE`  | `xid-webhook`   | batch 50, timeout 5s, max_retries 5, DLQ `xid-webhook-dlq`                         |
| `METERING_QUEUE` | `xid-metering`  | batch 100, timeout 5s, max_retries 5, DLQ `xid-metering-dlq`                       |
| `SCIM_QUEUE`     | `xid-scim-sync` | batch 1, timeout 1s, **max_concurrency 1**, max_retries 5, DLQ `xid-scim-sync-dlq` |
| `PRIVACY_QUEUE`  | `xid-privacy`   | batch 10, timeout 5s, **max_concurrency 1**, max_retries 5, DLQ `xid-privacy-dlq`  |

Each source-specific DLQ has a Core consumer with batch 25, timeout 5s, concurrency 1, retry delay
60s, and 100 persistence retries. Exhaustion moves to the corresponding
`*-dlq-persistence-failures` quarantine queue. The consumer writes redacted metadata and
KEK-envelope ciphertext to `queue_dead_letters`; replay is available only through the verified
Instance Manager platform path.

Message shapes live in `packages/types/src/env.ts` and are camelCase on the wire:
`EmailQueueMessage` / `SmsQueueMessage` / `WhatsappQueueMessage` are `{ type, recipient, payload }`,
`AuditQueueMessage` is `{ tenantId, orgId?, action, actorId?, ts, payload }`,
`WebhookQueueMessage` is `{ tenantId, event, payload }`,
`MeteringQueueMessage` is `{ tenantId, userId, ts }`,
`ScimSyncQueueMessage` is
`{ tenantId, orgId, targetId, issuer, actorId?, runId, requestedAt }`, and
`PrivacyQueueMessage` is
`{ requestId, tenantId, userId, operation: "export" | "delete", requestedAt }`.

## Cron Triggers

Two expressions, dispatched by `dispatchScheduled(cron, env)` in `apps/server/worker/crons/index.ts`.

- `0 * * * *` (`runHourly`): expired session cleanup, expired access-token revocation cleanup, expired
  authorization code cleanup, expired challenge cleanup, metering outbox redelivery, DAU aggregation.
- `0 2 * * *` (`runDaily`): signing key rotation check and `retire_after` backfill, custom hostname
  ownership/SSL/DCV polling and expired ownership cleanup, domain verification polling, SAML IdP
  metadata refresh, monthly usage maintenance (MAU report, current-month snapshot, old-row cleanup),
  expired privacy-export object cleanup, privacy export / due erasure Queue redelivery, safe guest
  onboarding garbage collection, and optional crash-safe Stripe MAU reporting.

The repository owns the incident ledger and public status API. Independent external probing and an
availability-history store are not implemented and MUST NOT be claimed.
