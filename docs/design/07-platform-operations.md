# 07 - Platform Operations, Branding, Notifications, Observability, Billing, Compliance

> Chinese version: [`docs/zh-Hans/design/07-platform-operations.md`](../zh-Hans/design/07-platform-operations.md)

## 1. Management console

### Platform operations admin (cross-tenant)

- Global tenant list: search and filter (plan, status, creation time) plus bulk actions (suspend,
  resume, delete)
- Impersonate a tenant admin (recorded in the platform audit log)
- Global user search (cross-tenant, with GDPR access controls)
- Global event stream: aggregates audit records from every tenant, filterable by tenant, event_type,
  and user
- System announcement banner: targeted by plan or tenant
- Global feature flags: rolled out by tenant or plan, stored in KV, with no redeployment required
- Resource quota management: view and manually adjust a single tenant's quota
- Instance default policy (`/v1/platform/settings`): every sessionPolicy field (idleTimeoutMin,
  default 4320 minutes, bounds 5-43200; absoluteTimeoutDays, default 30 days, bounds 1-365;
  rememberMeDefault) plus every tokenPolicy field (accessTokenTtlSec, default 3600s, bounds 60-86400;
  sessionTokenTtlSec, default 60s, bounds 30-300; refreshIdleTimeoutDays, default 30 days, bounds
  1-365; refreshAbsoluteTimeoutDays, default 7 days, bounds 1-90). The org side overrides field by
  field through `/v1/organizations/:id/auth-policy` (null means inherit)
- Billing overview: current-month DAU/MAU for every tenant, overdue and overage status, and a direct
  link to Stripe
- Plan changes and provisioning: upgrade or downgrade a plan, trial periods, and commercial license
  generation
- Global alert rules: thresholds on anomalous sign-in rates and API error rates, routed to PagerDuty
  or Slack
- Status page management: publish and update incidents

Design decisions: the platform admin and the tenant admin share one Worker and one React console. The
platform view's main entry point is `/console/platform/*`, authorized by the `instance_manager`
ManagerAssignment rather than by a business access token claim, and it introduces no separate admin
SPA, admin API, or admin RBAC. `/platform-admin/*` is not a compatibility entry point. Cross-tenant
management goes through the `/v1/platform/*` platform management paths and the platform view inside
the unified console; tenant management continues through `/v1/organizations/:orgId/*` and the org
console. Impersonation generates a 15-minute scoped token and writes a platform audit entry, and it
cannot be bypassed. Feature flags use the KV key `flag:{tenant_id}:{flag_name}` with the global default
`flag:global:{flag_name}`, read directly per request in under 1 ms.

### Tenant admin (single-tenant self-management)

Dashboard (DAU/MAU trends, sign-in success rate, MFA adoption, active orgs), user management,
application management (OAuth2 clients), SSO connections, organization management, team members
(Owner/Admin/Viewer/Billing roles), branding, notification settings, audit log, billing usage, and
compliance tooling.

Design decisions: the tenant admin pages and the platform admin pages belong to the same unified React
console hosted by the same Worker. Tenant management APIs use `/v1/organizations/:orgId/*` and the
related `/v1/*` tenant resource paths, with tenant_id and org_id resolved from `TenantContext` and the
protected path rather than trusted from the request body. An Org Admin can manage only their own org;
an Instance Manager manages any org through the platform management paths or the instance manager
override in the same org console. Viewer is read-only and Billing sees usage only, enforced by the
RBAC middleware layer.

## 2. Branding customization

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

Transactional email types: email verification, magic link, OTP, password reset, email change
confirmation, new-device sign-in alert, organization invitation, account lockout notification,
administrator invitation, and subscription/billing alerts. SMS: OTP and magic link short links.

Email providers in priority order: **Cloudflare Email Service** (preferred and the default, through
the send_email binding), Resend, SendGrid, and bring-your-own SMTP. The default provider is Cloudflare
Email Service, which sends mail with zero additional credentials; deployers can switch to any of the
other three.

Design decisions:

- Every notification is sent asynchronously through Queues. The business Worker calls
  `queue.send({type, recipient, payload})`, and the consumer renders the template and calls the
  provider. Failures retry with exponential backoff up to 5 times, and dead letters go to the D1
  `notification_failures` table
- The template engine is a Mustache subset (`{{var}}` plus `{{#if}}`), which runs on Workers with no
  Node dependency, scoped to user/org/brand/action
- The provider is abstracted as an `EmailProvider` interface (`send({to, from, subject, html, text})`)
  and the consumer selects a provider from tenant configuration. Each email type can name its own
  provider (for example routing OTP through a self-hosted SMTP server)
- SMS: Twilio (primary) and Vonage (backup) behind a single adapter

### 3.1 Cloudflare Email Service (the default email channel)

Cloudflare Email Service (2025, Email Sending) can send transactional email from a Worker to **any
external recipient address**, unlike the older Email Routing, which only forwarded to verified
addresses. Every XID transactional email (verification, magic link, OTP, password reset, alerts,
invitations) goes through this channel.

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
  wraps `env.EMAIL.send`. Resend, SendGrid, and SMTP each implement the same interface, and the
  EmailConsumer is unaware of the concrete provider.
- **Deliverability**: depends on the sending domain's SPF, DKIM, and DMARC configuration; bounce and
  suppression handling follows the Cloudflare Email Service deliverability guidance.

## 4. Internationalization (i18n)

- The sign-in page UI runs entirely on i18n keys, with 8 locales in the first release (en, zh-Hans,
  ja, ko, fr, de, es, pt-BR, all fully translated); 40+ languages are a later plan
- Email templates are versioned by language and selected by `user.locale`
- Error messages are localized, and API error messages carry a locale
- Locale management: tenants enable or disable languages and set a default
- Language pack JSON lives in R2; the Worker preloads the top 5 into memory and reads the rest on
  demand

Design decisions: the locale detection priority is `?locale=` -> `user.locale` -> `Accept-Language` ->
the tenant default -> `en`; a missing string falls back to `en` and never displays the key name.
Tenant-uploaded custom language packs that override terminology for white-labeling (a per-tenant R2
path) have not started -- the R2 language packs are at a global path and there is no upload endpoint.

## 5. Audit log

Event types (roughly 60+, grouped by domain): authentication, user lifecycle, organization,
application, SSO, administrator operations, security (brute_force_blocked, impossible_travel,
new_device), and billing.

- Query filters: event_type, actor_id, target_id, IP, and time range, backed by D1 indexes and cursor
  pagination
- Export: CSV or JSON, at most 90 days per request, generated asynchronously (through a Queue) into R2
  with a signed URL
- Retention: Free 7 days, Pro 30 days, Enterprise custom (up to 2 years), with a daily Cron cleanup
- Tamper resistance: INSERT only, with no UPDATE or DELETE; a monotonically increasing seq plus the
  previous record's SHA-256 chained hash stored in prev_hash forms an append-only chain that not even
  a platform admin can alter, and the DDL layer has no UPDATE privilege
- SIEM integration: webhooks (HMAC-SHA256) plus prebuilt templates (Splunk, Datadog, Elastic, Panther)
  fanned out through Queues

Design decisions: the audit write path goes through Queues asynchronously rather than writing to D1
synchronously, which keeps sign-in P99 under 200 ms. The consumer writes in batches (of 100), and the
chained hash is computed single-threaded on the consumer side to guarantee ordering.

### 5.1 Audit chain implementation spec

#### 5.1.1 Audit event D1 schema

```sql
CREATE TABLE audit_events (
  seq         INTEGER  NOT NULL,  -- per-tenant monotonic counter issued by AuditSeqDO, sharded by audit-seq:{tenant_id}
  id          TEXT     NOT NULL,  -- UUID v4
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
```

UPDATE and DELETE operations are forbidden. At the DDL layer, production data is protected by a
read-only D1 account with no UPDATE privilege.

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

#### 5.1.3 seq generation mechanism

**Approach: a Durable Object counter (`AuditSeqDO`), sharded by tenant_id.**

Durable Object name: `audit-seq:{tenant_id}`. Before writing to D1, the consumer requests a batch of
seq values from that Durable Object (`allocate(n: number): number`). The Durable Object returns the
start of the range, increments in memory, and persists:

```typescript
export class AuditSeqDO extends DurableObject {
  private next: number = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.next = (await ctx.storage.get<number>('next')) ?? 1
    })
  }

  async allocate(count: number): Promise<number> {
    const start = this.next
    this.next += count
    await this.ctx.storage.put('next', this.next)
    return start // returns the range [start, start+count)
  }
}
```

The Durable Object input gate guarantees read-modify-write atomicity, so no additional lock is needed.
Once the consumer has a range it assigns seq values in batch order, so seq values are contiguous within
a batch. **D1's `INTEGER PRIMARY KEY AUTOINCREMENT` MUST NOT be used** for seq: D1 cannot guarantee a
strictly monotonic return value across replicas on write, and it does not support batch
pre-allocation.

#### 5.1.4 Consumer single-threading guarantee

The audit Queue consumer is configured with `max_concurrency = 1`:

```jsonc
// wrangler.jsonc
{
  "queues": {
    "consumers": [
      {
        "queue": "audit-events",
        "max_batch_size": 100,
        "max_batch_timeout": 5,
        "max_retries": 3,
        "dead_letter_queue": "audit-events-dlq",
        "max_concurrency": 1,
      },
    ],
  },
}
```

`max_concurrency = 1` guarantees only one consumer isolate runs at a time, so the chained hash
computation has no concurrency race. Consumer logic:

```typescript
// pseudocode
async function handleAuditBatch(batch: MessageBatch<AuditQueueMsg>, env: Env) {
  // 1. Group by tenant_id to reduce cross-tenant seq Durable Object calls
  const groups = groupBy(batch.messages, (m) => m.body.tenant_id)

  for (const [tenantId, msgs] of groups) {
    const seqDO = env.AUDIT_SEQ.get(env.AUDIT_SEQ.idFromName(`audit-seq:${tenantId}`))
    const seqStart = await seqDO.allocate(msgs.length)

    // 2. Read the previous hash (the current latest hash from D1)
    let prevHash = await getLatestHash(env.DB, tenantId) // returns 64 zeros when there is no record

    // 3. Compute hashes in order and assemble the rows
    const rows: AuditRow[] = []
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]
      const seq = seqStart + i
      const hash = await computeAuditHash(buildInput(seq, msg, prevHash))
      rows.push({ seq, hash, prev_hash: prevHash, ...msg.body })
      prevHash = hash
    }

    // 4. Batch INSERT (a single transaction)
    await batchInsertAudit(env.DB, rows)
  }
  batch.ackAll()
}
```

The `getLatestHash` query:

```sql
SELECT hash FROM audit_events
WHERE tenant_id = ?
ORDER BY seq DESC
LIMIT 1
```

#### 5.1.5 Event type enumeration (roughly 60+)

Grouped by domain, with the string format `<domain>.<action>`:

- Authentication: auth.login_success / auth.login_failure / auth.logout / auth.mfa_challenge /
  auth.mfa_success / auth.mfa_failure / auth.passkey_register / auth.passkey_authenticate /
  auth.token_issued / auth.token_revoked / auth.session_revoked
- User: user.created / user.updated / user.deleted / user.email_verified / user.password_changed /
  user.mfa_enrolled / user.mfa_removed / user.impersonated
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

#### 5.1.6 Chain verification endpoint (not started)

`GET /v1/platform/audit/verify` (Instance Manager only; not started -- the existing audit query
endpoints are `GET /v1/platform/audit-events` and `GET /v1/organizations/:id/audit-events`):

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
  "record_count": 50000,
  "computed_at": "2025-01-15T12:00:00.000Z",
}
```

Verification logic: read from D1 in batches through a cursor (1000 rows per batch), recompute each
hash, and compare against prev_hash. The time complexity is O(n), so it is recommended to run it
asynchronously in the background (through a Queue) with the result stored in KV under
`audit-verify:{tenant_id}:{job_id}`.

Error codes:

- `audit_chain_broken` - hash mismatch, returning `broken_at_seq`
- `audit_seq_gap` - non-contiguous seq (something was deleted)
- `audit_genesis_missing` - the first record's prev_hash is not 64 zeros

## 6. Observability

Core metrics: sign-in success rate (split by password, social, SSO, magic_link), MFA adoption and pass
rate, DAU/WAU/MAU, API error rate, token issuance and revocation volume, and email success rate.

Anomaly detection:

- Brute force: 10 failures from the same IP within 5 minutes triggers a CAPTCHA or a temporary block
  (KV TTL 15 minutes)
- Impossible travel: an IP geolocation delta over 1000 km with a time delta under 2 hours raises an
  alert
- Device fingerprint change: triggers a new-device alert email
- Account enumeration probing: response times are normalized (constant-time)

Design decisions: live metrics use Analytics Engine (`env.ANALYTICS.writeDataPoint`), and historical
aggregation goes through the Analytics Engine SQL API. Impossible travel is computed synchronously in
the login Worker (the GeoIP MMDB lives in R2 and is preloaded at startup, taking under 5 ms), while
firing the alert goes through an asynchronous Queue. Tenant admins see their own data; platform admins
see the global aggregate plus per-tenant drill-down.

## 7. Billing and quotas

Metering dimensions: MAU (unique users with an authentication event in a calendar month), DAU, org
count, API calls, email count, and SSO connection count.

Aggregation architecture:

- After a successful authentication, the login Worker writes a metering event
  `{tenant_id, user_id, ts}` to Queues
- The metering consumer deduplicates and writes daily rows into the D1 `usage_daily` table
- A Cron job aggregates the current month's MAU hourly into `usage_monthly` and reports the day's
  usage delta to Stripe (Metered Subscriptions) daily

Example plans:

| Tier       | Monthly | MAU       | Orgs      | SSO connections |
| ---------- | ------- | --------- | --------- | --------------- |
| Free       | $0      | 10,000    | 3         | 0               |
| Starter    | $25     | 50,000    | 20        | 2               |
| Pro        | $99     | 200,000   | Unlimited | 10              |
| Enterprise | Custom  | Unlimited | Unlimited | Unlimited       |

Overage: Free at 100% blocks new sign-ins and prompts an upgrade; Starter and Pro alert at 80% and
auto-upgrade to the next tier at 100% (which can be switched off in favor of blocking).

Stripe: Checkout Session (upgrades), Customer Portal (invoices and payments), and webhook handling
where `invoice.payment_failed` triggers a downgrade or lockout.

XID is MIT licensed and performs no license key validation; there is no feature that requires a
network signature check to unlock. The tier table above and the Stripe integration are an optional
billing layer for deployers who want to run a paid service on top of XID. The kernel does not depend
on it, and turning billing off does not affect any authentication capability.

Design decisions: MAU and DAU use exact counting in a per-tenant sharded MeteringDO. Each membership
is stored as its own Durable Object storage key, and each day and month bucket stores a count, so the
full user set is never held in the isolate. HyperLogLog's 0.8% error is unacceptable for billing.
Stripe metered billing reports a delta rather than the full total. Overage alerts are deduplicated to
at most 3 per tenant per type per month so users are not spammed.

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

#### 7.1.2 Archiving and cleanup

A Cron job reads last month's count from MeteringDO, writes it into the D1 `usage_monthly` table, and
then calls `evictMonth`. `evictMonth` deletes last month's data 1000 keys per page across the month
and day membership prefixes and the day count prefix, without reading or deserializing any membership
value. The storage key count grows linearly with the number of exactly deduplicated members, but the
isolate memory usage stays constant.

#### 7.1.3 Month-end archival Cron pseudocode

Cron Trigger: `0 2 1 * *` (02:00 UTC on the first of each month, processing the previous month).

```typescript
// pseudocode: MauArchiveCron
export async function runMauArchive(env: Env) {
  const lastMonth = getPrevYearMonth() // e.g. "2025-01"

  // 1. Enumerate every active tenant (a D1 query)
  const tenants = await env.DB.prepare('SELECT tenant_id FROM tenants WHERE status = ?')
    .bind('active')
    .all<{ tenant_id: string }>()

  for (const { tenant_id } of tenants.results) {
    // 2. Read the final MAU value from MeteringDO
    const do_ = env.METERING.get(env.METERING.idFromName(`metering:${tenant_id}`))
    const mau = await do_.getMau(tenant_id, lastMonth)

    // 3. Archive into D1 usage_monthly
    await env.DB.prepare(
      `
        INSERT INTO usage_monthly (tenant_id, year_month, mau, archived_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (tenant_id, year_month) DO UPDATE SET mau = excluded.mau
      `,
    )
      .bind(tenant_id, lastMonth, mau, new Date().toISOString())
      .run()

    // 4. Report the MAU to Stripe (delta = mau, because Stripe settles monthly)
    await reportStripeUsage(tenant_id, lastMonth, mau, env)

    // 5. Clean up last month's membership and count keys
    await do_.evictMonth(lastMonth)
  }
}
```

D1 schema:

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
    "crons": ["0 2 1 * *"],
  },
}
```

The Worker `scheduled` handler dispatches to the right function based on `event.cron`. The Cron
execution timeout is 15 minutes (Free) and 15 minutes (Paid), so with a large tenant count the work
MUST be batched at 50 tenants per batch, spanning batches through a Queue or by splitting it into
several Cron tasks.

## 8. Compliance center

- SOC 2 / GDPR evidence: the audit tamper-resistance statement (the chained hash is exportable), the
  access control matrix, MFA enforcement status, and the data encryption statement (D1/KV/R2
  encryption at rest, TLS 1.3)
- Data residency: EU tenants can choose EU-only (Durable Objects `jurisdiction: "eu"`). D1 has no
  native geographic locking, so EU residency is deployed as a separate D1 instance
  (`--location eu`), assigned automatically by `billing_country`
- GDPR tooling: data export (a Right of Access ZIP), deletion (soft delete -> 7-day cooling off ->
  hard delete of PII, with the audit user_id replaced by `[deleted_user]` so events are retained in
  anonymized form), and online DPA signing generating a PDF stored in R2
- Status page: `status.xid.dev` hosted on Cloudflare Pages, with a Cron job probing the core endpoints
  every 60 seconds and writing to KV, publishing 30 days of availability history
- Backup and DR: D1 Time Travel (7 days) plus a weekly export to R2 cold storage (90 days), with an
  RTO of 4 hours and an RPO of 1 hour, plus a quarterly DR drill (SOC 2 evidence)

Design decisions: GDPR deletion runs asynchronously through Queues (progressively cleaning up the D1
profile and sessions, KV tokens, and the R2 avatar), and a deletion-complete event is written to the
audit log. The status page is a separate Pages project, so a main-service outage does not affect its
availability.
