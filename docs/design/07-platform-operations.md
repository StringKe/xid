# 07 - Platform Operations, Branding, Notifications, Observability, Billing, Compliance

> Chinese version: [`docs/zh-Hans/design/07-platform-operations.md`](../zh-Hans/design/07-platform-operations.md)

## 1. Management console

### Platform operations admin (cross-tenant)

- Global tenant list: cursor-paginated search by name or slug and one-at-a-time status changes are
  implemented. Plan/status/creation-time filters and bulk suspend/resume/delete remain design targets
- Impersonate any active user through one of their active Organization Memberships (recorded in the
  platform audit log)
- Global user search (cross-tenant, with GDPR access controls)
- Global event stream: cursor-paginated aggregation across every tenant is implemented.
  Tenant/event_type/user filters remain design targets
- Queue dead-letter operations: redacted metadata for every business Queue, encrypted replay, and an
  auditable operator action inside the global event page
- System announcement banner: targeted globally, by explicit tenant, or by accounting plan label
- Global feature flags: the catalog and KV-backed global defaults are implemented without a
  redeployment. Writing explicit tenant overrides and deployment-cohort rollouts remains a design
  target. A plan label is never an authentication feature gate
- Resource quota management: view and manually adjust a single tenant's quota
- Instance default policy (`/v1/platform/settings`): every sessionPolicy field (idleTimeoutMin,
  default 4320 minutes, bounds 5-43200; absoluteTimeoutDays, default 30 days, bounds 1-365;
  rememberMeDefault) plus every tokenPolicy field (accessTokenTtlSec, default 3600s, bounds 60-86400;
  sessionTokenTtlSec, default 60s, bounds 30-300; refreshIdleTimeoutDays, default 30 days, bounds
  1-365; refreshAbsoluteTimeoutDays, default 7 days, bounds 1-90). The org side overrides field by
  field through `/v1/organizations/:id/auth-policy` (null means inherit)
- Billing overview: current-month DAU/MAU for every tenant, overdue and overage status, and a direct
  link to Stripe
- Plan accounting: change a billing label, trial dates, default quotas, and support label. It never
  generates a license or unlocks an authentication capability
- Global alert rules are a design target. There is no current alert-rule API or PagerDuty/Slack
  delivery path; live notification destinations remain deployment state and are `UNKNOWN` until
  verified
- Status page management: publish and update incidents

Design decisions: the platform admin and tenant admin share one unified React Console product, one
Management API, and one RBAC model. Its static assets deploy through the separate Console Worker,
while every management endpoint and authorization decision remains in Core. The platform view's main
entry point is `/console/platform/*`, authorized by the `instance_manager` ManagerAssignment rather
than by a business access token claim. There is no second platform-admin SPA, admin API, admin tenant,
or admin RBAC. `/platform-admin/*` is not a compatibility entry point. Cross-tenant management goes
through the `/v1/platform/*` platform management paths and the platform view inside the unified
Console; tenant management continues through `/v1/organizations/:orgId/*` and the org Console.
Impersonation start returns a two-minute, consume-once opaque handoff for the exact target
Organization host. The handoff is submitted in a POST body and exchanged there for a 15-minute
HttpOnly impersonation cookie. This is not a bearer token: the cookie can only read `/v1/*` with
`GET`, `HEAD`, or `OPTIONS`, plus explicitly end impersonation. Protocol, auth, SSO, session-token
exchange, and every mutation path reject it. The implemented feature-flag API reads and writes the
global default key
`flag:global:{flag_name}` and reports the count of any existing
`flag:{tenant_id}:{flag_name}` keys. The repository does not currently expose a writer for those
tenant override keys or a deployment-cohort model. Those rollout modes remain design targets and
MUST NOT derive authentication behavior from a plan label.

### Tenant admin (single-tenant self-management)

Dashboard (DAU/MAU trends, sign-in success rate, MFA adoption, active orgs), user management,
application management (OAuth2 clients), SSO connections, organization management, team members
(Owner/Admin/Member roles), branding, notification settings, audit log, billing usage, and
compliance tooling.

Design decisions: the tenant admin pages and platform admin pages belong to the same unified React
Console Worker. The Worker serves only static assets and owns `/console` and `/console/*` on both the
apex and tenant hosts. It has no D1, KV, R2, Durable Object, Queue, secret, protocol, or Management API
binding. Tenant management APIs use `/v1/organizations/:orgId/*` and the related `/v1/*` tenant
resource paths in Core, with tenant_id and org_id resolved from `TenantContext` and the protected path
rather than trusted from the request body. An Org Admin can manage only their own org; an Instance
Manager manages any org through the platform management paths or the instance manager override in the
same org Console. Organization Membership is the fixed Owner/Admin/Member contract: Owner and Admin
can enter the org management Console, while Member uses the account portal. `org_manager` is a
ManagerAssignment role, not a fourth Membership role, and has the same org-management access as
Owner.

The Console keeps the request host. Same-origin `/v1/*` and `/auth/*` requests therefore reach Core,
and host-only `__Host-` cookies continue to work on the apex and tenant hosts. Navigation to sign-in,
MFA, and account pages is a full document navigation across the Worker boundary. More-specific
Cloudflare Worker Routes select Console paths over the Core Custom Domain and tenant wildcard
fallback; there is no front proxy.

## 2. Branding customization

Implementation status: the authenticated Management API currently stores seven organization-scoped
KV fields (`primaryColor`, `backgroundColor`, `accentColor`, `borderRadius`, `fontFamily`, `logoUrl`,
and `logoDarkUrl`). Hosted Auth runtime application, tenant-wide fallback, custom CSS, layout
templates, preview/publish state, and per-organization email template upload remain design targets.

- Theme: primary/background/accent color, border radius, and font family (Google Fonts or a custom
  CDN)
- Logo: light and dark variants (PNG/SVG stored in R2), switched by `prefers-color-scheme`
- Custom CSS: an advanced override, subject to a CSP allowlist, with external scripts forbidden
- Sign-in page: layout templates (centered/split/card), a custom background image, and the option to
  hide the XID attribution
- Email template customization (see section 3)
- Multi-brand (per-org): each org can override the logo, colors, and background independently, read
  from KV by org_id and falling back to the tenant-wide setting

Design decisions: branding configuration uses the KV keys `brand:{tenant_id}` and
`brand:{tenant_id}:{org_id}`, read by the login Worker before rendering with a P50 under 2 ms. Custom
CSS is capped at 50 KB and allowlist-filtered to pure CSS only, with `@import` and external `url()`
references forbidden. The editor offers a live preview (in a sandboxed iframe), and preview and publish
are separate operations.

## 3. Notification system

Implementation status: the email Queue currently produces and renders five transactional types:
email verification, magic link, OTP, password reset, and organization invitation. Email-change
confirmation, new-device sign-in alerts, account-lockout notifications, administrator invitations,
and subscription/billing alerts remain design targets. SMS supports OTP and magic-link short links.

The only implemented email provider is **Cloudflare Email Service**, through the `send_email`
binding. Resend, SendGrid, bring-your-own SMTP, tenant-level provider selection, and per-email-type
provider selection remain design targets. Whether a deployment has onboarded a sending domain and
has sufficient live quota remains `UNKNOWN` until that Cloudflare account is verified.

Design decisions:

- Every notification is sent asynchronously through Queues. The business Worker calls
  `queue.send({type, recipient, payload})`, and the consumer renders the template and calls the
  provider. Failures retry with exponential backoff up to 5 times, and dead letters go to the D1
  `notification_failures` table
- The template engine is a Mustache subset (`{{var}}` plus `{{#if}}`), which runs on Workers with no
  Node dependency, scoped to user/org/brand/action
- The provider boundary is abstracted as an `EmailProvider` interface
  (`send({to, from, subject, html, text})`), but the current consumer always resolves
  `CloudflareEmailProvider`. Tenant and per-email-type selection are design targets
- SMS: Twilio (primary) and Vonage (backup) behind a single adapter

### 3.1 Cloudflare Email Service (the default email channel)

Cloudflare Email Service (2025, Email Sending) can send transactional email from a Worker to **any
external recipient address**, unlike the older Email Routing, which only forwarded to verified
addresses. The five implemented XID transactional email types (verification, magic link, OTP,
password reset, and organization invitation) go through this channel.

- **Binding**: add `"send_email": [{ "name": "EMAIL" }]` to `wrangler.jsonc`, then call
  `env.EMAIL.send({ to, from: { email, name }, subject, html, text })` inside the Worker. No API key is
  required.
- **Sending domain**: the `from` domain MUST be onboarded first
  (`wrangler email sending enable {domain}`) with DKIM, SPF, and DMARC verified; after onboarding you
  can send from `anything@{domain}`. Each multi-tenant custom domain is onboarded separately.
- **Restrictions**: transactional only (bulk and marketing are forbidden); both `html` and `text`
  versions are required (which lowers the spam score); recipients MUST be real addresses (bounces hurt
  sender reputation). Quotas and pricing are in the Cloudflare Email Service documentation.
- **Provider abstraction**: `CloudflareEmailProvider` implements the `EmailProvider` interface and
  wraps `env.EMAIL.send`. Resend, SendGrid, and SMTP implementations are design targets and are not
  present in the current consumer.
- **Deliverability**: depends on the sending domain's SPF, DKIM, and DMARC configuration; bounce and
  suppression handling follows the Cloudflare Email Service deliverability guidance.

## 4. Internationalization (i18n)

- The sign-in page UI runs entirely on i18n keys, with 8 locales in the first release (en, zh-Hans,
  ja, ko, fr, de, es, pt-BR, all fully translated); 40+ languages are a later plan
- Nimbus Site publishes the documentation hub and details in the same 8 locales. English uses
  the canonical apex paths, and the other 7 locales use locale-prefixed canonical paths with
  matching hreflang, sitemap, Pagefind, Markdown, and LLM output
- Email templates are versioned by language and selected by `user.locale`
- Error messages are localized, and API error messages carry a locale
- Locale management: an Instance Manager can set one instance `defaultLocale` through
  `/v1/platform/settings`. Per-tenant enabled/disabled locale sets remain a design target
- Global email language-pack JSON can live in R2 and is loaded on demand. Preloading the top 5 packs
  and tenant-specific language-pack management remain design targets

Design decisions: the locale detection priority is `?locale=` -> `user.locale` -> `Accept-Language` ->
the tenant default -> `en`; a missing string falls back to `en` and never displays the key name.
Tenant-uploaded custom language packs that override terminology for white-labeling (a per-tenant R2
path) have not started -- the R2 language packs are at a global path and there is no upload endpoint.

## 5. Audit log

Event types (roughly 60+, grouped by domain): authentication, user lifecycle, organization,
application, SSO, administrator operations, security (brute_force_blocked, impossible_travel,
new_device), and billing.

- Query: the platform-wide and organization-scoped endpoints currently provide cursor pagination
  only. Filters for event_type, actor_id, target_id, IP, time range, and tenant remain design targets
- Export: asynchronous CSV/JSON export through a Queue into R2 with a signed URL remains a design
  target; no current route or consumer implements it
- Retention: `audit_events` has no tier-based cleanup path. Query or export windows may be service
  labels, but they never authorize UPDATE or DELETE of a row in the active append-only chain.
  Deployment-level archival and statutory retention outside that chain are deployment state and
  remain `UNKNOWN` until verified
- Tamper evidence: the application write path is INSERT-only. A monotonically increasing seq plus the
  previous record's SHA-256 chained hash in prev_hash detects mutation, deletion, and gaps. The
  current D1 schema has no trigger or table-level privilege that prevents UPDATE or DELETE, so
  database access control is deployment state and remains `UNKNOWN` until verified
- SIEM integration through HMAC-SHA256 webhooks and prebuilt Splunk, Datadog, Elastic, and Panther
  templates remains a design target

Current implementation: producers enqueue to `xid-audit`, keeping the D1 append off the request
critical path; live sign-in P99 remains deployment evidence and is `UNKNOWN` until measured. The
consumer walks each received batch sequentially and sends one message at a time to the tenant-sharded
`AuditSeqDO.append()` path. The Durable Object persists one pending row, inserts and confirms that
row in D1, and only then advances `next` and `last_hash`. `source_message_id` makes crash recovery and
Queue retry idempotent. The queue uses `max_concurrency: 1` and 5 retries.

### 5.1 Audit chain implementation spec

#### 5.1.1 Audit event D1 schema

```sql
CREATE TABLE audit_events (
  seq         INTEGER  NOT NULL,  -- per-tenant monotonic counter issued by AuditSeqDO, sharded by audit-seq:{tenant_id}
  id          TEXT     NOT NULL,  -- deterministic SHA-256 of tenant_id and source_message_id
  source_message_id TEXT,         -- stable Queue/outbox identity; unique per tenant when present
  tenant_id   TEXT     NOT NULL,
  org_id      TEXT,               -- nullable (platform-level events)
  event_type  TEXT     NOT NULL,  -- see the enumeration in 5.1.5
  actor_id    TEXT,               -- the acting user_id, or system
  actor_ip    TEXT,
  target_type TEXT,               -- the type of resource acted upon
  target_id   TEXT,
  meta        TEXT     NOT NULL,  -- JSON string, extra business fields
  occurred_at TEXT     NOT NULL,  -- ISO 8601 UTC with millisecond precision, e.g. 2025-01-15T10:30:00.123Z
  prev_hash   TEXT     NOT NULL,  -- the previous record's hash; 64 zeros for the first record
  hash        TEXT     NOT NULL,  -- this record's hash (see 5.1.2)
  PRIMARY KEY (tenant_id, seq)
);
CREATE INDEX idx_audit_tenant_time ON audit_events(tenant_id, occurred_at);
CREATE INDEX idx_audit_actor ON audit_events(tenant_id, actor_id);
CREATE INDEX idx_audit_type ON audit_events(tenant_id, event_type);
CREATE UNIQUE INDEX audit_events_tenant_source_message_id_unq
  ON audit_events(tenant_id, source_message_id)
  WHERE source_message_id IS NOT NULL;
```

Application code treats `audit_events` as INSERT-only and exposes no UPDATE or DELETE path. The
current schema does not enforce that rule with a trigger or table-level privilege. The chain
verification endpoint detects mutation or deletion; prevention by production access policy is
deployment state and remains `UNKNOWN` until verified.

#### 5.1.2 Hash computation specification

The hash input is the following fields concatenated in a fixed order as a UTF-8 byte string.
**JSON serialization is deliberately not used**, which avoids ambiguity from field ordering and
whitespace:

```
input = seq + "|" + id + "|" + tenant_id + "|" + (org_id ?? "") + "|"
      + event_type + "|" + (actor_id ?? "") + "|" + (actor_ip ?? "") + "|"
      + (target_type ?? "") + "|" + (target_id ?? "") + "|"
      + meta_canonical + "|" + occurred_at + "|" + prev_hash
```

`meta_canonical` is the canonical form of the meta JSON: the object's keys sorted ascending by UTF-16
code unit, whitespace removed, and numbers left with no extra precision changes (that is, a plain
`JSON.stringify` with sorted keys). Implementation:

```typescript
function canonicalizeMeta(meta: Record<string, unknown>): string {
  const sorted = Object.fromEntries(
    Object.entries(meta).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )
  return JSON.stringify(sorted)
}
```

Hash computation:

```typescript
async function computeAuditHash(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('') // 64 lowercase hexadecimal characters
}
```

The first record (genesis) has
`prev_hash = "0000000000000000000000000000000000000000000000000000000000000000"` (64 zeros).

#### 5.1.3 Single-message append and seq generation

**Current approach: `AuditSeqDO.append()`, sharded by tenant_id.**

The Durable Object name is `audit-seq:{tenant_id}`. The consumer passes one event and its stable
`source_message_id` to `append()`. The Durable Object initializes `next` and `last_hash` from its own
storage, or from the latest persisted D1 row when its storage has not been initialized. It then:

1. Finds an already persisted row by `(tenant_id, source_message_id)` and commits that result if a
   prior attempt reached D1.
2. Rejects a different message as `blocked` while another pending row exists.
3. Persists the one pending row in Durable Object storage before touching D1. The event `id` is
   `SHA-256(tenant_id + "\0" + source_message_id)`.
4. Executes one `INSERT OR IGNORE`, reads the row back by source identity, and verifies its seq, id,
   and hash.
5. Only after D1 confirmation persists `next = seq + 1` and `last_hash`, then clears the pending row.

This ordering is the recovery boundary because Durable Object storage and D1 cannot participate in
one transaction. A crash before confirmation replays the same source identity rather than allocating
a gap or duplicate. A later message cannot advance past an unconfirmed predecessor. There is no
batch `allocate(n)` path and no batch audit INSERT in the current implementation.

```typescript
// simplified current flow
async append(input: AuditAppendInput) {
  await initialize(input.fields.tenantId)
  const existing = await findPersistedEvent(input.fields.tenantId, input.sourceMessageId)
  if (existing) {
    await commitPersisted(existing)
    return { status: 'appended' }
  }
  if (pending && pending.sourceMessageId !== input.sourceMessageId) {
    return { status: 'blocked' }
  }

  const pendingEvent = pending ?? (await createPending(input))
  await insertAndConfirm(pendingEvent)
  await commitPersisted({
    seq: pendingEvent.row.seq,
    id: pendingEvent.row.id,
    hash: pendingEvent.row.hash,
  })
  return { status: 'appended' }
}
```

#### 5.1.4 Queue and consumer ordering guarantee

The `xid-audit` Queue consumer is configured with `max_concurrency: 1` and 5 retries:

```jsonc
// wrangler.jsonc
{
  "queues": {
    "consumers": [
      {
        "queue": "xid-audit",
        "max_batch_size": 100,
        "max_batch_timeout": 5,
        "max_retries": 5,
        "dead_letter_queue": "xid-audit-dlq",
        "max_concurrency": 1,
      },
    ],
  },
}
```

The consumer iterates `batch.messages` sequentially and delegates each message to its tenant
`AuditSeqDO`; it does not group messages or preallocate seq ranges. `AuditSeqDO` remains the
per-tenant serialization and commit boundary even when Queue retries split or reorder an original
batch. A malformed message is persisted to `audit_dead_letters`. A retryable failure is retried up
to the five-retry boundary; after that, `terminalize()` persists the terminal failure without
advancing the audit chain past an unconfirmed event.

```typescript
// simplified current consumer
async function handleAuditBatch(batch: MessageBatch<AuditQueueMsg>, env: Env) {
  for (const message of batch.messages) {
    await handleMessage(env, message)
  }
}
```

#### 5.1.5 Event type enumeration (roughly 60+)

Grouped by domain, with the string format `<domain>.<action>`:

- Authentication: auth.login_success / auth.login_failure / auth.logout / auth.mfa_challenge /
  auth.mfa_success / auth.mfa_failure / auth.passkey_register / auth.passkey_authenticate /
  auth.token_issued / auth.token_revoked / auth.session_revoked
- User: user.created / user.updated / user.deleted / user.erasure_completed / user.email_verified /
  user.password_changed / user.mfa_enrolled / user.mfa_removed / user.impersonated
- Organization: org.created / org.updated / org.deleted / org.member_added / org.member_removed /
  org.role_assigned / org.role_removed / org.invitation_sent / org.invitation_accepted
- Application: app.created / app.updated / app.deleted / app.secret_rotated
- SSO: sso.connection_created / sso.connection_updated / sso.connection_deleted / sso.login_success /
  sso.login_failure / sso.directory_sync_started / sso.directory_sync_completed
- Security: security.brute_force_blocked / security.impossible_travel / security.new_device /
  security.account_locked / security.account_unlocked
- Platform management: platform.tenant_suspended / platform.tenant_activated /
  platform.tenant_deleted / platform.impersonate_start / platform.impersonate_end /
  platform.plan_changed / platform.flag_changed
- Billing: billing.subscription_created / billing.subscription_updated / billing.payment_failed /
  billing.quota_exceeded

#### 5.1.6 Chain verification endpoint

`GET /v1/platform/audit/verify` (Instance Manager only):

Request parameters:

| Parameter | Type    | Notes                          |
| --------- | ------- | ------------------------------ |
| tenant_id | string  | Required                       |
| from_seq  | integer | Starting seq, default 1        |
| to_seq    | integer | Ending seq, default the latest |

Response (200):

```jsonc
{
  "tenant_id": "t_xxx",
  "verified_range": { "from": 1, "to": 50000 },
  "chain_valid": true,
  "broken_at_seq": null, // the first break point seq when chain_valid=false
  "failure_reason": null, // audit_chain_broken | audit_seq_gap | audit_genesis_missing
  "record_count": 50000,
  "computed_at": "2025-01-15T12:00:00.000Z",
}
```

The implemented operator path reads D1 in batches of at most 1000 rows, recomputes every selected
hash, checks `prev_hash`, and returns the diagnostic synchronously. Its time complexity is O(n), so
operators should use `from_seq` / `to_seq` for bounded investigations. A range starting after seq 1
is anchored to the stored predecessor hash; a full integrity verification therefore starts at seq 1.
An asynchronous Queue/KV verification job is not implemented.

Failure diagnostics are returned in the 200 response through `failure_reason` and
`broken_at_seq`:

- `audit_chain_broken` - hash mismatch, returning `broken_at_seq`
- `audit_seq_gap` - non-contiguous seq (something was deleted)
- `audit_genesis_missing` - the first record's prev_hash is not 64 zeros

### 5.2 Queue dead-letter operations

Each business Queue has its own DLQ (`xid-email-dlq`, `xid-whatsapp-dlq`, `xid-sms-dlq`,
`xid-audit-dlq`, `xid-webhook-dlq`, `xid-metering-dlq`, `xid-scim-sync-dlq`, and
`xid-privacy-dlq`). This is load-bearing: `MessageBatch.queue` identifies only the queue currently
being consumed, so a shared DLQ cannot prove the original destination for a replay.

The DLQ consumer stores bounded metadata in `queue_dead_letters`. It never stores a plaintext body,
recipient, token, OTP, cookie, Authorization value, or provider response. The exact original JSON
message is encrypted with the existing KEK AES-256-GCM envelope boundary and only decrypted inside
the replay operation. A persistence failure retries the DLQ message; after 100 persistence retries,
the per-source `*-dlq-persistence-failures` quarantine queue retains it instead of discarding it.

Only an authenticated, verified `instance_manager` can list, inspect, or replay records through
`/v1/platform/dead-letters`. Replay atomically claims `pending -> replaying`, routes only to the
recorded source Queue, and completes `replaying -> replayed`. A five-minute lease prevents
concurrent replay; the hourly cron releases an expired lease, and a later manual request can also
reclaim it directly. This prevents a Worker crash from leaving a record in `replaying` forever.
Because the crash can happen after Queue acceptance but before the D1 completion write, recovery is
intentionally at-least-once and every source consumer keeps its own idempotency boundary. A
completed `replayed` record is never sent again. The Console requires an explicit confirmation and
the Core queues a `platform.queue_dead_letter.replayed` audit event. Ciphertext is never returned by
list or detail responses.

## 6. Observability

Implemented baseline:

- Authentication success writes a low-cardinality Analytics Engine event, while MAU/DAU uses the
  exact `METERING_QUEUE` -> `MeteringDO` -> D1 pipeline.
- Audit metadata is recursively redacted before it enters the append-only hash chain.
- Worker application logs go through `worker/lib/safe-log.ts`. They contain a static event name,
  severity, an allowlisted error type/code, and bounded operational fields. Error message, stack,
  cause, cookie, Authorization, IP, raw URL/query, provider payload, and user identifiers are never
  passed to `console`.
- One-time-link rejections add a static low-cardinality `reason` for the failed verification stage
  such as tenant resolution, JWT validation, or ledger consumption. The reason is server-side only,
  must match the safe-log identifier allowlist, and never contains the credential or request URL.
- Production and staging Workers Logs sample 100%. Cloudflare invocation logs and
  automatic request traces are disabled in every environment because both persist the request URL,
  and automatic Fetch spans include `url.full`. Core URLs can carry OAuth codes, invitation tokens,
  verification tokens, and other one-time secrets.
- Cloudflare Workers Logs retention is 3 days on Free and 7 days on Paid, with an overall maximum
  of 7 days. Current read-only evidence identifies the hosted account as Free, so its expected
  retention is 3 days; the active account plan and deployed retention remain `EXTERNAL` until
  reconciled there. XID configures no Logpush destination and therefore makes no longer-retention
  claim. Dashboard/query access must be restricted to the deployer's incident-response role and
  audited in the Cloudflare account. See
  `https://developers.cloudflare.com/workers/observability/logs/workers-logs/`.

Production access-control and alert policies are deployment state, not repository code. A release
cannot claim them as verified until the active Cloudflare account proves the expected member roles,
Workers Logs access, notification destinations, and sampling configuration.

Planned metrics remain sign-in success by method, MFA adoption/pass rate, API error rate, token
issuance/revocation volume, and delivery success. Impossible travel, device fingerprint alerts, a
GeoIP MMDB, and historical Analytics Engine SQL aggregation are not implemented. Brute-force
protection currently uses Turnstile plus `RateLimitStore`; account-enumeration work is normalized by
constant-time comparison and jitter.

## 7. Billing and quotas

Metering dimensions: MAU (unique users with an authentication event in a calendar month), DAU, org
count, API calls, email count, and SSO connection count.

Aggregation architecture:

- After a successful authentication, the login Worker writes a metering event
  `{tenant_id, user_id, ts}` to Queues
- The metering consumer deduplicates and writes daily rows into the D1 `usage_daily` table
- The daily `0 2 * * *` Cron snapshots the current month's MAU into `usage_monthly`. On the first
  UTC day of a month, the same daily path also archives and evicts the previous month's
  `MeteringDO` keys. The optional Stripe metering phase runs daily

Example managed-service accounting labels:

| Label      | Monthly | Default seat quota | Default API quota | Support label |
| ---------- | ------- | ------------------ | ----------------- | ------------- |
| Free       | $0      | 10                 | 100,000           | Community     |
| Starter    | $25     | 50                 | 1,000,000         | Standard      |
| Pro        | $99     | 250                | 10,000,000        | Priority      |
| Enterprise | Custom  | Custom             | Custom            | Contracted    |

Plan labels select accounting metadata, default quotas, and support labels only. They never control
OIDC, OAuth, SAML, SSO, SCIM, WebAuthn, MFA, or any other authentication capability. A hard resource
quota may reject a new quota-consuming management write, such as adding another seat, but it MUST NOT
suspend an existing user, block sign-in, stop token issuance or refresh, or disable an already
configured protocol integration. Usage-alert rules, thresholds, delivery, and deduplication remain
design targets; the current repository does not emit them. Changing the accounting label or an
explicit quota is an administrative billing operation, not a feature unlock.

The seat definition is tenant-wide: `COUNT(DISTINCT memberships.user_id)` over active memberships
for the complete tenant, including every child organization. The same user in multiple organizations
therefore consumes one seat. The billing overview uses this exact definition for `seatUsed`.
Membership INSERT and UPDATE triggers apply the hard quota atomically when an active user would
consume a new seat. An UPDATE excludes the old row before evaluating the destination tenant, so an
organization move within one tenant does not consume a second seat and a cross-tenant move cannot
bypass the destination quota.

`organization_quotas(tenant_id, 'seats')` is the authoritative hard seat-creation quota.
`organizations.seat_limit` on the root organization is a compatibility mirror only. A plan or
seat-limit mutation updates both values in the same D1 batch, and the Console presents one seat
control. `seats`, `organizations`, and `sso_connections` may use `block_creation`; `api_calls`,
`emails`, and `mau` are observational only, and the management API rejects hard enforcement for
those keys. Creating a top-level tenant initializes the Free seat quota and root mirror in the same
batch. Child Organizations do not own a seat limit, and their create/patch API rejects `seat_limit`.

Stripe is an optional managed-service adapter for Checkout Sessions, the Customer Portal, invoices,
payments, and accounting-label updates. `invoice.payment_failed` records billing state; operator
alert delivery remains a design target. It does not downgrade authentication behavior or lock users
out.

Meter reporting persists a `billing_meter_reports` cursor before each provider call. The pending
identifier is globally unique, and every retry reuses the complete first payload, including customer,
event name, value, and timestamp, until the provider-acknowledged target is committed. A Worker or D1
failure therefore cannot turn one usage delta into two provider reports.
Stripe webhook processing similarly claims each provider `event_id` in `stripe_webhook_events`
before applying it, making event retries idempotent.

XID is MIT licensed. Self-hosting always includes the full feature set, with no tiering, license key,
license generation, or local/network validation check. The labels and Stripe adapter above are
optional for deployers who operate a paid service on top of XID. The kernel does not depend on them,
and turning billing off does not affect any authentication capability.

Design decisions: MAU and DAU use exact counting in a per-tenant sharded MeteringDO. Each membership
is stored as its own Durable Object storage key, and each day and month bucket stores a count, so the
full user set is never held in the isolate. HyperLogLog's 0.8% error is unacceptable for billing.
Stripe metered billing reports a delta rather than the full total. Deduplicating future overage
alerts to at most 3 per tenant per type per month is a design target, not a shipped path.

### 7.1 Exact membership counting implementation spec

#### 7.1.1 Key design and concurrency model

Durable Object name: `metering:{tenant_id}`. Events for the same tenant enter the same Durable Object
input gate, so membership reads, count updates, and deletions are serialized.

- Monthly membership: `member:month:{YYYY-MM}:{user_id}` -> `true`
- Daily membership: `member:day:{YYYY-MM-DD}:{user_id}` -> `true`
- Monthly count: `count:month:{YYYY-MM}` -> `number`
- Daily count: `count:day:{YYYY-MM-DD}` -> `number`

`recordUser` reads only the current user's two membership keys and two counts. A new membership and
its corresponding count are written inside a single `storage.put`; if the write fails, the Durable
Object storage transaction rolls back and a retry does not double-count. A duplicate Queue message
reads the membership and simply returns the existing DAU snapshot. The full user set always stays in
storage, and a Durable Object restart reads only the counts or the current user key.

#### 7.1.2 Daily snapshots, month-start archiving, and cleanup

The daily `0 2 * * *` Cron snapshots every active tenant's current-month count from `MeteringDO` into
the D1 `usage_monthly` table. On UTC day 1, `reportMonthlyMau()` additionally reads the final
previous-month count, upserts it, and then calls `evictMonth`. `evictMonth` deletes the previous
month's membership and count keys 1000 at a time without reading or deserializing membership values.
The same month-start branch removes D1 monthly rows older than the rolling cutoff computed 13 months
before the current month. The storage key count grows linearly with the number of exactly
deduplicated members, but isolate memory usage stays constant.

#### 7.1.3 Daily maintenance and month-start archival pseudocode

Cron Trigger: `0 2 * * *` (02:00 UTC every day). The first day of a UTC month also processes the
previous month.

```typescript
export async function runMonthlyUsageMaintenance(env: Env, now: Date = new Date()) {
  await snapshotCurrentMonthMau(env, now)
  await reportMonthlyMau(env, now) // returns immediately unless now is UTC day 1
  if (shouldArchivePrevMonth(now)) {
    await cleanupOldMonthlyUsage(env, now)
  }
}
```

The optional Stripe adapter runs as a separate daily phase after usage maintenance. It reads the
persisted monthly snapshot and queues idempotent meter reports; it is not part of the month-start
archive transaction.

Current D1 schema:

```sql
CREATE TABLE usage_monthly (
  tenant_id   TEXT    NOT NULL,
  year_month  TEXT    NOT NULL,  -- "YYYY-MM"
  mau         INTEGER NOT NULL,
  archived_at TEXT    NOT NULL,
  PRIMARY KEY (tenant_id, year_month)
);
```

The Cron Trigger is configured in `wrangler.jsonc`:

```jsonc
{
  "triggers": {
    "crons": ["0 * * * *", "0 2 * * *"],
  },
}
```

The Worker `scheduled` handler dispatches `0 2 * * *` to the daily runner. The current implementation
paginates active tenants 50 at a time and processes them sequentially. Completion time and capacity
for a particular production tenant count remain deployment evidence and are `UNKNOWN` until measured.

## 8. Compliance center

- SOC 2 / GDPR evidence: the implemented audit chain provides tamper evidence, not database-level
  immutability. Deployment access controls, MFA enforcement state, storage encryption evidence, and
  TLS posture must be collected from the active Cloudflare account and remain `UNKNOWN` until
  verified
- Data residency: the current settings API stores a `dataResidency` metadata string only. It does not
  select a Durable Object jurisdiction, route to a regional D1 binding, or derive placement from
  `billing_country`. EU-only Durable Objects, a separately deployed EU D1, and automatic assignment
  remain design targets; any live residency claim is `UNKNOWN` until its deployment topology is
  verified
- GDPR tooling: the implemented self-service path produces a private Right of Access JSON export in
  R2 with a 48-hour authenticated download, while deletion follows a cancelable 30-day grace period
  before PII erasure. Erasure keeps a minimal `users` tombstone but removes identity lookups and
  never rewrites the append-only audit chain: audit views render the erased actor as
  `[deleted_user]`, then a new `user.erasure_completed` event records completion
- Compliance evidence: an Instance Manager publishes versioned global or tenant-specific metadata
  backed by an immutable `compliance/` R2 object and a required `sha256:` checksum. The authenticated
  download proxy re-hashes at most 10 MiB before returning a private attachment. An Organization
  Manager can accept an available DPA; Core persists `accepted_by`, `accepted_at`, artifact checksum,
  and source version in an immutable tenant record. Once any Organization accepts a source version,
  the Instance Manager can no longer update or delete that source metadata; the acceptance write and
  source mutation use mutually exclusive D1 predicates so a concurrent request cannot orphan the
  evidence. XID does not generate or cryptographically sign the source PDF
- Status page: the Nimbus Site Worker serves the public `/status` shell, and Core serves public
  incident history plus a severity-derived overall state at `/v1/public/status`. Incident authoring
  and timestamped updates remain authenticated platform operations in the unified Console
- Backup and DR: repository recovery guidance uses D1 Time Travel as the platform-side safety net.
  Its live availability and retention depend on the Cloudflare account and remain `UNKNOWN` until
  verified. No application path performs weekly R2 cold exports. A 90-day cold-retention policy, RTO
  of 4 hours, RPO of 1 hour, and quarterly DR drill remain design/operational targets and MUST NOT be
  claimed without deployment evidence

Design decisions: privacy export and deletion run asynchronously through `PRIVACY_QUEUE`. The
deletion request and consumer both reject erasure of an Organization's sole active owner or the last
active `instance_manager` in the same Instance scope. Non-null `scope_id` values match exactly, while
the existing global null scope matches only another null scope. The consumer repeats that check after the 30-day grace
period, and an atomic eligibility guard is the first statement in the D1 batch so a concurrent role
change rolls back all relational erasure and audit-outbox writes. It then revokes SessionDO and OAuth
state, erases D1 PII, removes prior R2 privacy exports, and writes completion through the durable
audit outbox. Announcement, incident, compliance metadata, and DPA acceptance mutations use the same
durable platform-audit outbox. Status does not introduce a
fourth Worker or a separate Pages project: the three deployed surfaces remain Nimbus Site, Console,
and Core. The Nimbus shell remains independently renderable if Core is unavailable and shows that the
live status API cannot be reached. An independent external probe and availability-history store are
outside the three-Worker repository architecture and remain `UNKNOWN` until a deployment configures
and verifies them.
