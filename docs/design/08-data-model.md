# 08 - Data Model (Conceptual Layer + Field-Level Drizzle Schema)

> Chinese version: [`docs/zh-Hans/design/08-data-model.md`](../zh-Hans/design/08-data-model.md)

This chapter has two parts:

- The first part (from section 0 through "Entities and responsibilities by domain") is the conceptual
  layer: which entities exist, what each is responsible for, how they relate, and the isolation
  principles.
- The second part (from section 9 onward) is the **field-level implementation spec**: a complete field
  table for every core entity (field name / SQLite physical type / Drizzle mode / constraints /
  default / notes) plus index declarations and foreign key ON DELETE policies. This is the **single
  source of truth** for `packages/db` (the Drizzle schema) and `packages/types` (the TypeScript
  types), and the implementation MUST NOT deviate from it on its own. Adding, removing, or changing a
  field means changing this chapter first and the implementation second.

## Isolation principles

- Business entities are isolated per tenant (Organization), and org-level entities are further
  subdivided by org
- D1 has no row-level security, so isolation is enforced by the query layer. Raw SQL is forbidden, and
  cross-tenant access tests are required (P0)
- Platform-level entities (Instance, PlatformAdmin) do not participate in tenant isolation and use a
  separate management path
- Short-lived strongly consistent data (challenges, state, nonce, PAR, session revocation sets, rate
  limit counters) belongs in Durable Objects rather than relational tables

The 11 current Durable Objects (binding -> class):

| Binding              | Class                | Purpose                                                                        |
| -------------------- | -------------------- | ------------------------------------------------------------------------------ |
| SESSION_REVOCATION   | SessionDO            | Per-user session revocation set (the source of truth for revocation, see 17.1) |
| WEBAUTHN_CHALLENGE   | ChallengeStore       | WebAuthn challenges plus atomic TOTP replay claims                             |
| OAUTH_STATE          | OAuthFlowDO          | Authorize parameters staged before sign-in, plus state/nonce CSRF defense      |
| PAR_STORE            | ParStore             | PAR request_uri parameters (60s, single use, see 15.3)                         |
| DEVICE_FLOW          | DeviceFlowStore      | device_code/user_code state machine (see 15.2)                                 |
| RATE_LIMITER         | RateLimitStore       | Per-tenant rate limit counters                                                 |
| AUDIT_SEQ            | AuditSeqDO           | Audit seq issuance (sharded by `audit-seq:{tenantId}`, see 17.2)               |
| METERING             | MeteringDO           | Exact DAU/MAU deduplication (sharded by `metering:{tenantId}`, see 17.3)       |
| GUEST_STORE          | GuestStore           | Guest sign-in concurrency dedup keyed by tenant and anonymous session          |
| CIBA_STATE           | CibaStore            | Per-auth_req_id CIBA state, polling throttle and atomic token redemption       |
| IMPERSONATION_GRANTS | ImpersonationGrantDO | Two-minute secret-hash-only, exact-target-host handoff consumed once           |

The GuestStore binding reuses the WebAuthn `__Host-xid.anon` cookie plus anonKey infrastructure.
Its record TTL aligns with the session TTL. CibaStore records expire with `auth_req_id`; Durable
Object alarms clean up both stores. ImpersonationGrantDO stores no plaintext secret or target user
identity and atomically consumes each manager grant once.

## Entity relationship backbone

```
Instance (platform)
  -> Organization (tenant)
       -> Project -> Application
       -> Membership <- User (platform-level, spans orgs)
User -> various Credentials / Identities
Organization -> SsoConnection / Directory (enterprise federation)
Instance -> InstanceSigningKey (the default issuer key)
User -> Session -> Token
```

## Entities and responsibilities by domain

### Tenancy and hierarchy

| Entity       | Responsibility                                                            | Key relationships                                     |
| ------------ | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| Instance     | The platform operations container                                         | Contains many Organizations                           |
| Organization | Tenant/customer, the unit of data isolation, may override platform policy | Belongs to an Instance, may have one level of sub-org |
| Project      | Role namespace, sharing roles across Apps                                 | Belongs to an Organization                            |
| Application  | OIDC/SAML client                                                          | Belongs to a Project                                  |
| ProjectGrant | Cross-organization authorization                                          | Connects a Project to the granted Org                 |
| OrgUnit      | In-org business tree node (department/team, reporting line)               | Belongs to an Organization, self-nesting up to depth 8 |
| OrgUnitMember| A user's placement in the unit tree (primary/secondary post)              | Connects a User to an OrgUnit                         |
| OrgPolicy    | Per-org policy override (SSO/MFA/session/password)                        | Belongs to an Organization                            |
| OrgBranding  | Per-org branding (logo/colors/CSS)                                        | Belongs to an Organization                            |
| OrgMetadata  | Public and private metadata                                               | Belongs to an Organization                            |
| OrgQuota     | Quotas (seats, API, and so on)                                            | Belongs to an Organization                            |

### Users and identities

| Entity                | Responsibility                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| User                  | The platform-level user principal, with a profile and three metadata tiers (public/private/unsafe) |
| UserEmail / UserPhone | Multi-valued contact methods with verified and primary state, unique within a tenant               |
| UserIdentity          | The association between one sign-in method and a User (password/passkey/social/saml)               |
| Consent               | The user's consent record for data processing (GDPR)                                               |

### Credentials and authentication

| Entity                   | Responsibility                                                         |
| ------------------------ | ---------------------------------------------------------------------- |
| PasskeyCredential        | WebAuthn credential (public key, sign_count, transports, backup state) |
| Password                 | Password hash, algorithm, breach marker, history                       |
| SocialConnection         | Social/OAuth account binding (tokens stored encrypted)                 |
| OtpCode / MagicLinkToken | Short-lived passwordless credentials (hashed storage, single use)      |
| MfaFactor                | MFA factor (TOTP/SMS/email/passkey/backup)                             |
| BackupCode               | Single-use recovery codes (managed in batches)                         |
| TrustedDevice            | Remembered device (fingerprint and validity window)                    |

### RBAC

| Entity            | Responsibility                                          |
| ----------------- | ------------------------------------------------------- |
| Role              | A Project-level named role group                        |
| Permission        | An atomic capability (feature:action)                   |
| RolePermission    | The role-to-permission mapping                          |
| UserGrant         | A user's role grant within a Project or Org             |
| ManagerAssignment | A platform management role (instance/org/project/grant) |
| AccessRequest     | A self-service Project access request plus its decision |

### Organization membership

| Entity     | Responsibility                                                         |
| ---------- | ---------------------------------------------------------------------- |
| Membership | The User-to-Organization relationship (role, status, member or guest)  |
| Invitation | An invitation (email or link, revocable, with an expiry)               |
| OrgDomain  | An organization email domain (verification status and enrollment mode) |

### OIDC / OAuth

| Entity            | Responsibility                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------- |
| OAuthClient       | Client registration (type, auth method, redirect_uri, token configuration)                  |
| AuthorizationCode | Authorization code (primarily stored in D1, single-use CAS consumption plus a replay fence) |
| RefreshToken      | Refresh token (rotation plus family detection)                                              |
| UserConsent       | Persisted user authorization of client scopes                                               |
| DeviceCode        | Device code flow state                                                                      |
| ParRequest        | PAR request parameters (60s, Durable Object preferred)                                      |
| ResourceServer    | A protected API (audience plus scopes)                                                      |

### Enterprise SSO and directory sync

| Entity                         | Responsibility                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| SsoConnection                  | Per-org upstream IdP connection (SAML/OIDC config, certificates, attribute mapping) |
| SsoProfile                     | The result of one SSO authentication (idp_id and claims)                            |
| OrganizationDomain             | A verified domain used for SSO routing                                              |
| Directory                      | SCIM directory connection (provider, token, sync status)                            |
| DirectoryUser / DirectoryGroup | Directory-synced users and groups (including the group-to-role mapping)             |
| SamlServiceProvider            | Downstream SAML SP registration (when XID acts as the IdP)                          |
| SamlSessionBinding             | SAML SLO SessionIndex/NameID to session mapping                                     |
| ScimTarget                     | Outbound SCIM target (XID acting as a SCIM client pushing to downstream SaaS)       |
| ScimTargetResource             | Stable local-to-downstream User/Group identity mapping for one SCIM target          |

### Keys and sessions

| Entity             | Responsibility                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------- |
| InstanceSigningKey | The default issuer signing key (envelope-encrypted private key, public JWK, kid, status) |
| CertStore          | SAML certificates and private keys (encrypted)                                           |
| Session            | A user session (device, status, lifetimes, active org, impersonator)                     |

### Platform operations

| Entity                    | Responsibility                                                |
| ------------------------- | ------------------------------------------------------------- |
| AuditLog                  | Append-only audit events (chained hash for tamper resistance) |
| Usage (daily/monthly)     | DAU/MAU and usage metering                                    |
| Webhook / WebhookDelivery | Subscriptions and delivery records (retries and dead letters) |
| ApiKey                    | API keys (scoped, hashed storage)                             |
| PlatformAdmin             | Platform administrator (platform-level)                       |
| FeatureFlag               | Rollout switches (stored in KV, not a relational table)       |
| OrganizationPlan / Quota  | Optional accounting labels and resource-creation limits       |
| StripeCheckoutReservation | Durable guard against duplicate hosted subscription Checkout  |
| PlatformAnnouncement      | Scheduled, explicitly targeted operator announcements         |
| StatusIncident / Update   | Public service-status incidents and their timeline            |
| PrivacyRequest            | User export and delayed-erasure workflow state                |
| ComplianceDocument        | Versioned compliance artifacts and acceptance metadata        |
| PlatformAuditOutbox       | Durable, redacted audit handoff for platform mutations        |

---

# Field-level Drizzle schema implementation spec

The sections below are the **single source of truth** for `packages/db` (the Drizzle schema) and
`packages/types` (the TypeScript types). Each core entity gets a complete field table plus index
declarations plus foreign key ON DELETE policies. Once a field name and physical type are settled, the
implementation MUST NOT deviate; adding, removing, or changing a field means changing this chapter
first and the implementation second. There are currently 71 D1 tables (matching
`packages/db/src/schema` and the `packages/db/drizzle` migrations); device_codes and par_requests are
logical structures inside Durable Objects and do not count as tables.

## 9. Shared conventions (applying to every table)

### 9.1 IDs and primary keys

- Every externally addressable entity primary key listed in 9.6 is `text` holding a prefixed nanoid.
  It does not expose an auto-increment value; see the sub convention in chapter 05 section 8.1.
  Internal bookkeeping rows not listed in 9.6 may retain UUID primary keys, and protocol correlation
  values such as `jti` remain UUIDs where the protocol requires them.
- An operation or correlation value with no resource route, such as the outbound SCIM sync `runId`,
  is not an entity identifier and may remain a UUID. `audit_events.id` is likewise a deterministic
  SHA-256 idempotency and hash-chain value addressed by `(tenant_id, seq)`, not a resource locator.
  In contrast, `queue_dead_letters.id` is used by `/v1/platform/dead-letters/:id`, so it is listed in
  9.6 and uses the shared public identifier generator.
- Prefixed nanoid generation uses 21 characters from a base62 alphabet (`A-Za-z0-9`) after the prefix
  and `_` (for example `user_V1StGXR8Z5jdHi6BmyT`), unique across the table. These public identifiers
  are URL-friendly and smaller than UUIDs.
- Production Worker writes for the entities in 9.6 use the single
  `apps/server/worker/lib/persisted-id.ts` Web Crypto generator. Existing UUID rows remain readable;
  adopting prefixed IDs does not rewrite or destructively migrate stored identifiers.

### 9.2 Physical type mapping (Drizzle SQLite; per the monorepo-toolchain rule, the ORM is Drizzle on D1)

| Logical type                          | Drizzle declaration                      | SQLite physical | Used for                                                                          |
| ------------------------------------- | ---------------------------------------- | --------------- | --------------------------------------------------------------------------------- |
| Identifier / enum / hash / JWK string | `text(...)`                              | TEXT            | id, foreign keys, status, token_hash, kid                                         |
| Timestamp                             | `integer(..., { mode: 'timestamp_ms' })` | INTEGER         | created_at, expires_at, and so on; Unix milliseconds, mapped to `Date` by Drizzle |
| Boolean                               | `integer(..., { mode: 'boolean' })`      | INTEGER         | verified, primary, revoked, and so on; stored as 0/1                              |
| Counter integer                       | `integer(..., { mode: 'number' })`       | INTEGER         | sign_count, seq, seat_used                                                        |
| Binary                                | `blob(..., { mode: 'buffer' })`          | BLOB            | COSE public keys, ciphertext bytes, iv, tag, bitmaps                              |
| JSON structure                        | `text(..., { mode: 'json' }).$type<T>()` | TEXT            | metadata, attribute_mapping, claims_config                                        |

Convention: **timestamps are always stored as Unix millisecond integers** (matching the millisecond
precision of `occurred_at` in chapter 07's audit design; SQLite does not store ISO strings, with the
audit table's `occurred_at` as the one exception because it feeds the hash input). Every nullable
timestamp defaults to `null`.

### 9.3 Common columns (present on nearly every business table)

| Column     | Type          | Constraints                                                             | Default                                  | Notes                                                                                                                                        |
| ---------- | ------------- | ----------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| id         | text          | PK                                                                      | nanoid                                   | See 9.1                                                                                                                                      |
| tenant_id  | text          | NOT NULL, FK -> organizations.id (the top-level tenant) or the instance | --                                       | The tenant isolation key, injected by the Drizzle query layer (see the tenant-isolation rule); platform-level tables do not have this column |
| created_at | integer ts_ms | NOT NULL                                                                | `$defaultFn(() => new Date())`           | Creation time                                                                                                                                |
| updated_at | integer ts_ms | NOT NULL                                                                | Same, plus `$onUpdate(() => new Date())` | Update time                                                                                                                                  |

> tenant_id semantics: an XID "tenant" is a top-level Organization (see the hierarchy in chapter 02,
> Instance -> Organization). On most business tables `tenant_id` points at the top-level org's id, and
> org-level entities carry an additional `org_id` (a sub-org or the active org). Platform-level tables
> (Instance, PlatformAdmin, FeatureFlag in KV) have no tenant_id and use a separate management path
> (see the tenant-isolation rule).

### 9.4 Foreign key ON DELETE policy

| Relationship type                                                          | ON DELETE                                                                        | Rationale                                                                                                                                             |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| A child that dies with its parent (a user's credentials, emails, sessions) | `cascade`                                                                        | Deleting a user MUST clear every credential, leaving nothing dangling                                                                                 |
| A reference that must retain history (audit.actor_id, token.user_id)       | `no action` (soft delete or remove the identity lookup at the application layer) | The audit chain cannot be cascade-deleted or rewritten; after GDPR erasure an unresolved actor renders as `[deleted_user]` (see chapter 07 section 8) |
| An optional association (session.active_org_id)                            | `set null`                                                                       | After an org is deleted, the session falls back to having no org context                                                                              |
| Configuration ownership (application -> project)                           | `cascade`                                                                        | Deleting a project deletes its applications too                                                                                                       |

D1 does **not** enforce foreign key constraints by default (SQLite `PRAGMA foreign_keys`). Drizzle
migrations emit FK declarations for schema documentation and type inference, but **the application
query layer is authoritative** for runtime isolation and cascading (D1 has no RLS, see the
tenant-isolation rule). Every FK column MUST have an index (SQLite does not index foreign keys
automatically).

### 9.5 Consolidated list of tenant isolation unique constraints (P0, see the tenant-isolation rule)

Everything that is "unique within a tenant" uses a composite UNIQUE whose **first column MUST be
tenant_id**, so the same value in different tenants does not collide:

| Table                | UNIQUE constraint                                | Notes                                                                                                           |
| -------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| user_emails          | `UNIQUE (tenant_id, email)`                      | Email unique within the tenant (see chapter 05 section 1)                                                       |
| user_phones          | `UNIQUE (tenant_id, phone)`                      | Phone unique within the tenant                                                                                  |
| users                | `UNIQUE (tenant_id, external_id)`                | external_id unique within the tenant, allowing many nulls (SQLite UNIQUE permits multiple NULLs)                |
| users                | `UNIQUE (tenant_id, username)`                   | username unique within the tenant, nullable                                                                     |
| user_identities      | `UNIQUE (tenant_id, provider, provider_user_id)` | Social binding unique within the tenant (see chapter 01 section 3)                                              |
| passkey_credentials  | `UNIQUE (tenant_id, credential_id)`              | Credential ID unique within the tenant (see registration step 7 in chapter 01)                                  |
| organizations        | `UNIQUE (tenant_id, slug)`                       | Org slug unique within the tenant (a top-level org's tenant_id equals its own id)                               |
| organizations        | `UNIQUE (instance_id, slug)`                     | Host resolution and self-service top-level Tenant creation require an Instance-wide slug namespace              |
| organization_domains | `UNIQUE (domain)`                                | Globally unique domain (one domain can be claimed by only one org, see chapter 04 section 5); not tenant-scoped |
| refresh_tokens       | `UNIQUE (token_hash)`                            | Globally unique hash (see chapter 03 section 11.1)                                                              |
| roles                | `UNIQUE (tenant_id, project_id, key)`            | Role key unique within the project                                                                              |
| permissions          | `UNIQUE (tenant_id, project_id, key)`            | Permission key unique within the project                                                                        |
| org_units            | `UNIQUE (tenant_id, org_id, parent_unit_id, slug)` | Unit slug unique among siblings (root rows with NULL parent fall outside SQLite NULL comparison, see 10.2b)   |
| org_units            | `UNIQUE (tenant_id, path)`                       | Materialized path unique within the tenant (concurrent-create backstop, see 10.2b)                            |
| org_unit_members     | partial `UNIQUE (tenant_id, org_id, user_id) WHERE is_primary = 1` | One primary post per user per org (see 10.2c)                                          |
| access_requests      | partial `UNIQUE (tenant_id, project_id, requester_user_id) WHERE status = 'pending'` | At most one pending request per user and project (see 13.6)                |

> A SQLite UNIQUE index treats multiple NULLs as distinct (no collision), which is why external_id and
> username can be nullable and still constrained.

### 9.5.1 Query path index baseline (P0)

Indexes are designed around the actual query predicates. A tenant isolation unique index MUST NOT be
mistaken for a cross-tenant resolution index:

| Query path                                  | Index requirement                                                   | Purpose                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Apex-domain sign-in by email/phone          | `INDEX(email,user_id,tenant_id)`, `INDEX(phone,user_id,tenant_id)`  | Identify which organization a user belongs to from the apex domain, across tenants |
| Apex-domain sign-in by username/external_id | `INDEX(username,tenant_id)`, `INDEX(external_id,tenant_id)`         | Match the sign-in field first, then return the tenant                              |
| Host-based tenant resolution                | `UNIQUE(instance_id,slug)`                                          | Resolve an organization by slug within an instance and prevent ambiguous hosts     |
| Management lists                            | `INDEX(tenant_id,status,id)` or `INDEX(tenant_id,org_id,status,id)` | SQL keyset pagination, avoiding full scans and temporary sorts                     |
| User and SCIM lists                         | `INDEX(tenant_id,id)` or `INDEX(tenant_id,directory_id,id)`         | Stable pagination of non-deleted records by id                                     |
| Session lists                               | `INDEX(tenant_id,status,id)`, `INDEX(tenant_id,user_id,status,id)`  | Tenant-level and user-level session pagination                                     |
| Tenant audit list                           | `INDEX(tenant_id,occurred_at,id)`                                   | Descending reads on a composite (occurred_at, id) cursor                           |
| Platform current usage                      | `INDEX(day,tenant_id)`, `INDEX(year_month,tenant_id)`               | Cross-tenant reads of the current period's metering fields                         |
| Platform global statistics                  | `INDEX(event_type)` plus active and top-level partial indexes       | Avoid scanning the whole table through a tenant-prefixed index                     |

Every list endpoint MUST perform its `WHERE`, `ORDER BY`, and `LIMIT` in the database. A `slice` in
Worker memory is permitted only on a result set the database has already limited to `limit + 1`.
Exports and full synchronization are explicit full-scan scenarios and MUST use chunked reads.

### 9.6 ID prefix table (external identifiers, see chapter 05 section 8.1 plus chapter 03)

| Entity                  | Prefix   | Entity                              | Prefix                                        |
| ----------------------- | -------- | ----------------------------------- | --------------------------------------------- |
| User                    | `user_`  | Session                             | `sess_`                                       |
| Organization            | `org_`   | RefreshToken (internal id)          | `rt_` (the token itself) / internal id `rti_` |
| Project                 | `proj_`  | AuthorizationCode (the code itself) | `ac_`                                         |
| Application/OAuthClient | `app_`   | DeviceCode                          | `dc_`                                         |
| ProjectGrant            | `grant_` | ParRequest (the request_uri opaque) | `par_`                                        |
| Membership              | `mem_`   | UserConsent                         | `cons_`                                       |
| Invitation              | `inv_`   | ResourceServer                      | `rs_`                                         |
| Role                    | `role_`  | SsoConnection                       | `conn_`                                       |
| Permission              | `perm_`  | RolePermission                      | `rp_`                                         |
| Directory               | `dir_`   |                                     |                                               |
| UserGrant               | `ug_`    | SigningKey (id)                     | `sk_`                                         |
| ManagerAssignment       | `mgr_`   | CertStore                           | `cert_`                                       |
| MfaFactor               | `mfa_`   | Webhook                             | `wh_`                                         |
| TrustedDevice           | `dev_`   | ApiKey (id)                         | `ak_`                                         |
| PasskeyCredential       | `pk_`    | PlatformAdmin                       | `padmin_`                                     |
| UserIdentity            | `idn_`   | Instance                            | `inst_`                                       |
| CustomHostname          | `ch_`    | PlatformAnnouncement                | `ann_`                                        |
| StatusIncident          | `inc_`   | StatusIncidentUpdate                | `incu_`                                       |
| PrivacyRequest          | `prv_`   | ComplianceDocument                  | `cmp_`                                        |
| PlatformAuditOutbox     | `paud_`  |                                     |                                               |
| OrganizationDomain      | `dom_`   | SamlServiceProvider                 | `sp_`                                         |
| ScimTarget              | `st_`    | QueueDeadLetter                     | `dlq_`                                        |
| DirectoryUser           | `dusr_`  | DirectoryGroup                      | `dgrp_`                                       |

> Note: `sk_test_` and `sk_live_` are the **plaintext token** prefixes for an ApiKey (see the
> api-sdk-conventions rule). XID has no separate publishable-key database. These tokens use a
> separate namespace from this table's internal id prefix (`ak_`), and the two MUST NOT be
> conflated.

## 10. Tenancy and hierarchy entities

### 10.1 instances (platform-level, no tenant_id)

| Field                   | Type          | Constraints      | Default          | Notes                                                                                                                                                                                               |
| ----------------------- | ------------- | ---------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                      | text          | PK               | `inst_`+nanoid   | Platform instance identifier                                                                                                                                                                        |
| name                    | text          | NOT NULL         | --               | Instance display name                                                                                                                                                                               |
| primary_domain          | text          | NOT NULL, UNIQUE | --               | Deployment primary domain (such as `xid.dev`)                                                                                                                                                       |
| mode                    | text          | NOT NULL         | `'multi_tenant'` | `single_tenant` / `multi_tenant` (corresponding to the TenantContext resolution mode, see the tenant-context rule)                                                                                  |
| default_locale          | text          | NOT NULL         | `'en'`           | Default locale (see chapter 07 section 4)                                                                                                                                                           |
| data_residency          | text          | NOT NULL         | `'us'`           | `us` / `eu` / `apac` (see data residency in chapter 05 section 7)                                                                                                                                   |
| mfa_policy              | text          | NOT NULL         | `'optional'`     | Platform-layer MFA default `required`/`optional`/`disabled` (the top of the three-level inheritance chain, see the password-auth rule)                                                              |
| password_policy         | text json     | NOT NULL         | See notes        | The platform default password policy `{min_length:12,max_length:128,require_breach_check:true,history_count:5}`                                                                                     |
| session_policy          | text json     | NOT NULL         | See notes        | `{idle_timeout_min:4320,absolute_timeout_days:30,remember_me_default:false}` (snake_case; idle bounds 5-43200, absolute bounds 1-365, see chapter 05 section 8)                                     |
| token_policy            | text json     | NOT NULL         | See notes        | `{access_token_ttl_sec:3600,session_token_ttl_sec:60,refresh_idle_timeout_days:30,refresh_absolute_timeout_days:7}` (snake_case; bounds 60-86400 / 30-300 / 1-365 / 1-90, see chapter 03 section 3) |
| status                  | text          | NOT NULL         | `'active'`       | `active`/`suspended`                                                                                                                                                                                |
| created_at / updated_at | integer ts_ms | NOT NULL         | See 9.3          |                                                                                                                                                                                                     |

Indexes: `UNIQUE(primary_domain)`. No foreign keys (this is the platform root).

### 10.2 organizations (tenants; a top-level org's tenant_id equals its own id)

| Field                   | Type            | Constraints                                        | Default             | Notes                                                                                                |
| ----------------------- | --------------- | -------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------- |
| id                      | text            | PK                                                 | `org_`+nanoid       |                                                                                                      |
| tenant_id               | text            | NOT NULL, FK -> organizations.id (self)            | --                  | Equals id for a top-level org; equals the top-level org id for a sub-org (the tenant isolation root) |
| instance_id             | text            | NOT NULL, FK -> instances.id ON DELETE no action   | --                  | The platform instance it belongs to                                                                  |
| parent_org_id           | text            | FK -> organizations.id ON DELETE cascade, nullable | null                | One level of sub-organization (see chapter 02 section 1; no deep nesting); null at the top level     |
| slug                    | text            | NOT NULL                                           | --                  | Used in URLs and subdomains; unique by both `(tenant_id,slug)` and `(instance_id,slug)`, see 9.5     |
| name                    | text            | NOT NULL                                           | --                  | Display name                                                                                         |
| logo_url                | text            | nullable                                           | null                | R2 logo URL (branding lives in OrgBranding)                                                          |
| public_metadata         | text json       | NOT NULL                                           | `{}`                | Readable by the frontend (see chapter 02 section 5)                                                  |
| private_metadata        | text json       | NOT NULL                                           | `{}`                | Server and admin only                                                                                |
| seat_limit              | integer number  | nullable                                           | null                | Compatibility mirror of the root tenant's `organization_quotas(seats)` limit; null means unlimited   |
| seat_used               | integer number  | NOT NULL                                           | `0`                 | Legacy compatibility counter; billing derives tenant-wide distinct active users from memberships     |
| enrollment_mode         | text            | NOT NULL                                           | `'invite_required'` | `automatic`/`invite_required` (automatic domain assignment, see chapter 02 section 2)                |
| allow_org_self_service  | integer boolean | NOT NULL                                           | `1`                 | When off, an org admin cannot change SSO or MFA (see chapter 02 section 6)                           |
| status                  | text            | NOT NULL                                           | `'active'`          | `active`/`suspended`/`deleted`                                                                       |
| deleted_at              | integer ts_ms   | nullable                                           | null                | Soft delete marker (an Instance Manager deleting an org)                                             |
| created_at / updated_at | integer ts_ms   | NOT NULL                                           | See 9.3             |                                                                                                      |

Indexes: `UNIQUE(tenant_id, slug)`, `UNIQUE(instance_id, slug)`, `INDEX(instance_id)`, `INDEX(parent_org_id)`,
`INDEX(tenant_id, status)`.

Hierarchy is a database invariant, not only a handler convention. A top-level row must satisfy
`id = tenant_id` and `parent_org_id IS NULL`. A child must satisfy `id <> tenant_id`,
`parent_org_id = tenant_id`, and reference an active same-Instance top-level row when it is created
or restored. The migration-owned insert/update guards reject deep nesting, cross-Instance parents,
Tenant changes, and reparenting.

### 10.2a custom_hostnames (Cloudflare for SaaS binding)

| Field                                  | Type            | Constraints               | Default          | Notes                                                                                           |
| -------------------------------------- | --------------- | ------------------------- | ---------------- | ----------------------------------------------------------------------------------------------- |
| id                                     | text            | PK                        | `ch_`+nanoid     | Local durable identity                                                                          |
| tenant_id                              | text            | NOT NULL                  | --               | Tenant isolation key                                                                            |
| org_id                                 | text            | NOT NULL                  | --               | Owning organization                                                                             |
| instance_id                            | text            | NOT NULL                  | --               | Instance whose Core Worker serves the hostname                                                  |
| hostname                               | text            | NOT NULL, globally UNIQUE | --               | Lowercase concrete external hostname; wildcard and platform-owned hosts are rejected            |
| cloudflare_hostname_id                 | text            | globally UNIQUE, nullable | null             | Cloudflare Custom Hostname id                                                                   |
| status                                 | text            | NOT NULL                  | `'provisioning'` | `provisioning`/`pending`/`active`/`provisioning_failed`/`deletion_failed`/`deleted`             |
| hostname_status                        | text            | NOT NULL                  | `'pending'`      | Cloudflare hostname ownership status                                                            |
| ssl_status                             | text            | nullable                  | null             | Cloudflare `ssl.status`; local `active` requires both this and `hostname_status` to be `active` |
| ownership_verification_type/name/value | text            | nullable                  | null             | Provider ownership TXT instruction, bound to this tenant                                        |
| ownership_expires_at                   | integer ts_ms   | nullable                  | null             | 24-hour local reservation deadline until ownership becomes active                               |
| dcv_delegation_records                 | text json       | NOT NULL                  | `[]`             | Provider DCV CNAME records; may arrive asynchronously after create                              |
| validation_records                     | text json       | NOT NULL                  | `[]`             | Provider certificate validation records                                                         |
| traffic_cname_target                   | text            | NOT NULL                  | --               | Configured friendly CNAME target, otherwise the active Cloudflare fallback origin               |
| verification_errors                    | text json       | NOT NULL                  | `[]`             | Provider status codes only; no secret or raw provider response                                  |
| requires_passkey_reregistration        | integer boolean | NOT NULL                  | `1`              | Explicit WebAuthn RPID migration warning                                                        |
| activated_at / last_polled_at          | integer ts_ms   | nullable                  | null             | First full activation and latest provider poll                                                  |
| deleted_at                             | integer ts_ms   | nullable                  | null             | Explicit deletion tombstone; preserved to prevent stale-DNS takeover                            |
| created_at / updated_at                | integer ts_ms   | NOT NULL                  | See 9.3          |                                                                                                 |

Indexes: `UNIQUE(hostname)`, `UNIQUE(cloudflare_hostname_id)`,
`INDEX(tenant_id, org_id, status, id)`, `INDEX(status, ownership_expires_at, id)`,
`INDEX(instance_id, status, id)`.

`hostname` is intentionally the exception to the usual tenant-first uniqueness rule. One external
DNS name can be attached to only one Cloudflare Custom Hostname. An explicit delete keeps the row as
a global tombstone so stale DNS cannot be claimed by a different tenant. Expired, never-verified
reservations are physically removed only after the remote Cloudflare delete succeeds.

### 10.2b org_units (in-org business tree nodes, see chapter 02 section 1)

An OrgUnit is a hierarchical business node (department/team) inside one Organization. It carries no
tenant-boundary semantics: no TenantContext participation, no issuer/RPID role, no token claims. The
tree combines adjacency (`parent_unit_id`) with a materialized path.

| Field                   | Type          | Constraints                       | Default    | Notes                                                                                          |
| ----------------------- | ------------- | --------------------------------- | ---------- | ---------------------------------------------------------------------------------------------- |
| id                      | text          | PK                                | `ou_`+id   |                                                                                                |
| tenant_id               | text          | NOT NULL                          | --         | The top-level org id (isolation key, injected first)                                           |
| org_id                  | text          | NOT NULL                          | --         | The owning Organization (top-level or sub-org)                                                 |
| parent_unit_id          | text          | nullable                          | null       | Adjacency parent; null marks a root node                                                       |
| path                    | text          | NOT NULL                          | --         | Materialized path `/<id>/<id>/.../<id>` including the node itself; root is `/<id>`             |
| depth                   | integer number| NOT NULL                          | --         | Root = 1; the cap of 8 is enforced in the application layer                                    |
| slug                    | text          | NOT NULL                          | --         | Unique among siblings                                                                          |
| name                    | text          | NOT NULL                          | --         | Display name                                                                                   |
| manager_user_id         | text          | nullable                          | null       | Business reporting-line head; the approval-routing data source, no control-plane effect        |
| status                  | text          | NOT NULL                          | `'active'`| `active`/`archived`; archived nodes drop out of manager resolution and member queries          |
| created_at / updated_at | integer ts_ms | NOT NULL                          | See 9.3    |                                                                                                |

Indexes: `UNIQUE(tenant_id, org_id, parent_unit_id, slug)`, `UNIQUE(tenant_id, path)`,
`INDEX(tenant_id, org_id)`, `INDEX(tenant_id, org_id, parent_unit_id)`, `INDEX(tenant_id, path)`,
`INDEX(tenant_id, manager_user_id)`.

Materialized path rules: the application layer generates `path = parent.path + '/' + id` and
`depth = parent.depth + 1` inside the creation transaction; a subtree move rewrites `path`/`depth`
for the node and every descendant with one `WHERE path LIKE node.path || '/%'` batch UPDATE, and
rejects a move onto its own descendant or one that would exceed the depth cap. As in every XID
table there is no foreign key; tree consistency lives in `packages/db/src/org-units.ts`. Note that
SQLite NULL semantics exclude root rows (`parent_unit_id IS NULL`) from the sibling-slug unique
index, so duplicate root slugs are accepted in v1 -- root trees typically hold a single company node
and the duplication breaks no query.

### 10.2c org_unit_members (user placement in the tree, see chapter 02 section 1)

A user's placement inside an Organization's unit tree (primary post versus secondary post). An
active Membership in the same Organization is a precondition for joining a unit.

| Field                   | Type            | Constraints | Default | Notes                                                                                |
| ----------------------- | --------------- | ----------- | ------- | ------------------------------------------------------------------------------------ |
| id                      | text            | PK          | `oum_`+id |                                                                                    |
| tenant_id               | text            | NOT NULL    | --      | Isolation key                                                                        |
| org_id                  | text            | NOT NULL    | --      | Denormalized from the unit, so queries need no join                                  |
| unit_id                 | text            | NOT NULL    | --      | The placement target                                                                 |
| user_id                 | text            | NOT NULL    | --      |                                                                                      |
| is_primary              | integer boolean | NOT NULL    | `0`     | Primary post: the reporting-line start for approver resolution                       |
| created_at / updated_at | integer ts_ms   | NOT NULL    | See 9.3 |                                                                                      |

Indexes: `UNIQUE(unit_id, user_id)`, partial
`UNIQUE(tenant_id, org_id, user_id) WHERE is_primary = 1` (one primary post per user per org),
`INDEX(tenant_id, user_id)`, `INDEX(tenant_id, org_id, user_id)`, `INDEX(tenant_id, unit_id)`.

Only the primary post feeds manager resolution; secondary posts (`is_primary = 0`) answer "members
of this node" queries only. Setting or switching a primary post is one transaction (clear the old
primary, set the new one) with the partial unique index as the concurrency backstop. Losing the
Organization Membership does not delete unit member rows; every read path joins Membership status,
so dangling rows are invisible, and physical cleanup is a later maintenance task (not in v1).

### 10.3 projects (role namespace)

| Field                   | Type          | Constraints                                        | Default        | Notes                                           |
| ----------------------- | ------------- | -------------------------------------------------- | -------------- | ----------------------------------------------- |
| id                      | text          | PK                                                 | `proj_`+nanoid |                                                 |
| tenant_id               | text          | NOT NULL, FK -> organizations.id                   | --             | Isolation key                                   |
| org_id                  | text          | NOT NULL, FK -> organizations.id ON DELETE cascade | --             | The owning org (may be a sub-org)               |
| name                    | text          | NOT NULL                                           | --             |                                                 |
| description             | text          | nullable                                           | null           |                                                 |
| status                  | text          | NOT NULL                                           | `'active'`     | `active`/`deleted`; runtime accepts active only |
| access_policy           | text          | NOT NULL                                           | `'open'`       | `open`/`restricted`/`approval_required` (see chapter 02 section 7.5); default preserves existing behavior |
| deleted_at              | integer ts_ms | nullable                                           | null           | Reversible Management API deletion marker       |
| created_at / updated_at | integer ts_ms | NOT NULL                                           | See 9.3        |                                                 |

Indexes: `INDEX(tenant_id, org_id)`, `INDEX(tenant_id, status, id)`,
`INDEX(tenant_id, org_id, status, id)`.

### 10.4 applications (= OAuthClient, the OIDC/SAML client)

Chapter 02's Application and chapter 03's OAuthClient are merged into one table (two views of the same
entity).

| Field                               | Type            | Constraints                                   | Default                                         | Notes                                                                                                                                                  |
| ----------------------------------- | --------------- | --------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| id                                  | text            | PK                                            | `app_`+nanoid                                   |                                                                                                                                                        |
| tenant_id                           | text            | NOT NULL, FK -> organizations.id              | --                                              | Isolation key                                                                                                                                          |
| project_id                          | text            | FK -> projects.id ON DELETE cascade, nullable | null                                            | Bound project (inheriting its role set, see chapter 02 section 1); a platform-level app may be null                                                    |
| client_id                           | text            | NOT NULL, UNIQUE                              | = id or an independent string                   | The OAuth client_id, exposed externally                                                                                                                |
| client_secret_hash                  | text            | nullable                                      | null                                            | Hashed storage (see chapter 03 section 4; plaintext is never stored); null for public clients                                                          |
| client_type                         | text            | NOT NULL                                      | `'confidential'`                                | `confidential`/`public`/`native`/`m2m` (see chapter 03 section 4)                                                                                      |
| token_endpoint_auth_method          | text            | NOT NULL                                      | `'client_secret_basic'`                         | `client_secret_basic`/`client_secret_post`/`private_key_jwt`/`tls_client_auth`/`self_signed_tls_client_auth`/`none` (see chapter 03 section 9.6)       |
| jwks                                | text json       | nullable                                      | null                                            | The client's public key set for private_key_jwt                                                                                                        |
| redirect_uris                       | text json       | NOT NULL                                      | `[]`                                            | An exact-match array; wildcards are forbidden (see the oidc-oauth rule)                                                                                |
| post_logout_redirect_uris           | text json       | NOT NULL                                      | `[]`                                            | Used by end_session                                                                                                                                    |
| frontchannel_logout_uri             | text            | nullable                                      | null                                            | (see chapter 03 section 7)                                                                                                                             |
| backchannel_logout_uri              | text            | nullable                                      | null                                            |                                                                                                                                                        |
| backchannel_logout_session_required | integer boolean | NOT NULL                                      | `0`                                             | RFC 7591/7592 client metadata; supported because every logout_token carries sid                                                                        |
| allowed_grant_types                 | text json       | NOT NULL                                      | `["authorization_code","refresh_token"]`        | Allowlist (see chapter 03 section 9.0 step 5)                                                                                                          |
| allowed_response_types              | text json       | NOT NULL                                      | `["code"]`                                      |                                                                                                                                                        |
| allowed_scopes                      | text json       | NOT NULL                                      | `["openid","profile","email","offline_access"]` | The client_credentials scope allowlist                                                                                                                 |
| require_pkce                        | integer boolean | NOT NULL                                      | `1`                                             | Mandatory for public clients; configurable for confidential ones (PKCE downgrade defense, see chapter 03 section 9.1)                                  |
| dpop_bound_access_tokens            | integer boolean | NOT NULL                                      | `0`                                             | Registration requires DPoP (see chapter 03 section 9.0 step 6)                                                                                         |
| access_token_format                 | text            | NOT NULL                                      | `'jwt'`                                         | `jwt`/`opaque` (see chapter 03 section 3)                                                                                                              |
| access_token_ttl_sec                | integer number  | nullable                                      | null                                            | Nullable; NULL means inherit the tenant token policy (the three-level chain application -> org -> instance, bounds 60-86400, see chapter 03 section 3) |
| id_token_signed_alg                 | text            | NOT NULL                                      | `'ES256'`                                       | Overridable per client (`RS256`/`PS256`)                                                                                                               |
| first_party                         | integer boolean | NOT NULL                                      | `0`                                             | First-party clients skip consent (see chapter 03 section 10.5)                                                                                         |
| require_org_context                 | integer boolean | NOT NULL                                      | `0`                                             | Force org selection (see chapter 02 section 4)                                                                                                         |
| custom_claims_config                | text json       | NOT NULL                                      | `{}`                                            | Client-level custom claim injection declaration (see chapter 02 section 7.1; keys MUST be declared explicitly)                                         |
| registration_access_token_hash      | text            | nullable                                      | null                                            | The RFC 7592 dynamic registration management token hash                                                                                                |
| status                              | text            | NOT NULL                                      | `'active'`                                      | `active`/`inactive`                                                                                                                                    |
| created_at / updated_at             | integer ts_ms   | NOT NULL                                      | See 9.3                                         |                                                                                                                                                        |

Indexes: `UNIQUE(client_id)`, `INDEX(tenant_id, project_id)`, `INDEX(tenant_id, status)`.

### 10.5 project_grants (cross-organization authorization)

| Field                   | Type          | Constraints                                        | Default         | Notes                                                                                                        |
| ----------------------- | ------------- | -------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------ |
| id                      | text          | PK                                                 | `grant_`+nanoid |                                                                                                              |
| tenant_id               | text          | NOT NULL, FK -> organizations.id                   | --              | The tenant of granted_by_org_id (the Project owner, org A; see the iss discussion in chapter 02 section 7.4) |
| granted_project_id      | text          | NOT NULL, FK -> projects.id ON DELETE cascade      | --              | The granted Project P                                                                                        |
| granted_by_org_id       | text          | NOT NULL, FK -> organizations.id ON DELETE cascade | --              | org A (the Project owner)                                                                                    |
| granted_to_org_id       | text          | NOT NULL, FK -> organizations.id ON DELETE cascade | --              | org B (the grantee)                                                                                          |
| status                  | text          | NOT NULL                                           | `'active'`      | `active`/`revoked`                                                                                           |
| revoked_at              | integer ts_ms | nullable                                           | null            | Revocation time (cascades to invalidate UserGrants, see chapter 02 section 7.4)                              |
| created_at / updated_at | integer ts_ms | NOT NULL                                           | See 9.3         |                                                                                                              |

Indexes: `UNIQUE(granted_project_id, granted_to_org_id)`, `INDEX(granted_to_org_id)`,
`INDEX(tenant_id)`.

### 10.6 org_policies (per-org policy overrides)

One row per org; a field left null falls back to the instance default (see chapter 02 section 5).

| Field                         | Type            | Constraints                                                | Default | Notes                                                                                                                                                                                                                                           |
| ----------------------------- | --------------- | ---------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                            | text            | PK                                                         | nanoid  |                                                                                                                                                                                                                                                 |
| tenant_id                     | text            | NOT NULL, FK -> organizations.id                           | --      |                                                                                                                                                                                                                                                 |
| org_id                        | text            | NOT NULL, UNIQUE, FK -> organizations.id ON DELETE cascade | --      | 1:1 with the org                                                                                                                                                                                                                                |
| mfa_policy                    | text            | nullable                                                   | null    | `required`/`optional`/`disabled`; null falls back (see the three-level inheritance in the password-auth rule)                                                                                                                                   |
| mfa_allowed_methods           | text json       | nullable                                                   | null    | Method allowlist                                                                                                                                                                                                                                |
| password_policy               | text json       | nullable                                                   | null    | Override fields                                                                                                                                                                                                                                 |
| session_idle_timeout_min      | integer number  | nullable                                                   | null    | Overrides the instance session idle timeout; null means inherit from the instance (see chapter 05 section 8)                                                                                                                                    |
| session_absolute_timeout_days | integer number  | nullable                                                   | null    | Overrides the instance session absolute timeout; null means inherit from the instance (see chapter 05 section 8)                                                                                                                                |
| token_policy                  | text json       | nullable                                                   | null    | Overrides the instance token policy; four snake_case fields (access_token_ttl_sec / session_token_ttl_sec / refresh_idle_timeout_days / refresh_absolute_timeout_days), each null field inheriting from the instance (see chapter 03 section 3) |
| force_sso                     | integer boolean | NOT NULL                                                   | `0`     | Disallow password sign-in once SSO is bound (see chapter 02 section 5)                                                                                                                                                                          |
| allow_password_login          | integer boolean | NOT NULL                                                   | `1`     |                                                                                                                                                                                                                                                 |
| created_at / updated_at       | integer ts_ms   | NOT NULL                                                   | See 9.3 |                                                                                                                                                                                                                                                 |

Indexes: `UNIQUE(org_id)`.

## 11. User and identity entities

### 11.1 users (the platform-level user principal, see chapter 05 section 1)

User is a platform-level entity associated with orgs through Membership. `tenant_id` still records the
tenant it belongs to (in B2C it hangs directly off the instance's root org).

| Field                     | Type            | Constraints                                       | Default        | Notes                                                                                                                                                                                                                                                                              |
| ------------------------- | --------------- | ------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                        | text            | PK                                                | `user_`+nanoid | Also the JWT sub (see chapter 05 section 8.1)                                                                                                                                                                                                                                      |
| tenant_id                 | text            | NOT NULL, FK -> organizations.id                  | --             | The owning tenant                                                                                                                                                                                                                                                                  |
| username                  | text            | nullable                                          | null           | See 9.5 `UNIQUE(tenant_id,username)`                                                                                                                                                                                                                                               |
| external_id               | text            | nullable                                          | null           | See 9.5 `UNIQUE(tenant_id,external_id)`                                                                                                                                                                                                                                            |
| primary_email_id          | text            | FK -> user_emails.id ON DELETE set null, nullable | null           | Primary email (see chapter 05 section 1; a change requires re-verification)                                                                                                                                                                                                        |
| pending_email             | text            | nullable                                          | null           | Unproved Email for top-level Tenant onboarding; returned by `/v1/me` with `emailVerified=false`, but does not reserve `user_emails`                                                                                                                                                |
| primary_phone_id          | text            | FK -> user_phones.id ON DELETE set null, nullable | null           | Primary phone                                                                                                                                                                                                                                                                      |
| first_name                | text            | nullable                                          | null           |                                                                                                                                                                                                                                                                                    |
| last_name                 | text            | nullable                                          | null           |                                                                                                                                                                                                                                                                                    |
| display_name              | text            | nullable                                          | null           |                                                                                                                                                                                                                                                                                    |
| avatar_url                | text            | nullable                                          | null           | R2 avatar                                                                                                                                                                                                                                                                          |
| locale                    | text            | nullable                                          | null           | Falls back to the tenant or instance when absent (see chapter 07 section 4)                                                                                                                                                                                                        |
| timezone                  | text            | nullable                                          | null           |                                                                                                                                                                                                                                                                                    |
| public_metadata           | text json       | NOT NULL                                          | `{}`           | Backend-written, frontend read-only (see chapter 05 section 1)                                                                                                                                                                                                                     |
| private_metadata          | text json       | NOT NULL                                          | `{}`           | Server only, not returned by default                                                                                                                                                                                                                                               |
| unsafe_metadata           | text json       | NOT NULL                                          | `{}`           | Writable by both frontend and backend                                                                                                                                                                                                                                              |
| custom_attributes         | text json       | NOT NULL                                          | `{}`           | Tenant-defined extra fields (see chapter 05 section 1; a generated column index can be configured)                                                                                                                                                                                 |
| status                    | text            | NOT NULL                                          | `'active'`     | `active`/`banned`/`locked`/`suspended`/`pending_mfa_setup`/`deactivated`/`deleted` (see chapter 05 section 5, mandatory MFA in password-auth, and deprovisioning in chapter 04)                                                                                                    |
| password_change_required  | integer boolean | NOT NULL                                          | `0`            | Forced password change flag (see chapter 05 section 6)                                                                                                                                                                                                                             |
| is_new_user               | integer boolean | NOT NULL                                          | `1`            | First sign-in onboarding (see chapter 05 section 2)                                                                                                                                                                                                                                |
| profile_completion_status | text            | NOT NULL                                          | `'incomplete'` | Progressive profiling (see chapter 05 section 2)                                                                                                                                                                                                                                   |
| lockout_until             | integer ts_ms   | nullable                                          | null           | Account lockout expiry (exponential backoff, see the anti-abuse rule)                                                                                                                                                                                                              |
| failed_login_count        | integer number  | NOT NULL                                          | `0`            | Consecutive failure counter (triggers lockout)                                                                                                                                                                                                                                     |
| last_login_at             | integer ts_ms   | nullable                                          | null           |                                                                                                                                                                                                                                                                                    |
| merged_into_user_id       | text            | FK -> users.id ON DELETE set null, nullable       | null           | Account merging: the secondary account points at the primary (see chapter 05 section 3)                                                                                                                                                                                            |
| provisioned_by            | text            | nullable                                          | null           | `jit_sso`/`scim`/`signup`/`invite`/`admin`/`anonymous`/`hosted_password`/`hosted_passwordless`/`hosted_passkey`/`invitation_email_claim` (see chapter 04 section 4; `anonymous` = guest user, `hosted_*` = hosted-UI credential provisioning, and `invitation_email_claim` marks a credential-free identity created only after exact invitation Email proof) |
| deleted_at                | integer ts_ms   | nullable                                          | null           | Soft delete (PII hard-deleted after 30 days, see chapter 05 section 7)                                                                                                                                                                                                             |
| created_at / updated_at   | integer ts_ms   | NOT NULL                                          | See 9.3        |                                                                                                                                                                                                                                                                                    |

Indexes: `UNIQUE(tenant_id, username)`, `UNIQUE(tenant_id, external_id)`, `INDEX(tenant_id, status)`,
`INDEX(tenant_id, created_at)`, `INDEX(primary_email_id)`, `INDEX(merged_into_user_id)`.
primary_email_id/primary_phone_id and user_emails/user_phones reference each other, so after table
creation use a deferred FK or maintain it at the application layer (SQLite does not support
ALTER ADD FK; declaring the FK in Drizzle is sufficient, and it is not enforced at runtime).

Guest lifecycle (see chapter 01 section 8): a daily GC cron soft-deletes users with
`provisioned_by = 'anonymous'` whose last activity is 30 days old or more (`created_at` when the
user has no session, otherwise the newest session's `last_active_at`); they enter the same 30-day
hard-delete PII pipeline as any other soft-deleted user (see chapter 05 section 7), with the audit
event `guest.gc_deleted`. Guest rows are excluded from MeteringDO MAU deduplication (see 17.3), so
free trials do not inflate MAU billing.

An unused anonymous provisional user enters the same 30-day lifecycle when it has no Membership, or
only the owner Membership of its safe empty onboarding top-level Tenant. If it never verified
`pending_email`, cleanup revokes its sessions, inactivates that owner Membership, and soft-deletes
the onboarding Organization and user. Migrated user-owned rows remain under the normal PII retention
pipeline. A Tenant with another active member, a child Organization, or a business resource is
skipped intact.

### 11.2 user_emails (multi-valued email, see chapter 05 section 1)

| Field                   | Type            | Constraints                                | Default        | Notes                                                                                           |
| ----------------------- | --------------- | ------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------- |
| id                      | text            | PK                                         | nanoid         |                                                                                                 |
| tenant_id               | text            | NOT NULL, FK -> organizations.id           | --             | Isolation key                                                                                   |
| user_id                 | text            | NOT NULL, FK -> users.id ON DELETE cascade | --             |                                                                                                 |
| email                   | text            | NOT NULL                                   | --             | See 9.5 `UNIQUE(tenant_id,email)`                                                               |
| verified                | integer boolean | NOT NULL                                   | `0`            | Verified state (state machine unverified -> pending -> verified, see chapter 05 section 4)      |
| verification_status     | text            | NOT NULL                                   | `'unverified'` | `unverified`/`pending`/`verified`/`expired`                                                     |
| is_primary              | integer boolean | NOT NULL                                   | `0`            | Whether it is the primary email (redundant; the main table's primary_email_id is authoritative) |
| verified_at             | integer ts_ms   | nullable                                   | null           |                                                                                                 |
| ownership_proof         | text            | nullable                                   | null           | `invitation_email_claim_v1` only when this exact Email row was created by the proof-first claim ceremony |
| ownership_proof_ceremony_id | text        | nullable, partial UNIQUE                   | null           | The invitation id whose successful Email ceremony established this row; never copied during Email change |
| ownership_proven_at     | integer ts_ms   | nullable                                   | null           | When the exact Email/User binding was proven                                                     |
| created_at / updated_at | integer ts_ms   | NOT NULL                                   | See 9.3        |                                                                                                 |

Indexes: `UNIQUE(tenant_id, email)`, `INDEX(tenant_id, user_id)`, partial
`UNIQUE(tenant_id, ownership_proof_ceremony_id) WHERE ownership_proof_ceremony_id IS NOT NULL`, and
`INDEX(tenant_id, ownership_proof, user_id)`.

Invitation-claim reuse requires the whole provenance tuple, not `verified` alone: this row must be
the User's exact verified primary Email, `ownership_proof = invitation_email_claim_v1` and
`ownership_proof_ceremony_id`/`ownership_proven_at` must remain present, while the owning User must
still be active, unmerged, and `provisioned_by = invitation_email_claim`. Changing or detaching the
Email does not transfer these fields to another row.

### 11.3 user_phones (multi-valued phone, see chapter 05 section 1)

| Field                   | Type            | Constraints                                | Default        | Notes                                           |
| ----------------------- | --------------- | ------------------------------------------ | -------------- | ----------------------------------------------- |
| id                      | text            | PK                                         | nanoid         |                                                 |
| tenant_id               | text            | NOT NULL, FK -> organizations.id           | --             |                                                 |
| user_id                 | text            | NOT NULL, FK -> users.id ON DELETE cascade | --             |                                                 |
| phone                   | text            | NOT NULL                                   | --             | E.164 format, see 9.5 `UNIQUE(tenant_id,phone)` |
| verified                | integer boolean | NOT NULL                                   | `0`            |                                                 |
| verification_status     | text            | NOT NULL                                   | `'unverified'` | Same as user_emails                             |
| is_primary              | integer boolean | NOT NULL                                   | `0`            |                                                 |
| verified_at             | integer ts_ms   | nullable                                   | null           |                                                 |
| created_at / updated_at | integer ts_ms   | NOT NULL                                   | See 9.3        |                                                 |

Indexes: `UNIQUE(tenant_id, phone)`, `INDEX(tenant_id, user_id)`.

### 11.4 user_identities (sign-in method to User association plus social bindings, see chapter 05 section 3 and chapter 01 section 3)

This merges the identity linking index with social bindings. Social provider tokens are stored
encrypted in this table.

| Field                    | Type          | Constraints                                | Default       | Notes                                                                                                                                      |
| ------------------------ | ------------- | ------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| id                       | text          | PK                                         | `idn_`+nanoid |                                                                                                                                            |
| tenant_id                | text          | NOT NULL, FK -> organizations.id           | --            |                                                                                                                                            |
| user_id                  | text          | NOT NULL, FK -> users.id ON DELETE cascade | --            |                                                                                                                                            |
| identity_type            | text          | NOT NULL                                   | --            | `password`/`passkey`/`social`/`saml`/`oidc` (see chapter 05 section 3)                                                                     |
| provider                 | text          | nullable                                   | null          | For social/sso: `google`/`github`/`apple`/`saml:{conn}` and so on (see chapter 01 section 3)                                               |
| provider_user_id         | text          | nullable                                   | null          | The idp_id (SAML NameID or OIDC sub, see chapter 04 section 1); see 9.5 `UNIQUE(tenant_id,provider,provider_user_id)`                      |
| access_token_ciphertext  | blob buffer   | nullable                                   | null          | AES-256-GCM envelope encryption, format `version\|\|iv\|\|ciphertext\|\|tag` (see token encryption key derivation in chapter 01 section 3) |
| refresh_token_ciphertext | blob buffer   | nullable                                   | null          | Same as above                                                                                                                              |
| token_expires_at         | integer ts_ms | nullable                                   | null          | Provider token expiry                                                                                                                      |
| scopes                   | text json     | nullable                                   | null          | Provider-granted scopes                                                                                                                    |
| profile_raw              | text json     | nullable                                   | null          | The provider's raw profile (used for field mapping)                                                                                        |
| last_used_at             | integer ts_ms | nullable                                   | null          |                                                                                                                                            |
| revoked_at               | integer ts_ms | nullable                                   | null          | Unlink/revocation marker (non-null means invalid; active queries use a partial index)                                                      |
| created_at / updated_at  | integer ts_ms | NOT NULL                                   | See 9.3       |                                                                                                                                            |

Indexes: `UNIQUE(tenant_id, provider, provider_user_id)` (effective when provider_user_id is
non-null), `INDEX(tenant_id, user_id)`, `INDEX(tenant_id, identity_type)`.

> The encrypted byte layout is fixed:
> `access_token_ciphertext = version(1B) || iv(12B) || ciphertext(variable) || tag(16B)`. The KEK is
> the account-level `env.KEK` (Workers Secrets). This table has no separate kek_version column;
> version=1 is hard-coded into the first ciphertext byte (worker/auth/social-providers.ts
> encryptToken). A dedicated kek_version column exists only on cert_store and instance_signing_keys
> (see 16.2 and 16.3). Plaintext tokens never enter the database.

### 11.5 gdpr_consents (GDPR data processing consent, see chapter 05 section 7; OIDC scope consent is a different table, oauth_consents, see 15.5)

> Naming disambiguation: this table holds GDPR consent (terms and marketing) and is named
> `gdpr_consents`; persisted OIDC client scope authorization is a different table named
> `oauth_consents` (see 13.4). In this chapter's entity inventory, "Consent" means GDPR and
> "UserConsent" means OIDC scope.

gdpr_consents:

| Field                   | Type            | Constraints                                | Default | Notes                                            |
| ----------------------- | --------------- | ------------------------------------------ | ------- | ------------------------------------------------ |
| id                      | text            | PK                                         | nanoid  |                                                  |
| tenant_id               | text            | NOT NULL, FK -> organizations.id           | --      |                                                  |
| user_id                 | text            | NOT NULL, FK -> users.id ON DELETE cascade | --      |                                                  |
| consent_type            | text            | NOT NULL                                   | --      | `terms`/`privacy`/`marketing`/...                |
| granted                 | integer boolean | NOT NULL                                   | --      | Opt-in or opt-out                                |
| source_ip               | text            | nullable                                   | null    | The consent source IP (see chapter 05 section 7) |
| granted_at              | integer ts_ms   | NOT NULL                                   | now     | Timestamp                                        |
| created_at / updated_at | integer ts_ms   | NOT NULL                                   | See 9.3 |                                                  |

Indexes: `INDEX(tenant_id, user_id, consent_type)`.

## 12. Credential and authentication entities

### 12.1 passwords (password hashes, see chapter 01 section 2 and the password-auth rule)

| Field                   | Type            | Constraints                                        | Default      | Notes                                                                                                                              |
| ----------------------- | --------------- | -------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| id                      | text            | PK                                                 | nanoid       |                                                                                                                                    |
| tenant_id               | text            | NOT NULL, FK -> organizations.id                   | --           |                                                                                                                                    |
| user_id                 | text            | NOT NULL, UNIQUE, FK -> users.id ON DELETE cascade | --           | 1:1 with the current password                                                                                                      |
| hash                    | text            | NOT NULL                                           | --           | A PHC string (Argon2id `$argon2id$v=19$m=65536,t=3,p=...`; see password-auth memory=64MiB/iter=3)                                  |
| algo                    | text            | NOT NULL                                           | `'argon2id'` | `argon2id`/`bcrypt`/`scrypt`/`md5` (migration compatibility, see lazy migration in chapter 05 section 5)                           |
| pepper_version          | integer number  | NOT NULL                                           | --           | The pepper version (the pepper lives in Workers Secrets and never enters the database, see password-auth)                          |
| reuse_tag               | text            | nullable                                           | null         | `HMAC-SHA256(pepper, normalize(password))` with a prefix, for cross-algorithm reuse detection independent of the hashing algorithm |
| breached                | integer boolean | NOT NULL                                           | `0`          | HIBP pwned marker (see password-auth; once marked, the next sign-in prompts a reset)                                               |
| breach_checked_at       | integer ts_ms   | nullable                                           | null         |                                                                                                                                    |
| created_at / updated_at | integer ts_ms   | NOT NULL                                           | See 9.3      |                                                                                                                                    |

Indexes: `UNIQUE(user_id)`.

### 12.2 password_history (password history for reuse rejection, see password-auth)

| Field      | Type          | Constraints                                | Default | Notes                                                                                                     |
| ---------- | ------------- | ------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------- |
| id         | text          | PK                                         | nanoid  |                                                                                                           |
| tenant_id  | text          | NOT NULL, FK -> organizations.id           | --      |                                                                                                           |
| user_id    | text          | NOT NULL, FK -> users.id ON DELETE cascade | --      |                                                                                                           |
| hash       | text          | NOT NULL                                   | --      | The old password hash                                                                                     |
| reuse_tag  | text          | nullable                                   | null    | Same as passwords.reuse_tag, for reuse detection on history entries                                       |
| created_at | integer ts_ms | NOT NULL                                   | See 9.3 | When it entered history; the most recent N are kept (5 by default), and the oldest beyond that is deleted |

Indexes: `INDEX(tenant_id, user_id, created_at)`.

### 12.3 password_reset_tokens (reset tokens, hash only, see chapter 01 section 2)

| Field       | Type          | Constraints                                | Default            | Notes                                                                                                                         |
| ----------- | ------------- | ------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| id          | text          | PK                                         | nanoid             |                                                                                                                               |
| tenant_id   | text          | NOT NULL, FK -> organizations.id           | --                 |                                                                                                                               |
| user_id     | text          | NOT NULL, FK -> users.id ON DELETE cascade | --                 |                                                                                                                               |
| token_hash  | text          | NOT NULL, UNIQUE                           | --                 | `SHA-256(token)`; the plaintext never enters the database (see password-auth, defending against replay after a database leak) |
| purpose     | text          | NOT NULL                                   | `'password_reset'` | `email_verify`/`phone_verify`/`password_reset` (the shared short-lived token table, see chapter 05 section 4)                 |
| consumed_at | integer ts_ms | nullable                                   | null               | Single use; filled in on consumption                                                                                          |
| expires_at  | integer ts_ms | NOT NULL                                   | now+15min          | Valid for 15 minutes                                                                                                          |
| created_at  | integer ts_ms | NOT NULL                                   | See 9.3            |                                                                                                                               |

Indexes: `UNIQUE(token_hash)`, `INDEX(tenant_id, user_id)`.

### 12.3a verification_tokens (the shared short-lived token table for magic link and OTP, = the OtpCode/MagicLinkToken entities, see chapter 01 section 4)

| Field         | Type           | Constraints                                | Default | Notes                                                                                                                    |
| ------------- | -------------- | ------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| id            | text           | PK                                         | nanoid  |                                                                                                                          |
| tenant_id     | text           | NOT NULL, FK -> organizations.id           | --      |                                                                                                                          |
| user_id       | text           | NOT NULL, FK -> users.id ON DELETE cascade | --      |                                                                                                                          |
| token_hash    | text           | NOT NULL, UNIQUE                           | --      | Magic link `SHA-256(jti)` or the opaque OTP row token; the plaintext magic-link JWT never enters the database            |
| code_hash     | text           | nullable                                   | null    | OTP SHA-256 (null for non-OTP purposes)                                                                                  |
| flow_context  | text json      | nullable                                   | null    | Versioned `PasswordlessFlowContext` frozen at send time: intent, safe continuation, and application client id            |
| channel       | text           | nullable                                   | null    | `email`/`sms`/`whatsapp`                                                                                                 |
| purpose       | text           | NOT NULL                                   | --      | `magic_link`/`otp` and so on, distinguishing the purpose                                                                 |
| attempt_count | integer number | NOT NULL                                   | `0`     | OTP failure counter; invalidated after at most 5 (see chapter 01 section 4)                                              |
| consumed_at   | integer ts_ms  | nullable                                   | null    | Single use; filled in on consumption                                                                                     |
| expires_at    | integer ts_ms  | NOT NULL                                   | --      | magic link 15min / email OTP 10min / phone OTP 5min (see chapter 01 section 4)                                           |
| created_at    | integer ts_ms  | NOT NULL                                   | See 9.3 |                                                                                                                          |

Indexes: `UNIQUE(token_hash)`, `INDEX(tenant_id, user_id)`, and the partial
`UNIQUE(tenant_id, user_id, purpose, coalesce(channel,'')) WHERE consumed_at IS NULL AND purpose IN ('magic_link','otp')`
(at most one active row per user, purpose, and channel; a resend invalidates the old row first).

New passwordless `magic_link` and `otp` rows require `flow_context`; an SMS OTP row used only as an
MFA factor may leave it null. It stores only bounded, normalized control data and never an invitation
token or row id. Invitation Email ownership uses the separate proof-first fields on `invitations`
below and cannot be resumed through an ordinary passwordless verification row. For magic links, the
identical serialization is signed into the JWT and MUST equal the D1 value before consumption. The
verifier uses this frozen context rather than any changed continuation parameters on the verification
request.

For `purpose = 'email_verification'`, the signed JWT carries `email_hash`, the SHA-256 of the exact
normalized Email targeted at issue time. D1 continues to store only the jti hash in
`verification_tokens.token_hash`; no plaintext Email or additional target column is required.
Consumption compares the signed `email_hash` with the current primary Email or
`users.pending_email`, then updates only the matching target. A changed target invalidates the
token, and resend invalidates the prior active token before issuing a replacement.

### 12.4 passkey_credentials (WebAuthn credentials, see chapter 01 section 1 and the webauthn rule)

| Field                           | Type            | Constraints                                | Default      | Notes                                                                                                                                                                                                                        |
| ------------------------------- | --------------- | ------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                              | text            | PK                                         | `pk_`+nanoid |                                                                                                                                                                                                                              |
| tenant_id                       | text            | NOT NULL, FK -> organizations.id           | --           |                                                                                                                                                                                                                              |
| user_id                         | text            | NOT NULL, FK -> users.id ON DELETE cascade | --           |                                                                                                                                                                                                                              |
| credential_id                   | text            | NOT NULL                                   | --           | base64url(rawId), see 9.5 `UNIQUE(tenant_id,credential_id)` (registration step 7)                                                                                                                                            |
| public_key                      | blob buffer     | NOT NULL                                   | --           | **The raw COSE_Key bytes** (a CBOR map, see registration step 9 in chapter 01), imported directly at authentication time; JWK JSON is not stored (the normalized COSE bytes are the source of truth, avoiding renegotiation) |
| cose_alg                        | integer number  | NOT NULL                                   | --           | The COSE alg label: `-7` (ES256) / `-257` (RS256) / `-8` (EdDSA), see COSE parsing in chapter 01                                                                                                                             |
| aaguid                          | blob buffer     | NOT NULL                                   | --           | The 16-byte authenticator model identifier (platform-synced passkeys may be all zeros, see sign_count in chapter 01)                                                                                                         |
| sign_count                      | integer number  | NOT NULL                                   | `0`          | Clone detection counter (uint32, see the webauthn rule)                                                                                                                                                                      |
| transports                      | text json       | NOT NULL                                   | `[]`         | `["internal","hybrid","usb","nfc","ble"]`                                                                                                                                                                                    |
| credential_device_type          | text            | NOT NULL                                   | --           | `singleDevice`/`multiDevice` (derived from the BE bit, see authData flags in chapter 01)                                                                                                                                     |
| backed_up                       | integer boolean | NOT NULL                                   | `0`          | Derived from the BS bit (credentialBackedUp)                                                                                                                                                                                 |
| device_name                     | text            | nullable                                   | null         | User-nameable                                                                                                                                                                                                                |
| attestation_fmt                 | text            | NOT NULL                                   | `'none'`     | `none`/`packed`/`tpm`/`apple`... (parsed for enterprise attestation, see registration step 6 in chapter 01)                                                                                                                  |
| enterprise_attestation_verified | integer boolean | NOT NULL                                   | `0`          | The result of the enterprise attestation chain check performed by `verifyRegistration`. It records authenticator trust metadata but does not by itself elevate a session above AAL2                                          |
| last_used_at                    | integer ts_ms   | nullable                                   | null         |                                                                                                                                                                                                                              |
| revoked_at                      | integer ts_ms   | nullable                                   | null         | Credential revocation (deleting a passkey sets this marker; active queries use a partial index)                                                                                                                              |
| created_at / updated_at         | integer ts_ms   | NOT NULL                                   | See 9.3      |                                                                                                                                                                                                                              |

Indexes: `UNIQUE(tenant_id, credential_id)`, `INDEX(tenant_id, user_id)`. The per-account cap is 10
(enforced at the application layer, see the webauthn rule). Private keys never enter the database.

### 12.5 mfa_factors (MFA factors, see chapter 01 section 5 and the password-auth rule)

| Field                   | Type            | Constraints                                              | Default       | Notes                                                                                                                         |
| ----------------------- | --------------- | -------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| id                      | text            | PK                                                       | `mfa_`+nanoid |                                                                                                                               |
| tenant_id               | text            | NOT NULL, FK -> organizations.id                         | --            |                                                                                                                               |
| user_id                 | text            | NOT NULL, FK -> users.id ON DELETE cascade               | --            |                                                                                                                               |
| factor_type             | text            | NOT NULL                                                 | --            | `totp`/`sms`/`email`/`passkey`/`backup_code` (see chapter 01 section 5)                                                       |
| status                  | text            | NOT NULL                                                 | `'pending'`   | `pending` (enrolled but unconfirmed) / `active` / `disabled`; becomes active after one valid code                             |
| secret_ciphertext       | blob buffer     | nullable                                                 | null          | The TOTP secret under AES-256-GCM (`version\|\|iv\|\|ciphertext\|\|tag`, see chapter 01 section 5); null for non-TOTP factors |
| target                  | text            | nullable                                                 | null          | The recipient for sms/email factors (redundant, for display)                                                                  |
| passkey_credential_id   | text            | FK -> passkey_credentials.id ON DELETE cascade, nullable | null          | Referenced when a passkey acts as a second factor                                                                             |
| is_default              | integer boolean | NOT NULL                                                 | `0`           | The default factor                                                                                                            |
| last_used_at            | integer ts_ms   | nullable                                                 | null          |                                                                                                                               |
| activated_at            | integer ts_ms   | nullable                                                 | null          |                                                                                                                               |
| created_at / updated_at | integer ts_ms   | NOT NULL                                                 | See 9.3       |                                                                                                                               |

Indexes: `INDEX(tenant_id, user_id)`, `INDEX(tenant_id, user_id, factor_type)`.

### 12.6 backup_codes (single-use recovery codes managed in batches, see chapter 01 section 5)

10 per batch, 8 characters each, stored as HMAC-SHA256 hashes, shown once, and regenerating a batch
invalidates the old one.

| Field      | Type            | Constraints                                | Default | Notes                                                                                     |
| ---------- | --------------- | ------------------------------------------ | ------- | ----------------------------------------------------------------------------------------- |
| id         | text            | PK                                         | nanoid  |                                                                                           |
| tenant_id  | text            | NOT NULL, FK -> organizations.id           | --      |                                                                                           |
| user_id    | text            | NOT NULL, FK -> users.id ON DELETE cascade | --      |                                                                                           |
| batch_id   | text            | NOT NULL                                   | --      | Shared within a batch; regenerating produces a new batch_id and invalidates the old batch |
| code_hash  | text            | NOT NULL                                   | --      | HMAC-SHA256(code)                                                                         |
| used       | integer boolean | NOT NULL                                   | `0`     | Single use                                                                                |
| used_at    | integer ts_ms   | nullable                                   | null    |                                                                                           |
| created_at | integer ts_ms   | NOT NULL                                   | See 9.3 |                                                                                           |

Indexes: `INDEX(tenant_id, user_id, batch_id)`, `INDEX(tenant_id, code_hash)`.

### 12.7 trusted_devices (remembered devices, see chapter 01 section 7 and the anti-abuse rule)

| Field             | Type          | Constraints                                | Default       | Notes                                                                                                               |
| ----------------- | ------------- | ------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------- |
| id                | text          | PK                                         | `dev_`+nanoid |                                                                                                                     |
| tenant_id         | text          | NOT NULL, FK -> organizations.id           | --            |                                                                                                                     |
| user_id           | text          | NOT NULL, FK -> users.id ON DELETE cascade | --            |                                                                                                                     |
| device_token_hash | text          | NOT NULL                                   | --            | The SHA-256 of the signed cookie token (30 days, see chapter 01 section 7); the plaintext never enters the database |
| fingerprint_hash  | text          | NOT NULL                                   | --            | SHA-256(UA + IP range + Accept-Language + TLS fingerprint), so no single signal is decisive                         |
| device_name       | text          | nullable                                   | null          |                                                                                                                     |
| last_seen_ip      | text          | nullable                                   | null          |                                                                                                                     |
| last_seen_at      | integer ts_ms | nullable                                   | null          |                                                                                                                     |
| expires_at        | integer ts_ms | NOT NULL                                   | now+30d       |                                                                                                                     |
| revoked_at        | integer ts_ms | nullable                                   | null          | User revocation (from security settings)                                                                            |
| created_at        | integer ts_ms | NOT NULL                                   | See 9.3       |                                                                                                                     |

Indexes: `INDEX(tenant_id, user_id)`, `INDEX(tenant_id, device_token_hash)`.

## 13. RBAC entities (see chapter 02 sections 3 and 7)

### 13.1 roles (Project-level roles)

| Field                   | Type          | Constraints                                   | Default        | Notes                                                                         |
| ----------------------- | ------------- | --------------------------------------------- | -------------- | ----------------------------------------------------------------------------- |
| id                      | text          | PK                                            | `role_`+nanoid |                                                                               |
| tenant_id               | text          | NOT NULL, FK -> organizations.id              | --             |                                                                               |
| project_id              | text          | NOT NULL, FK -> projects.id ON DELETE cascade | --             | A role belongs to a Project (see chapter 02 section 3)                        |
| key                     | text          | NOT NULL                                      | --             | Such as `admin`/`editor`/`viewer`, see 9.5 `UNIQUE(tenant_id,project_id,key)` |
| display_name            | text          | NOT NULL                                      | --             |                                                                               |
| group                   | text          | nullable                                      | null           | Optional grouping (see chapter 02 section 3)                                  |
| status                  | text          | NOT NULL                                      | `'active'`     | `active`/`deleted`                                                            |
| deleted_at              | integer ts_ms | nullable                                      | null           | Soft delete marker                                                            |
| created_at / updated_at | integer ts_ms | NOT NULL                                      | See 9.3        |                                                                               |

Indexes: `UNIQUE(tenant_id, project_id, key)`, `INDEX(tenant_id, project_id)`.

### 13.2 permissions (atomic capabilities `<feature>:<action>`)

| Field                   | Type          | Constraints                                   | Default        | Notes                                                                  |
| ----------------------- | ------------- | --------------------------------------------- | -------------- | ---------------------------------------------------------------------- |
| id                      | text          | PK                                            | `perm_`+nanoid |                                                                        |
| tenant_id               | text          | NOT NULL, FK -> organizations.id              | --             |                                                                        |
| project_id              | text          | NOT NULL, FK -> projects.id ON DELETE cascade | --             |                                                                        |
| key                     | text          | NOT NULL                                      | --             | The `document:read` format, see 9.5 `UNIQUE(tenant_id,project_id,key)` |
| description             | text          | nullable                                      | null           |                                                                        |
| status                  | text          | NOT NULL                                      | `'active'`     | `active`/`deleted`                                                     |
| deleted_at              | integer ts_ms | nullable                                      | null           | Soft delete marker                                                     |
| created_at / updated_at | integer ts_ms | NOT NULL                                      | See 9.3        |                                                                        |

Indexes: `UNIQUE(tenant_id, project_id, key)`, `INDEX(tenant_id, project_id)`.

### 13.3 role_permissions (the role-permission mapping plus the ABAC condition, see chapter 02 sections 7.2 and 7.3)

| Field                | Type          | Constraints                                      | Default      | Notes                                                                                                                       |
| -------------------- | ------------- | ------------------------------------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| id                   | text          | PK                                               | `rp_`+nanoid |                                                                                                                             |
| tenant_id            | text          | NOT NULL, FK -> organizations.id                 | --           |                                                                                                                             |
| role_id              | text          | NOT NULL, FK -> roles.id ON DELETE cascade       | --           |                                                                                                                             |
| permission_id        | text          | NOT NULL, FK -> permissions.id ON DELETE cascade | --           |                                                                                                                             |
| condition_expression | text json     | nullable                                         | null         | The ABAC v1 condition (a single condition or `{and:[...]}`, see chapter 02 section 7.3); null means granted unconditionally |
| created_at           | integer ts_ms | NOT NULL                                         | See 9.3      |                                                                                                                             |

Indexes: `UNIQUE(tenant_id, role_id, permission_id)`, `INDEX(tenant_id, role_id)`.

### 13.4 user_grants (user role grants, see chapter 02 sections 7.2 and 7.4)

| Field                   | Type          | Constraints                                         | Default      | Notes                                                                                            |
| ----------------------- | ------------- | --------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------ |
| id                      | text          | PK                                                  | `ug_`+nanoid |                                                                                                  |
| tenant_id               | text          | NOT NULL, FK -> organizations.id                    | --           | In the Grant scenario the tenant is org A (see the step 1 note in chapter 02 section 7.4)        |
| user_id                 | text          | NOT NULL, FK -> users.id ON DELETE cascade          | --           |                                                                                                  |
| project_id              | text          | NOT NULL, FK -> projects.id ON DELETE cascade       | --           |                                                                                                  |
| role_id                 | text          | NOT NULL, FK -> roles.id ON DELETE cascade          | --           |                                                                                                  |
| granted_via_grant_id    | text          | FK -> project_grants.id ON DELETE cascade, nullable | null         | Non-null takes the Grant query path (see chapter 02 section 7.4)                                 |
| granted_via_request_id  | text          | nullable                                            | null         | Traceability to the approved access_requests row (see 13.6); mutually exclusive with granted_via_grant_id |
| expires_at              | integer ts_ms | nullable                                            | null         | Null means permanent; a past timestamp is a just-in-time grant treated as no grant at every check (see chapter 02 section 7.5) |
| revoked_at              | integer ts_ms | nullable                                            | null         | Marked in cascade when the Grant is revoked (not physically deleted, see chapter 02 section 7.4) |
| created_at / updated_at | integer ts_ms | NOT NULL                                            | See 9.3      |                                                                                                  |

Indexes: `UNIQUE(user_id, project_id, role_id, granted_via_grant_id)`,
`INDEX(tenant_id, user_id, project_id)`, `INDEX(granted_via_grant_id)`.

### 13.5 manager_assignments (platform management roles, never in a business token, see chapter 02 section 3)

The four Manager Roles. **Completely separate from business RBAC, sharing no namespace** (see chapter
02 section 3). All platform management flows through this table (instance_manager manages every org),
and there is no separate admin tenant, admin app, admin API, or admin RBAC (global hard rule 8, see
the root AGENTS.md).

| Field                   | Type          | Constraints                                | Default       | Notes                                                                                                 |
| ----------------------- | ------------- | ------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------- |
| id                      | text          | PK                                         | `mgr_`+nanoid |                                                                                                       |
| tenant_id               | text          | NOT NULL, FK -> organizations.id           | --            | A platform-layer assignment; the tenant is the instance root or the target org's tenant               |
| user_id                 | text          | NOT NULL, FK -> users.id ON DELETE cascade | --            | The user being granted management rights                                                              |
| manager_role            | text          | NOT NULL                                   | --            | `instance_manager`/`org_manager`/`project_manager`/`project_grant_manager` (see chapter 02 section 3) |
| scope_type              | text          | NOT NULL                                   | --            | `instance`/`org`/`project`/`grant` (matching the role's scope)                                        |
| scope_id                | text          | nullable                                   | null          | The scope target id (org_id/project_id/grant_id); null for instance_manager (global)                  |
| created_at / updated_at | integer ts_ms | NOT NULL                                   | See 9.3       |                                                                                                       |

Indexes: partial `UNIQUE(tenant_id, user_id, manager_role, scope_type, scope_id) WHERE scope_id IS
NOT NULL`, partial `UNIQUE(tenant_id, user_id, manager_role, scope_type) WHERE manager_role =
'instance_manager' AND scope_type = 'instance' AND scope_id IS NULL`,
`INDEX(tenant_id, user_id)`, `INDEX(scope_type, scope_id)`.

### 13.6 access_requests (Project access requests, see chapter 02 section 7.5)

A self-service request from an active Organization member for access to a Project whose
`access_policy` is `approval_required`. Approval writes a `user_grants` row referencing this request
through `granted_via_request_id`.

| Field                   | Type          | Constraints | Default     | Notes                                                                                  |
| ----------------------- | ------------- | ----------- | ----------- | -------------------------------------------------------------------------------------- |
| id                      | text          | PK          | `ar_`+id    |                                                                                        |
| tenant_id               | text          | NOT NULL    | --          | Isolation key                                                                          |
| org_id                  | text          | NOT NULL    | --          | The Organization the request happens in (the requester's active org)                   |
| project_id              | text          | NOT NULL    | --          | The requested Project                                                                  |
| role_id                 | text          | nullable    | null        | The requested role; null leaves the choice to the approver                             |
| requester_user_id       | text          | NOT NULL    | --          |                                                                                        |
| justification           | text          | nullable    | null        | Free text, capped at the API boundary                                                  |
| status                  | text          | NOT NULL    | `'pending'` | `pending`/`approved`/`denied`/`cancelled`/`expired`; all non-pending states are terminal |
| approver_user_id        | text          | nullable    | null        | The user who actually decided                                                          |
| decided_at              | integer ts_ms | nullable    | null        |                                                                                        |
| decision_reason         | text          | nullable    | null        | Required on deny                                                                       |
| grant_expires_at        | integer ts_ms | nullable    | null        | Copied to `user_grants.expires_at` on approval (the JIT window)                        |
| created_at / updated_at | integer ts_ms | NOT NULL    | See 9.3     |                                                                                        |

Indexes: partial `UNIQUE(tenant_id, project_id, requester_user_id) WHERE status = 'pending'` (at
most one pending request per user and project), `INDEX(tenant_id, org_id, status, id)`,
`INDEX(tenant_id, project_id, status)`, `INDEX(tenant_id, requester_user_id, status)`,
`INDEX(tenant_id, approver_user_id, status)`.

Expiry is lazy: a pending request whose `created_at` is older than 14 days flips to `expired` on
read (no cron). Approve/deny run as conditional UPDATEs against `status = 'pending'`, so a
concurrent double decision loses with a conflict instead of corrupting the state machine.

## 14. Organization membership entities (see chapter 02 section 2)

### 14.1 memberships (the User-Organization relationship)

| Field                   | Type            | Constraints                                        | Default       | Notes                                                                                     |
| ----------------------- | --------------- | -------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------- |
| id                      | text            | PK                                                 | `mem_`+nanoid |                                                                                           |
| tenant_id               | text            | NOT NULL, FK -> organizations.id                   | --            |                                                                                           |
| org_id                  | text            | NOT NULL, FK -> organizations.id ON DELETE cascade | --            | The org the member belongs to                                                             |
| user_id                 | text            | NOT NULL, FK -> users.id ON DELETE cascade         | --            |                                                                                           |
| role                    | text            | NOT NULL                                           | `'member'`    | Fixed `owner`/`admin`/`member` Organization Membership role                               |
| membership_type         | text            | NOT NULL                                           | `'member'`    | `member`/`guest` (an out-of-domain collaborator, see chapter 02 section 2)                |
| status                  | text            | NOT NULL                                           | `'active'`    | `invited`/`pending`/`active`/`inactive`/`expired` (state machine in chapter 02 section 2) |
| is_managed              | integer boolean | NOT NULL                                           | `0`           | A managed member created by a verified domain (see chapter 02 section 5)                  |
| invited_by_user_id      | text            | FK -> users.id ON DELETE set null, nullable        | null          |                                                                                           |
| joined_at               | integer ts_ms   | nullable                                           | null          |                                                                                           |
| created_at / updated_at | integer ts_ms   | NOT NULL                                           | See 9.3       |                                                                                           |

Indexes: `UNIQUE(org_id, user_id)` (one row per user per org), `INDEX(tenant_id, user_id)`,
`INDEX(tenant_id, org_id, status)`.

### 14.2 invitations (invitations, see chapter 02 section 2)

| Field                   | Type           | Constraints                                        | Default       | Notes                                                                                                                                                              |
| ----------------------- | -------------- | -------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| id                      | text           | PK                                                 | `inv_`+nanoid |                                                                                                                                                                    |
| tenant_id               | text           | NOT NULL, FK -> organizations.id                   | --            |                                                                                                                                                                    |
| org_id                  | text           | NOT NULL, FK -> organizations.id ON DELETE cascade | --            |                                                                                                                                                                    |
| email                   | text           | NOT NULL                                           | --            | Exact normalized Email claim destination; the invitation capability itself does not prove ownership (see chapter 05 section 2)                                   |
| role                    | text           | NOT NULL                                           | `'member'`    | Fixed `owner`/`admin`/`member` Organization Membership role                                                                                                        |
| token_hash              | text           | NOT NULL, UNIQUE                                   | --            | The invitation token SHA-256 (stored in the database rather than as a JWT so it can be revoked, see chapter 02 section 2); the plaintext never enters the database |
| token_version           | text           | NOT NULL                                           | `'legacy'`    | `locator_v1` for tenant-bound `xid_inv_v1` capabilities; migration 0006 revokes every pending `legacy` capability and requires resend                              |
| invite_type             | text           | NOT NULL                                           | `'email'`     | `email`/`link` (a link invitation can be reusable or single use)                                                                                                   |
| max_uses                | integer number | nullable                                           | null          | Use limit for a link invitation; null means unlimited                                                                                                              |
| used_count              | integer number | NOT NULL                                           | `0`           |                                                                                                                                                                    |
| status                  | text           | NOT NULL                                           | `'pending'`   | `pending`/`claim_verified`/`accepted`/`revoked`/`expired`; `claim_verified` means Email/User provenance is durable but session/Membership acceptance may still require recovery |
| invited_by_user_id      | text           | FK -> users.id ON DELETE set null, nullable        | null          |                                                                                                                                                                    |
| accepted_by_user_id     | text           | FK -> users.id ON DELETE set null, nullable        | null          | The exact claim-proven result User that won acceptance                                                                                                             |
| email_claim_token_hash  | text           | nullable, partial UNIQUE                           | null          | `SHA-256(jti)` for the current signed `invitation_email_claim`; the plaintext claim JWT never enters D1                                                           |
| email_claim_email_hash  | text           | nullable                                           | null          | SHA-256 of the exact normalized `email`; both JWT and row must match                                                                                                |
| email_claim_expires_at  | integer ts_ms  | nullable                                           | null          | Claim expiry, 15 minutes after issue                                                                                                                               |
| email_claim_consumed_at | integer ts_ms  | nullable                                           | null          | Single-use marker; reset only when a new claim rotates the prior one                                                                                               |
| email_claim_consumption_id | text        | nullable, partial UNIQUE                           | null          | Random winning-consumption id used to gate all proof-stage mutations; it is not a bearer credential                                                               |
| email_claim_user_id     | text           | nullable                                           | null          | Result User bound by the winning proof stage; either exact reusable proven identity or the new credential-free User                                                |
| email_claim_recovery_hash | text         | nullable, partial UNIQUE                           | null          | SHA-256 of the browser-owned random `recoveryKey`; the raw key is never persisted and must accompany the original signed claim on retry                            |
| email_claim_session_id  | text           | nullable                                           | null          | Reserved/recoverable result session id                                                                                                                             |
| email_claim_session_reserved_at | integer ts_ms | nullable                                     | null          | Reservation lease start; a stale reservation may be replaced only after its old session identity is revoked                                                       |
| email_claim_finalization_id | text       | nullable, partial UNIQUE                           | null          | Random single-winner marker that gates Membership/session updates and the `claim_verified -> accepted` batch                                                       |
| displaced_user_id       | text           | nullable                                           | null          | Audit correlation for an exact Email collision only; never authorizes reuse, merge, transfer, or credential cleanup                                               |
| displaced_email_id      | text           | nullable                                           | null          | The detached `user_emails.id` for collision audit; never becomes the new User's Email row                                                                          |
| expires_at              | integer ts_ms  | NOT NULL                                           | now+72h       | Valid 24-72 hours (see chapter 02 section 2)                                                                                                                       |
| created_at / updated_at | integer ts_ms  | NOT NULL                                           | See 9.3       |                                                                                                                                                                    |

Indexes: `UNIQUE(token_hash)`, partial unique indexes for non-null `email_claim_token_hash`,
`email_claim_consumption_id`, `email_claim_recovery_hash`, and `email_claim_finalization_id`, partial
`UNIQUE(tenant_id, org_id, email) WHERE status IN ('pending', 'claim_verified')`,
`INDEX(tenant_id, org_id, status)`, and `INDEX(tenant_id, email)`.

Migration 0011 normalizes the Email of every historical pending row and deterministically retains the
newest `(tenant_id, org_id, email)` invitation, revoking older duplicates before creating the
partial unique index. This makes the index deployable on an existing database instead of assuming
that historical rows were already deduplicated.

The proof stage may reuse only the exact `user_emails`/User tuple described in section 11.2.
Otherwise an exact Email collision is handled inside the same conditional D1 batch as claim
consumption and clean User/verified Email provenance creation: invalidate the displaced User's
outstanding Email-bound verification, passwordless, and password-reset artifacts, clear a matching
`users.primary_email_id` or `users.pending_email`, delete only the conflicting `user_emails` row,
and create a new verified Email row for the credential-free User. The displaced User's credentials,
identities, sessions, Memberships, metadata, and other data are neither transferred nor scrubbed.

That proof batch commits `pending -> claim_verified`; session reservation/issuance and Membership
creation or reactivation are recoverable follow-up work. Only a conditional winner with the bound
result User, recovery hash, and usable session commits `claim_verified -> accepted`. The session
may be `active`, `pending_mfa_setup`, or `pending_mfa`, but pending status cannot authorize business
operations. Accepted retries may repair the same browser result but never repeat Membership creation
or the acceptance webhook.

### 14.3 organization_domains (organization email domains, see chapter 02 section 5 and chapter 04 section 5)

Shared by SSO routing and automatic domain assignment.

| Field                   | Type            | Constraints                                        | Default             | Notes                                                                                     |
| ----------------------- | --------------- | -------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------- |
| id                      | text            | PK                                                 | `dom_`+nanoid       |                                                                                           |
| tenant_id               | text            | NOT NULL, FK -> organizations.id                   | --                  |                                                                                           |
| org_id                  | text            | NOT NULL, FK -> organizations.id ON DELETE cascade | --                  |                                                                                           |
| domain                  | text            | NOT NULL                                           | --                  | See 9.5 `UNIQUE(domain)` (globally unique, one domain per org, see chapter 04 section 5)  |
| verification_method     | text            | NOT NULL                                           | `'dns_txt'`         | `dns_txt` (`xid-verify=<token>`) / `https_file` (see chapter 04 section 5)                |
| verification_token      | text            | NOT NULL                                           | --                  | The DNS TXT or file verification token                                                    |
| verification_status     | text            | NOT NULL                                           | `'pending'`         | `pending`/`verified`/`failed` (polled by Cron every 15 minutes, see chapter 04 section 5) |
| status                  | text            | NOT NULL                                           | `'active'`          | `active`/`deleted`                                                                        |
| is_wildcard             | integer boolean | NOT NULL                                           | `0`                 | Wildcard subdomain support (see chapter 04 section 5)                                     |
| enrollment_mode         | text            | NOT NULL                                           | `'invite_required'` | `automatic`/`invite_required`                                                             |
| verified_at             | integer ts_ms   | nullable                                           | null                |                                                                                           |
| deleted_at              | integer ts_ms   | nullable                                           | null                | Soft delete marker                                                                        |
| created_at / updated_at | integer ts_ms   | NOT NULL                                           | See 9.3             |                                                                                           |

Indexes: `UNIQUE(domain)`, `INDEX(tenant_id, org_id)`, `INDEX(verification_status)`.

## 15. OIDC / OAuth entities (see chapter 03)

### 15.1 authorization_codes (authorization codes, persisted in D1, single use, see chapter 03 section 10.4)

| Field                 | Type          | Constraints                                          | Default                | Notes                                                                                                            |
| --------------------- | ------------- | ---------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| code                  | text          | PK                                                   | `ac_`+256bit base64url | The code itself is the primary key (see chapter 03 section 10.4)                                                 |
| tenant_id             | text          | NOT NULL, FK -> organizations.id                     | --                     | Mandatory isolation (see the tenant-isolation rule)                                                              |
| client_id             | text          | NOT NULL                                             | --                     | The issuing client                                                                                               |
| user_id               | text          | NOT NULL, FK -> users.id ON DELETE cascade           | --                     |                                                                                                                  |
| session_id            | text          | nullable                                             | null                   | The hosted session association (the source of the id_token sid); empty when there is no session chain            |
| redirect_uri          | text          | nullable                                             | null                   | Stored when `/authorize` supplied it, compared exactly at the token endpoint (see chapter 03 section 9.1 step 5) |
| scope                 | text          | NOT NULL                                             | --                     | The fixed scope set (space-separated; the token inherits it and cannot widen it)                                 |
| nonce                 | text          | nullable                                             | null                   | Passed through to the id_token                                                                                   |
| code_challenge        | text          | nullable                                             | null                   | The PKCE challenge                                                                                               |
| code_challenge_method | text          | nullable                                             | null                   | `S256` (plain is rejected, see chapter 03 section 9.1)                                                           |
| dpop_jkt              | text          | nullable                                             | null                   | The authorization request `dpop_jkt` binding; the token endpoint proof MUST match                                |
| auth_time             | integer ts_ms | NOT NULL                                             | --                     | The time of full authentication (the source of the id_token auth_time)                                           |
| acr                   | text          | nullable                                             | null                   | Authentication context class                                                                                     |
| amr                   | text json     | nullable                                             | null                   | Authentication methods array                                                                                     |
| resource              | text json     | nullable                                             | null                   | RFC 8707 audience                                                                                                |
| authorization_details | text json     | nullable                                             | null                   | The RAR (RFC 9396) authorization details array                                                                   |
| active_org_id         | text          | FK -> organizations.id ON DELETE set null, nullable  | null                   | The active org context at token issuance; org B in the ProjectGrant scenario                                     |
| project_grant_id      | text          | FK -> project_grants.id ON DELETE set null, nullable | null                   | The grant id in the ProjectGrant scenario; null on the ordinary path                                             |
| consumed_at           | integer ts_ms | nullable                                             | null                   | Single-use consumption (a conditional UPDATE, see chapter 03 section 9.1 step 2)                                 |
| replay_detected_at    | integer ts_ms | nullable                                             | null                   | The replay fence: written when a code is exchanged twice, committed in the same batch as the family revocation   |
| expires_at            | integer ts_ms | NOT NULL                                             | now+60s                | Valid for 60 seconds                                                                                             |
| created_at            | integer ts_ms | NOT NULL                                             | See 9.3                |                                                                                                                  |

Indexes: PK(code), `INDEX(tenant_id, client_id)`, `INDEX(active_org_id)`, `INDEX(project_grant_id)`,
`INDEX(expires_at)` (for the Cron cleanup of expired rows).

> Storage and single-use semantics: issuance writes this D1 table (worker/oidc/authorize.ts) and
> exchange reads from D1 (worker/oidc/token-grants.ts). Single use relies on the CAS of a conditional
> `UPDATE SET consumed_at WHERE consumed_at IS NULL`; a failed CAS means a duplicate exchange, and the
> row is not deleted. Replay goes through the `replay_detected_at` fence plus cascading revocation of
> the refresh family (in the same D1 batch). OAuthFlowDO holds only the authorize parameters staged
> before sign-in, never the code itself.

> device_code and user_code state lives in a Durable Object (strongly consistent polling, see chapter
> 03 section 9.4 and the cloudflare-bindings rule) and never enters a D1 relational table; par_request
> works the same way (see chapter 03 section 10.3). The device_codes and par_requests tables below are
> logical structures inside Durable Objects, listed here for contract alignment, and **no D1 table is
> created for them**.

### 15.2 device_codes (a logical structure inside a Durable Object, not a D1 table, see chapter 03 section 9.4)

The Durable Object key is the device_code. Logical fields: `device_code` / `user_code` / `tenant_id` /
`client_id` / `scope` / `status` (`pending`/`approved`/`denied`/`expired`) / `user_id` (filled in on
approval) / `interval` (5s by default) / `last_polled_at` / `expires_at` (+600s by default) /
`approved_scope`. Polling slow_down and the state machine are described in chapter 03 section 9.4.

### 15.3 par_requests (a logical structure inside a Durable Object, not a D1 table, see chapter 03 section 10.3)

The Durable Object key is the request_uri opaque value (with the `par_` prefix). Logical fields: all
authorization parameters as JSON, plus `client_id`, `tenant_id`, and `expires_at` (+60s, single-use
consumption). It is deleted on a hit (see chapter 03 section 10.3 step 2).

### 15.4 refresh_tokens (refresh tokens, rotation plus family, see chapter 03 section 11.1)

The field table matches chapter 03 section 11.1, with the physical types filled in:

| Field                 | Type           | Constraints                                          | Default       | Notes                                                                                                                                                                        |
| --------------------- | -------------- | ---------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                    | text           | PK                                                   | `rti_`+nanoid | The token's internal id (not the token itself; the token carries the `rt_` prefix and never enters the database)                                                             |
| tenant_id             | text           | NOT NULL, FK -> organizations.id                     | --            | Mandatory tenant filter (see findByHash in chapter 03 section 11.2)                                                                                                          |
| token_hash            | text           | NOT NULL, UNIQUE                                     | --            | `SHA256(refresh_token plaintext)`, see 9.5 `UNIQUE(token_hash)`; the plaintext never enters the database                                                                     |
| family_id             | text           | NOT NULL                                             | --            | Shared by one authorization chain, generated when the first token is created (the unit of replay detection)                                                                  |
| parent_token_id       | text           | FK -> refresh_tokens.id ON DELETE set null, nullable | null          | The previous rotated token, forming a chain (null at the root)                                                                                                               |
| authorization_code    | text           | nullable                                             | null          | The originating code (used to locate the family on a code replay, see the replay fence in 15.1)                                                                              |
| user_id               | text           | NOT NULL, FK -> users.id ON DELETE cascade           | --            |                                                                                                                                                                              |
| session_id            | text           | nullable                                             | null          | The hosted session association; the first token inherits authorization_codes.session_id and rotation carries it forward (the source of the id_token sid on the refresh path) |
| client_id             | text           | NOT NULL                                             | --            | Client binding check (see chapter 03 section 9.3 step 4)                                                                                                                     |
| scope                 | text           | NOT NULL                                             | --            | The exchangeable scope set                                                                                                                                                   |
| jkt                   | text           | nullable                                             | null          | The DPoP JWK thumbprint (sender-constrained rebinding check, see chapter 03 section 9.3 step 5)                                                                              |
| active_org_id         | text           | FK -> organizations.id ON DELETE set null, nullable  | null          | Preserves the original chain's active org context so refresh rotation keeps injecting org claims                                                                             |
| project_grant_id      | text           | FK -> project_grants.id ON DELETE set null, nullable | null          | Preserves the original chain's Grant context so refresh rotation keeps using the Grant permission query path                                                                 |
| resource              | text json      | nullable                                             | null          | Preserves the original chain's RFC 8707 resource audience so refresh rotation keeps it as the access token aud                                                               |
| authorization_details | text json      | nullable                                             | null          | Preserves the original chain's RAR (RFC 9396) authorization details, inherited across rotation                                                                               |
| auth_time             | integer number | nullable                                             | null          | The Unix-second timestamp of full authentication, inherited across rotation and injected into token claims                                                                   |
| acr                   | text           | nullable                                             | null          | Authentication context class, inherited across rotation                                                                                                                      |
| amr                   | text json      | nullable                                             | null          | Authentication methods array, inherited across rotation                                                                                                                      |
| revoked_at            | integer ts_ms  | nullable                                             | null          | Non-null means invalid (rotated or revoked); a second appearance triggers family revocation (see chapter 03 section 11.2)                                                    |
| family_revoked_at     | integer ts_ms  | nullable                                             | null          | The family revocation fence (written across the whole family once a replay is confirmed; the cascading revocation marker includes ancestor rows)                             |
| expires_at            | integer ts_ms  | NOT NULL                                             | now+30d       | Idle timeout (refreshed on every rotation)                                                                                                                                   |
| absolute_expires_at   | integer ts_ms  | NOT NULL                                             | now+7d        | The family's absolute cap (fixed at creation, never extended by rotation, see chapter 03 section 11.4); the effective limit is `min(expires_at,absolute_expires_at)`         |
| created_at            | integer ts_ms  | NOT NULL                                             | See 9.3       |                                                                                                                                                                              |

Indexes: `UNIQUE(token_hash)`, `INDEX(tenant_id, family_id)` (for the batch update in family
revocation, see revokeFamily in chapter 03 section 11.2), `INDEX(tenant_id, authorization_code)`,
`INDEX(tenant_id, user_id)`, `INDEX(active_org_id)`, `INDEX(project_grant_id)`, `INDEX(expires_at)`.
Rotation and family replay detection do not depend on a Durable Object: replay determination runs
through the pure function `detectReplay` (packages/protocol/src/refresh.ts), while rotation and the
concurrent double-spend defense rely on the CAS of a conditional UPDATE
(`WHERE revoked_at IS NULL` / `WHERE family_revoked_at IS NULL`). Once a replay is confirmed,
`revokeFamily` (worker/oidc/token-grants.ts) revokes the entire family. D1 is the only fact store.

### 15.4a access_token_revocations (the JWT access token revoke denylist, see chapter 03 section 11.5)

Access token plaintext never enters the database; only the `jti` of a JWT this issuer verified is
stored. When `/revoke` matches an access token, a row is written here, and the resource endpoints
(`/userinfo`, `/introspect`) reject by `tenant_id + jti` until the token expires, at which point a
Cron job can clean it up.

The cross-tenant defense does not depend on this table: access token claims carry `tenant_id` (see
chapter 05 section 8.1), and `/introspect` and `/userinfo` compare that claim against the current
TenantContext first, returning inactive or 401 invalid_token on a mismatch. Only a same-tenant token
proceeds to the denylist lookup. The instance signing key is shared across every tenant, so a valid
signature does not imply the token belongs to the current tenant.

| Field      | Type          | Constraints                      | Default       | Notes                                                                       |
| ---------- | ------------- | -------------------------------- | ------------- | --------------------------------------------------------------------------- |
| id         | text          | PK                               | `atr_`+nanoid |                                                                             |
| tenant_id  | text          | NOT NULL, FK -> organizations.id | --            | Mandatory tenant filter                                                     |
| jti        | text          | NOT NULL                         | --            | The access token `jti`                                                      |
| client_id  | text          | NOT NULL                         | --            | The token's owning client; `/revoke` only permits the same client to revoke |
| subject    | text          | nullable                         | null          | The token `sub`, used only for audit and cleanup targeting                  |
| expires_at | integer ts_ms | NOT NULL                         | token exp     | The denylist row can be cleaned up once the token expires                   |
| revoked_at | integer ts_ms | NOT NULL                         | now           | When the revoke was received                                                |
| created_at | integer ts_ms | NOT NULL                         | See 9.3       |                                                                             |

Indexes: `UNIQUE(tenant_id, jti)`, `INDEX(tenant_id, client_id)`, `INDEX(expires_at)`.

### 15.4b access_token_issuances (issued access JWT metadata, used for cascading revocation targeting)

Stores only the metadata of access JWTs that can be revoked in cascade by a replay; the token
plaintext never enters the database. `authorization_code` and `refresh_family_id` locate the affected
jti values when a family or a code is revoked, copying the unexpired jti values into the
access_token_revocations denylist (see 15.4a).

| Field              | Type          | Constraints                      | Default | Notes                                                              |
| ------------------ | ------------- | -------------------------------- | ------- | ------------------------------------------------------------------ |
| id                 | text          | PK                               | nanoid  |                                                                    |
| tenant_id          | text          | NOT NULL, FK -> organizations.id | --      | Mandatory tenant filter                                            |
| jti                | text          | NOT NULL                         | --      | The `jti` of the issued access JWT                                 |
| client_id          | text          | NOT NULL                         | --      | The token's owning client                                          |
| subject            | text          | NOT NULL                         | --      | The token `sub`                                                    |
| authorization_code | text          | nullable                         | null    | The originating code (for code replay cascading targeting)         |
| refresh_family_id  | text          | nullable                         | null    | The originating family (for family revocation cascading targeting) |
| expires_at         | integer ts_ms | NOT NULL                         | --      | The token exp; the row can be cleaned up after expiry              |
| created_at         | integer ts_ms | NOT NULL                         | See 9.3 |                                                                    |

Indexes: `UNIQUE(tenant_id, jti)`, `INDEX(tenant_id, authorization_code)`,
`INDEX(tenant_id, refresh_family_id)`, `INDEX(expires_at)`.

### 15.5 oauth_consents (persisted OIDC client scope authorization, = the UserConsent entity in this chapter's inventory, see chapter 03 sections 6 and 10.5)

| Field                   | Type          | Constraints                                | Default        | Notes                                                                                                |
| ----------------------- | ------------- | ------------------------------------------ | -------------- | ---------------------------------------------------------------------------------------------------- |
| id                      | text          | PK                                         | `cons_`+nanoid |                                                                                                      |
| tenant_id               | text          | NOT NULL, FK -> organizations.id           | --             |                                                                                                      |
| user_id                 | text          | NOT NULL, FK -> users.id ON DELETE cascade | --             |                                                                                                      |
| client_id               | text          | NOT NULL                                   | --             | Persisted by `(user_id,client_id,scope_set)` (see chapter 03 section 6)                              |
| granted_scopes          | text json     | NOT NULL                                   | `[]`           | The granted scope set (a union; a new scope requires interaction again, see chapter 03 section 10.5) |
| created_at / updated_at | integer ts_ms | NOT NULL                                   | See 9.3        |                                                                                                      |

Indexes: `UNIQUE(tenant_id, user_id, client_id)`, `INDEX(tenant_id, user_id)`. The Project Grant
scenario does not reuse these records (see the cross-org consent rules in chapter 02 section 7.4); a
different client_id means an independent record.

### 15.6 resource_servers (protected APIs, audience plus scopes, see chapter 03 section 6)

| Field                   | Type          | Constraints                      | Default      | Notes                                                                                          |
| ----------------------- | ------------- | -------------------------------- | ------------ | ---------------------------------------------------------------------------------------------- |
| id                      | text          | PK                               | `rs_`+nanoid |                                                                                                |
| tenant_id               | text          | NOT NULL, FK -> organizations.id | --           |                                                                                                |
| name                    | text          | NOT NULL                         | --           |                                                                                                |
| audience                | text          | NOT NULL                         | --           | The audience URL (the RFC 8707 resource indicator that a token request's `resource` points at) |
| scopes                  | text json     | NOT NULL                         | `[]`         | The custom scope set registered by this resource server                                        |
| access_token_format     | text          | NOT NULL                         | `'jwt'`      | `jwt`/`opaque` (opaque requires introspection, see chapter 03 section 3)                       |
| signing_alg             | text          | NOT NULL                         | `'ES256'`    |                                                                                                |
| created_at / updated_at | integer ts_ms | NOT NULL                         | See 9.3      |                                                                                                |

Indexes: `UNIQUE(tenant_id, audience)`, `INDEX(tenant_id)`.

## 16. Enterprise SSO and directory sync entities (see chapter 04)

### 16.1 sso_connections (per-org upstream IdP connection, 1:1 with an org, see chapter 04 section 1)

| Field                         | Type            | Constraints                                        | Default        | Notes                                                                                                                                |
| ----------------------------- | --------------- | -------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| id                            | text            | PK                                                 | `conn_`+nanoid |                                                                                                                                      |
| tenant_id                     | text            | NOT NULL, FK -> organizations.id                   | --             |                                                                                                                                      |
| org_id                        | text            | NOT NULL, FK -> organizations.id ON DELETE cascade | --             | A connection is 1:1 with an org and is never reused across tenants (see chapter 04 section 1)                                        |
| protocol                      | text            | NOT NULL                                           | --             | `saml`/`oidc`                                                                                                                        |
| idp_entity_id                 | text            | nullable                                           | null           | The SAML IdP EntityID (matched exactly against the Issuer, see chapter 04 section 9.7 step 1)                                        |
| idp_sso_url                   | text            | nullable                                           | null           | The SAML SSO URL or the OIDC authorization_endpoint                                                                                  |
| idp_slo_url                   | text            | nullable                                           | null           | The SAML IdP SingleLogoutService URL; public HTTPS and never inferred from the SSO URL                                               |
| idp_metadata_url              | text            | nullable                                           | null           | Polled and refreshed every 24 hours (see chapter 04 section 1)                                                                       |
| idp_certificates              | text json       | NOT NULL                                           | `[]`           | IdP X.509 verification certificates (an array of base64 DER; old and new coexist during rotation, see chapter 04 section 9.5 step 1) |
| oidc_client_id                | text            | nullable                                           | null           | The OIDC RP client_id                                                                                                                |
| oidc_client_secret_ciphertext | blob buffer     | nullable                                           | null           | AES-256-GCM encrypted (`version\|\|iv\|\|ciphertext\|\|tag`)                                                                         |
| oidc_discovery_url            | text            | nullable                                           | null           | OIDC Discovery                                                                                                                       |
| sp_cert_id                    | text            | FK -> cert_store.id ON DELETE set null, nullable   | null           | The SP signing/decryption certificate (see 16.2 and chapter 04 section 1)                                                            |
| want_authn_response_signed    | integer boolean | NOT NULL                                           | `1`            | Require the Response to be signed (see chapter 04 section 9.3)                                                                       |
| want_assertions_signed        | integer boolean | NOT NULL                                           | `1`            | Require the Assertion to be signed                                                                                                   |
| saml_clock_skew_ms            | integer         | NOT NULL, `0..300000`                              | `180000`       | Connection tolerance for IdP certificate and Assertion validity checks                                                               |
| attribute_mapping             | text json       | NOT NULL                                           | `{}`           | IdP attributes to XID fields (email/firstName/lastName/groups, see chapter 04 section 1)                                             |
| role_mapping                  | text json       | NOT NULL                                           | `{}`           | IdP groups to org_role (see chapter 04 section 4)                                                                                    |
| jit_enabled                   | integer boolean | NOT NULL                                           | `1`            | The JIT provisioning switch (some enterprises want SCIM only, see chapter 04 section 4)                                              |
| relay_state_url               | text            | nullable                                           | null           | The IdP-initiated landing page (see chapter 04 section 1)                                                                            |
| status                        | text            | NOT NULL                                           | `'active'`     | `active`/`inactive`                                                                                                                  |
| created_at / updated_at       | integer ts_ms   | NOT NULL                                           | See 9.3        |                                                                                                                                      |

Indexes: `UNIQUE(org_id)`, `INDEX(tenant_id)`, `INDEX(tenant_id, status)`. SsoProfile (the idp_id and
claims from a single authentication) is not persisted (it is transient); when an audit trail is
needed, use audit_events. The DirectoryUser bidirectional binding is described in 16.6.

### 16.2 cert_store (SAML certificates and private keys, encrypted, see chapter 04 section 2 and the signing-keys rule)

Both the SP side (facing an upstream IdP) and the XID-as-IdP side (facing downstream SPs) store their
signing and decryption certificates here, **separate from the OIDC signing keys** (see SAML
certificates in the signing-keys rule).

| Field                   | Type           | Constraints                      | Default        | Notes                                                                                                                               |
| ----------------------- | -------------- | -------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| id                      | text           | PK                               | `cert_`+nanoid |                                                                                                                                     |
| tenant_id               | text           | NOT NULL, FK -> organizations.id | --             |                                                                                                                                     |
| usage                   | text           | NOT NULL                         | --             | `saml_sp_signing`/`saml_sp_encryption`/`saml_idp_signing` (XID as the IdP)                                                          |
| certificate             | text           | NOT NULL                         | --             | The X.509 public certificate (base64 DER)                                                                                           |
| private_key_iv          | blob buffer    | NOT NULL                         | --             | The AES-256-GCM IV (12 bytes)                                                                                                       |
| private_key_ciphertext  | blob buffer    | NOT NULL                         | --             | The envelope-encrypted private key ciphertext (decrypted with the KEK on load; the plaintext private key never enters the database) |
| private_key_tag         | blob buffer    | NOT NULL                         | --             | The GCM tag (16 bytes)                                                                                                              |
| kek_version             | integer number | NOT NULL                         | --             | The KEK version (for rotation compatibility)                                                                                        |
| status                  | text           | NOT NULL                         | `'active'`     | `active`/`retiring` (old and new coexist during rotation, see chapter 04 section 1)                                                 |
| not_before              | integer ts_ms  | nullable                         | null           | The certificate validity lower bound                                                                                                |
| not_after               | integer ts_ms  | nullable                         | null           | The upper bound                                                                                                                     |
| fingerprint             | text           | NOT NULL                         | --             | The SHA-256 fingerprint (for incident response, see chapter 04 section 9.5 step 3)                                                  |
| created_at / updated_at | integer ts_ms  | NOT NULL                         | See 9.3        |                                                                                                                                     |

Indexes: `UNIQUE(tenant_id, usage) WHERE status='active' AND usage='saml_idp_signing'` (the
concurrent auto-provisioning winner; it intentionally excludes both SP usages),
`INDEX(tenant_id, usage, status)`.

> Decision: the SAML private key and the OIDC signing private key use the **same envelope encryption
> structure but live in separate tables**. CertStore splits iv, ciphertext, and tag into **three blob
> columns** (which makes field-by-field reads and KEK decryption easier) rather than one JSON blob.
> InstanceSigningKey (16.3) uses the same structure.

### 16.3 instance_signing_keys (the instance issuer ES256 signing key, see the signing-keys rule)

**Key decision (security-relevant): the private key ciphertext iv, ciphertext, and tag are stored in
three separate columns rather than as a JSON blob.** Rationale: three independent columns avoid JSON
parsing overhead and field ordering ambiguity, consistent with CertStore (see 16.2).

| Field                   | Type           | Constraints                  | Default      | Notes                                                                                                                                                                    |
| ----------------------- | -------------- | ---------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| id                      | text           | PK                           | `sk_`+nanoid |                                                                                                                                                                          |
| instance_id             | text           | NOT NULL, FK -> instances.id | --           | The instance issuer's default signing key                                                                                                                                |
| kid                     | text           | NOT NULL                     | --           | The JWK key id used in the JWKS output; see `UNIQUE(instance_id,kid)`                                                                                                    |
| alg                     | text           | NOT NULL                     | `'ES256'`    | `ES256` (default) / `RS256` / `PS256`                                                                                                                                    |
| public_key_jwk          | text json      | NOT NULL                     | --           | The public JWK (served directly by the JWKS endpoint, see /jwks in chapter 03 section 1)                                                                                 |
| private_key_iv          | blob buffer    | NOT NULL                     | --           | The AES-256-GCM IV (12 bytes)                                                                                                                                            |
| private_key_ciphertext  | blob buffer    | NOT NULL                     | --           | The private key ciphertext wrapped by the KEK (AES-256-GCM); the plaintext private key exists only briefly inside the isolate (see the signing-keys rule)                |
| private_key_tag         | blob buffer    | NOT NULL                     | --           | The GCM tag (16 bytes)                                                                                                                                                   |
| kek_version             | integer number | NOT NULL                     | --           | The KEK version (the KEK lives in Workers Secrets; this enables rotation compatibility)                                                                                  |
| status                  | text           | NOT NULL                     | `'active'`   | `active` (currently signing) / `next` (published but not signing) / `retiring` (an old public key awaiting deletion), the four-step rotation (see the signing-keys rule) |
| activated_at            | integer ts_ms  | nullable                     | null         | When it became active                                                                                                                                                    |
| retire_after            | integer ts_ms  | nullable                     | null         | Delete the public key once old tokens have expired                                                                                                                       |
| created_at / updated_at | integer ts_ms  | NOT NULL                     | See 9.3      |                                                                                                                                                                          |

Indexes: `UNIQUE(instance_id, kid)`, `INDEX(instance_id, status)`. JWKS publishes every unexpired
public key with `status IN (active,next,retiring)` (multiple kids coexist so rotation never interrupts
verification, see the signing-keys rule).

### 16.5 directories (SCIM directory connections, see chapter 04 sections 6 and 10.2)

| Field                   | Type          | Constraints                                        | Default       | Notes                                                                                                                                                |
| ----------------------- | ------------- | -------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                      | text          | PK                                                 | `dir_`+nanoid |                                                                                                                                                      |
| tenant_id               | text          | NOT NULL, FK -> organizations.id                   | --            | The internal organization isolation field; the public SCIM endpoint prefix is `/scim/v2/organizations/{organization_id}/` (see chapter 04 section 6) |
| org_id                  | text          | NOT NULL, FK -> organizations.id ON DELETE cascade | --            |                                                                                                                                                      |
| provider                | text          | NOT NULL                                           | --            | `okta`/`entra`/`google`/`onelogin`/`jumpcloud`/`generic` (see chapter 04 section 7)                                                                  |
| scim_token_hash         | text          | NOT NULL                                           | --            | The current bearer token SHA-256 (the plaintext is shown once, see chapter 04 section 10.2); the plaintext never enters the database                 |
| scim_token_hash_prev    | text          | nullable                                           | null          | The old hash during the rotation grace period (see chapter 04 section 10.2)                                                                          |
| scim_token_prev_expires | integer ts_ms | nullable                                           | null          | When the old token's grace period ends (30 minutes, cleaned up by Cron every 15 minutes)                                                             |
| sync_status             | text          | NOT NULL                                           | `'idle'`      | `idle`/`syncing`/`error`                                                                                                                             |
| status                  | text          | NOT NULL                                           | `'active'`    | `active`/`deleted`                                                                                                                                   |
| last_sync_at            | integer ts_ms | nullable                                           | null          |                                                                                                                                                      |
| deleted_at              | integer ts_ms | nullable                                           | null          | Soft delete marker                                                                                                                                   |
| created_at / updated_at | integer ts_ms | NOT NULL                                           | See 9.3       |                                                                                                                                                      |

Indexes: `INDEX(tenant_id, org_id)`. SCIM queries MUST inject
`WHERE tenant_id=? AND directory_id=?` (see chapter 04 section 10).

### 16.6 directory_users (SCIM-synced users, bidirectionally bound, see chapter 04 section 6)

| Field                   | Type            | Constraints                                      | Default        | Notes                                                                                   |
| ----------------------- | --------------- | ------------------------------------------------ | -------------- | --------------------------------------------------------------------------------------- |
| id                      | text            | PK                                               | `dusr_`+nanoid | The SCIM User.id                                                                        |
| tenant_id               | text            | NOT NULL, FK -> organizations.id                 | --             |                                                                                         |
| directory_id            | text            | NOT NULL, FK -> directories.id ON DELETE cascade | --             |                                                                                         |
| user_id                 | text            | FK -> users.id ON DELETE set null, nullable      | null           | The bidirectional binding (the directory_user_id foreign key, see chapter 04 section 6) |
| external_id             | text            | nullable                                         | null           | The SCIM externalId                                                                     |
| user_name               | text            | NOT NULL                                         | --             | The SCIM userName (the primary sign-in identifier)                                      |
| scim_raw                | text json       | NOT NULL                                         | `{}`           | The raw SCIM resource (meta.version, ETag, and so on)                                   |
| active                  | integer boolean | NOT NULL                                         | `1`            | active=false means deprovisioned (a soft delete, see chapter 04 section 10.1.2)         |
| status                  | text            | NOT NULL                                         | `'active'`     | `active`/`deactivated`/`deleted`                                                        |
| deleted_at              | integer ts_ms   | nullable                                         | null           | The SCIM DELETE soft delete marker                                                      |
| created_at / updated_at | integer ts_ms   | NOT NULL                                         | See 9.3        |                                                                                         |

Indexes: `UNIQUE(directory_id, user_name)`, `UNIQUE(directory_id, external_id)`,
`INDEX(tenant_id, directory_id)`, `INDEX(user_id)`.

### 16.7 directory_groups (SCIM-synced groups plus the group-to-role mapping, see chapter 04 section 6)

| Field                   | Type          | Constraints                                      | Default        | Notes                                                                                                  |
| ----------------------- | ------------- | ------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------ |
| id                      | text          | PK                                               | `dgrp_`+nanoid | The SCIM Group.id                                                                                      |
| tenant_id               | text          | NOT NULL, FK -> organizations.id                 | --             |                                                                                                        |
| directory_id            | text          | NOT NULL, FK -> directories.id ON DELETE cascade | --             |                                                                                                        |
| display_name            | text          | NOT NULL                                         | --             | The group-to-role mapping key (a change updates the mapping in step, see chapter 04 sections 6 and 10) |
| mapped_role             | text          | nullable                                         | null           | The mapped org role                                                                                    |
| status                  | text          | NOT NULL                                         | `'active'`     | `active`/`deleted`                                                                                     |
| deleted_at              | integer ts_ms | nullable                                         | null           | The SCIM DELETE soft delete marker                                                                     |
| created_at / updated_at | integer ts_ms | NOT NULL                                         | See 9.3        |                                                                                                        |

Indexes: `UNIQUE(directory_id, display_name)`, `INDEX(tenant_id, directory_id)`.

### 16.8 directory_group_members + directory_pending_members (see chapter 04 section 10.1.1)

directory_group_members (resolved members):

| Field             | Type          | Constraints                                           | Default | Notes |
| ----------------- | ------------- | ----------------------------------------------------- | ------- | ----- |
| id                | text          | PK                                                    | nanoid  |       |
| tenant_id         | text          | NOT NULL, FK -> organizations.id                      | --      |       |
| group_id          | text          | NOT NULL, FK -> directory_groups.id ON DELETE cascade | --      |       |
| directory_user_id | text          | NOT NULL, FK -> directory_users.id ON DELETE cascade  | --      |       |
| created_at        | integer ts_ms | NOT NULL                                              | See 9.3 |       |

Indexes: `UNIQUE(group_id, directory_user_id)`.

directory_pending_members (an idempotent placeholder for unknown members, the OneLogin quirk, see
chapter 04 section 10.1.1):

| Field      | Type          | Constraints                                           | Default | Notes                                       |
| ---------- | ------------- | ----------------------------------------------------- | ------- | ------------------------------------------- |
| id         | text          | PK                                                    | nanoid  |                                             |
| tenant_id  | text          | NOT NULL, FK -> organizations.id                      | --      |                                             |
| group_id   | text          | NOT NULL, FK -> directory_groups.id ON DELETE cascade | --      |                                             |
| ref        | text          | NOT NULL                                              | --      | The user_id or externalId awaiting backfill |
| created_at | integer ts_ms | NOT NULL                                              | See 9.3 |                                             |

Indexes: `UNIQUE(group_id, ref)` (idempotent: repeatedly adding the same ref does not create duplicate
pending rows, see chapter 04 section 10.1.1).

### 16.9 saml_service_providers (downstream SP registration when XID acts as the IdP, see chapter 04 section 2)

The outbound SAML IdP has shipped (worker/sso/outbound-saml.ts plus this table plus the console page):
package-level XML signature tests, Worker route L2, and a fake SaaS SP at L3 are covered. Real SaaS
admin L4, SaaS template UI, and the app assignment gate are not done (see the current decisions in
chapter 04 section 2).

| Field                   | Type          | Constraints                                        | Default                                                    | Notes                                                                                              |
| ----------------------- | ------------- | -------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| id                      | text          | PK                                                 | `sp_`+nanoid                                               |                                                                                                    |
| tenant_id               | text          | NOT NULL, FK -> organizations.id                   | --                                                         |                                                                                                    |
| org_id                  | text          | NOT NULL, FK -> organizations.id ON DELETE cascade | --                                                         | The org the SP belongs to                                                                          |
| sp_entity_id            | text          | NOT NULL                                           | --                                                         | The per-SP EntityID (see chapter 04 section 2)                                                     |
| acs_url                 | text          | NOT NULL                                           | --                                                         | The SP ACS URL                                                                                     |
| slo_url                 | text          | nullable                                           | null                                                       | The SP SLO receiving endpoint                                                                      |
| slo_binding             | text          | NOT NULL                                           | `'redirect'`                                               | The SLO binding (`redirect`/`post`)                                                                |
| sp_certificates         | text json     | NOT NULL                                           | `[]`                                                       | SP X.509 certificates (an array of base64 DER, used for SLO signature verification and encryption) |
| attribute_mapping       | text json     | NOT NULL                                           | `{}`                                                       | Assertion field mapping                                                                            |
| name_id_format          | text          | NOT NULL                                           | `'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress'` |                                                                                                    |
| idp_signing_cert_id     | text          | FK -> cert_store.id ON DELETE set null, nullable   | null                                                       | The XID IdP signing certificate (`usage=saml_idp_signing`)                                         |
| created_at / updated_at | integer ts_ms | NOT NULL                                           | See 9.3                                                    |                                                                                                    |

Indexes: `UNIQUE(tenant_id, org_id, sp_entity_id)`, `INDEX(tenant_id, org_id)`.

### 16.10 saml_session_bindings (SAML SLO SessionIndex/NameID to session mapping, see chapter 04 section 2)

Its lifetime tracks the session and does not use the ChallengeStore 10-minute TTL.

| Field                   | Type          | Constraints                                   | Default | Notes                                                   |
| ----------------------- | ------------- | --------------------------------------------- | ------- | ------------------------------------------------------- |
| id                      | text          | PK                                            | nanoid  |                                                         |
| tenant_id               | text          | NOT NULL, FK -> organizations.id              | --      |                                                         |
| direction               | text          | NOT NULL                                      | --      | `inbound` (upstream IdP SLO) / `outbound` (XID IdP SLO) |
| scope_id                | text          | NOT NULL                                      | --      | inbound is the connection id, outbound is the SP id     |
| session_index           | text          | NOT NULL                                      | --      | The SAML SessionIndex                                   |
| user_id                 | text          | NOT NULL, FK -> users.id ON DELETE cascade    | --      |                                                         |
| session_id              | text          | NOT NULL, FK -> sessions.id ON DELETE cascade | --      | The XID session                                         |
| name_id                 | text          | nullable                                      | null    | The SAML NameID                                         |
| name_id_format          | text          | nullable                                      | null    |                                                         |
| expires_at              | integer ts_ms | NOT NULL                                      | --      | Aligned with the session lifetime                       |
| consumed_at             | integer ts_ms | nullable                                      | null    | Single-use SLO consumption                              |
| created_at / updated_at | integer ts_ms | NOT NULL                                      | See 9.3 |                                                         |

Indexes: `UNIQUE(tenant_id, direction, scope_id, session_index)`,
`INDEX(tenant_id, user_id, session_id, direction)`,
`INDEX(tenant_id, direction, scope_id, name_id)`.

### 16.11 scim_targets (outbound SCIM targets, XID as a SCIM client pushing users and groups to downstream SaaS, see chapter 04 section 3)

| Field                   | Type          | Constraints                                        | Default      | Notes                                                                                                                                                 |
| ----------------------- | ------------- | -------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                      | text          | PK                                                 | `st_`+nanoid |                                                                                                                                                       |
| tenant_id               | text          | NOT NULL, FK -> organizations.id                   | --           |                                                                                                                                                       |
| org_id                  | text          | NOT NULL, FK -> organizations.id ON DELETE cascade | --           |                                                                                                                                                       |
| provider                | text          | NOT NULL                                           | --           | The downstream SaaS identifier (see chapter 04 section 3)                                                                                             |
| base_url                | text          | NOT NULL                                           | --           | The downstream SCIM endpoint base URL                                                                                                                 |
| token_secret_ref        | text          | NOT NULL                                           | --           | Server-derived `SCIM_TARGET_TOKEN_<normalized id>` reference. The API rejects caller-selected values; the bearer token exists only in Workers Secrets |
| user_filter             | text json     | NOT NULL                                           | `{}`         | The push scope filter (which users and groups go outbound)                                                                                            |
| status                  | text          | NOT NULL                                           | `'active'`   | `active` (outbound sync reads only active rows)                                                                                                       |
| last_sync_at            | integer ts_ms | nullable                                           | null         |                                                                                                                                                       |
| created_at / updated_at | integer ts_ms | NOT NULL                                           | See 9.3      |                                                                                                                                                       |

Indexes: `INDEX(tenant_id, org_id)`, `INDEX(tenant_id, status)`.

### 16.12 scim_target_resources (stable outbound SCIM identity mapping, see chapter 04 section 3)

| Field                   | Type          | Constraints                                        | Default    | Notes                                                                                         |
| ----------------------- | ------------- | -------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| id                      | text          | PK                                                 | UUID       |                                                                                               |
| tenant_id               | text          | NOT NULL, FK -> organizations.id                   | --         |                                                                                               |
| org_id                  | text          | NOT NULL, FK -> organizations.id ON DELETE cascade | --         | The Organization whose Membership intersection owns the outbound resource                     |
| target_id               | text          | NOT NULL, FK -> scim_targets.id ON DELETE cascade  | --         | The downstream SaaS target                                                                    |
| resource_type           | text          | NOT NULL                                           | --         | `User` or `Group`                                                                             |
| local_resource_id       | text          | NOT NULL                                           | --         | XID User id for `User`; deterministic `role:<role>` for a role-derived `Group`                |
| external_id             | text          | NOT NULL                                           | --         | Stable SCIM `externalId`, used to recover a missing/stale mapping without creating duplicates |
| downstream_id           | text          | NOT NULL                                           | --         | The downstream SCIM resource `id`; never used across targets                                  |
| status                  | text          | NOT NULL                                           | `'active'` | `active` or `deprovisioned`; mappings are retained so later reactivation uses the same id     |
| last_synced_at          | integer ts_ms | NOT NULL                                           | --         | Last completed upsert or deprovision operation for this resource                              |
| created_at / updated_at | integer ts_ms | NOT NULL                                           | See 9.3    |                                                                                               |

Indexes:
`UNIQUE(tenant_id, target_id, resource_type, local_resource_id)`,
`UNIQUE(tenant_id, target_id, resource_type, downstream_id)`,
`INDEX(tenant_id, org_id, target_id, status, id)`.
The leading `tenant_id` on both unique keys is mandatory because D1 has no RLS. Deprovision reads
only mappings for the current `(tenant_id, org_id, target_id)` and runs only after the current run's
complete upsert phase succeeds.

## 17. Session and platform operations entities

### 17.1 sessions (user sessions, see chapter 05 section 8)

**Key decisions: the device_fingerprint is stored as a hash rather than plaintext; the refresh token is
stored as a hash; status drives revocation.**

| Field                   | Type            | Constraints                                         | Default        | Notes                                                                                                                                        |
| ----------------------- | --------------- | --------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| id                      | text            | PK                                                  | `sess_`+nanoid | The JWT sid; the first 8 random suffix characters form the cookie namespace (see chapter 05 section 8.4)                                     |
| tenant_id               | text            | NOT NULL, FK -> organizations.id                    | --             | Tenant-scoped isolation (see chapter 03 section 7)                                                                                           |
| user_id                 | text            | NOT NULL, FK -> users.id ON DELETE cascade          | --             |                                                                                                                                              |
| refresh_token_hash      | text            | NOT NULL                                            | --             | The SHA-256 of the current active opaque refresh token (see chapter 05 section 8.2); the plaintext appears only in Set-Cookie                |
| active_org_id           | text            | FK -> organizations.id ON DELETE set null, nullable | null           | The active org context (switching does not require re-authentication, see chapter 02 section 4 and chapter 05 section 8.4)                   |
| device_fingerprint_hash | text            | nullable                                            | null           | SHA-256(UA+IP) (see chapter 05 section 8; the raw fingerprint is not stored)                                                                 |
| device_name             | text            | nullable                                            | null           | User-nameable                                                                                                                                |
| user_agent              | text            | nullable                                            | null           | For display (the active session list)                                                                                                        |
| ip                      | text            | nullable                                            | null           | The last IP                                                                                                                                  |
| location                | text            | nullable                                            | null           | GeoIP location (for display)                                                                                                                 |
| status                  | text            | NOT NULL                                            | `'active'`     | `active`/`revoked`/`expired` (revocation updates the Durable Object memory first and persists here asynchronously, see chapter 05 section 8) |
| remember_me             | integer boolean | NOT NULL                                            | `0`            | On means a 30-day refresh; off means browser lifetime (see chapter 05 section 8.2)                                                           |
| is_impersonation        | integer boolean | NOT NULL                                            | `0`            | An impersonation session (see chapter 05 section 6)                                                                                          |
| impersonator_user_id    | text            | FK -> users.id ON DELETE set null, nullable         | null           | The source of the act claim (see act in chapter 05 section 8.1)                                                                              |
| acr                     | text            | nullable                                            | null           | Authentication context class, the source for the authorization code and token claims                                                         |
| amr                     | text json       | nullable                                            | null           | Authentication methods array, the source for the authorization code and token claims                                                         |
| aal                     | integer number  | nullable                                            | null           | The current NIST AAL mapping, 1 or 2. New writes never use 3; a legacy 3 is normalized to AAL2 before new authorization or token issuance    |
| authenticated_at        | integer ts_ms   | NOT NULL                                            | --             | The time of full authentication (the source of auth_time; a token refresh does not update it, see chapter 05 section 8.1)                    |
| last_active_at          | integer ts_ms   | NOT NULL                                            | now            | The idle timeout baseline (updated asynchronously on each refresh, see chapter 05 section 8.3)                                               |
| expires_at              | integer ts_ms   | NOT NULL                                            | --             | Absolute timeout (+7d by default; +24h as the fallback when remember me is off, see chapter 05 section 8.4)                                  |
| created_at              | integer ts_ms   | NOT NULL                                            | See 9.3        |                                                                                                                                              |

Indexes: `INDEX(tenant_id, user_id, status)`, `INDEX(refresh_token_hash)`, `INDEX(active_org_id)`,
`INDEX(expires_at)`. The per-user session revocation set lives in a Durable Object (see chapter 05
section 8 and the cloudflare-bindings rule); the Durable Object is the source of truth for revocation
and the sessions table is the durable fact.

### 17.2 audit_events (append-only audit, see chapter 07 section 5.1)

The fields match the D1 schema in chapter 07 section 5.1.1 (restated here as a field-level contract;
**`occurred_at` is the exception and uses ISO 8601 TEXT** because it feeds the hash input, see chapter
07 section 5.1.2):

| Field             | Type           | Constraints | Default                                | Notes                                                                                                                               |
| ----------------- | -------------- | ----------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| seq               | integer number | NOT NULL    | Issued by AuditSeqDO                   | Monotonic within a tenant (AuditSeqDO is sharded by `audit-seq:{tenantId}`, see chapter 07 section 5.1.3)                           |
| id                | text           | NOT NULL    | SHA-256(tenant_id + source_message_id) | Deterministic idempotency and hash-chain input; not a resource locator                                                              |
| source_message_id | text           | nullable    | null                                   | The producer-side idempotency key (for deduplication; a partial `UNIQUE(tenant_id,source_message_id)`)                              |
| tenant_id         | text           | NOT NULL    | --                                     | The first column of the composite primary key                                                                                       |
| org_id            | text           | nullable    | null                                   | Null for platform-level events (partitioned by org, see chapter 02 section 6)                                                       |
| event_type        | text           | NOT NULL    | --                                     | `<domain>.<action>` (the enumeration is in chapter 07 section 5.1.5)                                                                |
| actor_id          | text           | nullable    | null                                   | Immutable user_id or `system`; after GDPR erasure a missing identity mapping renders as `[deleted_user]` (see chapter 07 section 8) |
| actor_ip          | text           | nullable    | null                                   |                                                                                                                                     |
| target_type       | text           | nullable    | null                                   |                                                                                                                                     |
| target_id         | text           | nullable    | null                                   |                                                                                                                                     |
| meta              | text json      | NOT NULL    | `{}`                                   | Extra business fields (the hash uses the canonical form, see chapter 07 section 5.1.2)                                              |
| occurred_at       | text           | NOT NULL    | ISO 8601 ms                            | The exception: TEXT (it feeds the hash input, with millisecond precision in UTC)                                                    |
| prev_hash         | text           | NOT NULL    | 64 zeros for the first record          | The previous record's hash                                                                                                          |
| hash              | text           | NOT NULL    | --                                     | This record's SHA-256 (see chapter 07 section 5.1.2)                                                                                |

Primary key: `PRIMARY KEY (tenant_id, seq)`. Indexes: `INDEX(tenant_id, occurred_at)`,
`INDEX(tenant_id, actor_id)`, `INDEX(tenant_id, event_type)`. **INSERT only, with no UPDATE or
DELETE** (protected by a read-only account at the DDL layer, see chapter 07 section 5.1.1). No foreign
keys (the chain cannot be cascade-deleted).

GDPR erasure does not update `actor_id`, `meta`, `hash`, or any other field in an existing row. The
identity lookup is deleted, the read model renders an unresolved actor as `[deleted_user]`, and a new
`user.erasure_completed` row is appended to record completion.

### 17.2b audit_dead_letters (audit poison message dead letters, see chapter 07 section 5)

Permanent errors (a deserialization failure) or messages that exhausted their retries land in this
table rather than retrying forever, so a single poison message cannot stall the whole chain. These do
not enter audit_events (they have no seq or hash and are not part of the chain) and exist only for
operational troubleshooting.

| Field             | Type           | Constraints | Default | Notes                                                                                    |
| ----------------- | -------------- | ----------- | ------- | ---------------------------------------------------------------------------------------- |
| id                | text           | PK          | --      |                                                                                          |
| message_id        | text           | NOT NULL    | --      | The Queue message id, `UNIQUE`                                                           |
| source_message_id | text           | nullable    | null    | The producer-side idempotency key (matching audit_events.source_message_id)              |
| tenant_id         | text           | nullable    | null    | Null when the message body is corrupt and unparseable; not part of tenant isolation      |
| reason            | text           | NOT NULL    | --      | `permanent` (deserialization or validation failure) / `max_attempts` (retries exhausted) |
| attempts          | integer number | NOT NULL    | `1`     |                                                                                          |
| body              | text json      | nullable    | null    | The original message body (for troubleshooting)                                          |
| failed_at         | text           | NOT NULL    | --      | ISO 8601 UTC                                                                             |
| created_at        | integer ts_ms  | NOT NULL    | See 9.3 |                                                                                          |

Indexes: `UNIQUE(message_id)`, `UNIQUE(tenant_id, source_message_id)` (a partial index where
source_message_id is non-null), `INDEX(tenant_id)`, `INDEX(failed_at)`.

### 17.3 usage_daily / usage_monthly (metering, see chapter 07 section 7)

usage_daily (written per day by the metering consumer after deduplication, see chapter 07 section 7):

| Field                   | Type           | Constraints | Default | Notes                                           |
| ----------------------- | -------------- | ----------- | ------- | ----------------------------------------------- |
| tenant_id               | text           | NOT NULL    | --      | Part of the composite primary key               |
| day                     | text           | NOT NULL    | --      | `YYYY-MM-DD`, part of the composite primary key |
| dau                     | integer number | NOT NULL    | `0`     | That day's deduplicated active users            |
| api_calls               | integer number | NOT NULL    | `0`     |                                                 |
| email_count             | integer number | NOT NULL    | `0`     |                                                 |
| created_at / updated_at | integer ts_ms  | NOT NULL    | See 9.3 |                                                 |

Primary key: `PRIMARY KEY (tenant_id, day)`.

usage_monthly (a month-end Cron job reads the count from MeteringDO and archives it, see chapter 07
section 7.1.2):

| Field       | Type           | Constraints | Default | Notes                                                                                                                                                                   |
| ----------- | -------------- | ----------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tenant_id   | text           | NOT NULL    | --      | Part of the composite primary key                                                                                                                                       |
| year_month  | text           | NOT NULL    | --      | `YYYY-MM`, part of the composite primary key                                                                                                                            |
| mau         | integer number | NOT NULL    | --      | Exact deduplication by MeteringDO (sharded per tenant with `idFromName('metering:{tenantId}')`, where DO storage keeps an independent `member:month:{ym}:{userId}` key) |
| archived_at | text           | NOT NULL    | --      | ISO 8601 (matching the SQL in chapter 07)                                                                                                                               |

Primary key: `PRIMARY KEY (tenant_id, year_month)`.

MeteringDO MAU deduplication excludes guest users (`users.provisioned_by = 'anonymous'`, see chapter
01 section 8): guests are real user rows, but counting them as MAU would let free trials inflate the
customer's MAU bill.

### 17.3b metering_outbox (a durable recovery queue for authentication-success metering)

Persists metering events awaiting redelivery when the Queue is briefly unavailable. Only one pending
recovery event is kept per tenant, user, and day, so the Queue's at-least-once delivery cannot inflate
the DAU figure.

| Field                   | Type           | Constraints                                | Default | Notes                                              |
| ----------------------- | -------------- | ------------------------------------------ | ------- | -------------------------------------------------- |
| id                      | text           | PK                                         | nanoid  |                                                    |
| tenant_id               | text           | NOT NULL, FK -> organizations.id           | --      |                                                    |
| user_id                 | text           | NOT NULL, FK -> users.id ON DELETE cascade | --      |                                                    |
| day                     | text           | NOT NULL                                   | --      | `YYYY-MM-DD`                                       |
| occurred_at             | integer ts_ms  | NOT NULL                                   | --      | The authentication success time                    |
| attempt_count           | integer number | NOT NULL                                   | `0`     | The recovery retry count                           |
| last_error_code         | text           | nullable                                   | null    | The most recent delivery failure code              |
| delivered_at            | integer ts_ms  | nullable                                   | null    | The successful delivery time (non-null means done) |
| created_at / updated_at | integer ts_ms  | NOT NULL                                   | See 9.3 |                                                    |

Indexes: `UNIQUE(tenant_id, user_id, day)`, `INDEX(delivered_at, created_at)` (for scanning pending
recoveries).

### 17.3c organization_plans / organization_quotas (optional service accounting)

These tables are operator accounting metadata, not a license system. Authentication and configured
protocols never read them as feature gates. A missing plan row resolves to the `free` label without
creating data. Applying a label can apply its default seat/API quotas; explicit quota values remain
operator-controlled.

organization_plans:

| Field                   | Type          | Constraints                    | Default  | Notes                                      |
| ----------------------- | ------------- | ------------------------------ | -------- | ------------------------------------------ |
| tenant_id               | text          | PK                             | --       | Top-level organization id                  |
| plan                    | text          | NOT NULL                       | `free`   | free / starter / pro / enterprise          |
| status                  | text          | NOT NULL                       | `active` | active / trialing / past_due / canceled    |
| source                  | text          | NOT NULL                       | `manual` | Accounting adapter source                  |
| external_customer_id    | text          | nullable, UNIQUE when non-null | null     | Optional deployer billing-customer id      |
| trial_ends_at           | integer ts_ms | nullable                       | null     |                                            |
| effective_at            | integer ts_ms | NOT NULL                       | --       | When the accounting label became effective |
| updated_by              | text          | nullable                       | null     | Instance Manager user id                   |
| created_at / updated_at | integer ts_ms | NOT NULL                       | See 9.3  |                                            |

Indexes: partial `UNIQUE(external_customer_id)` when non-null,
`INDEX(plan, status, tenant_id)`.

organization_quotas:

| Field                   | Type           | Constraints  | Default   | Notes                                                              |
| ----------------------- | -------------- | ------------ | --------- | ------------------------------------------------------------------ |
| tenant_id               | text           | composite PK | --        |                                                                    |
| quota_key               | text           | composite PK | --        | seats / organizations / sso_connections / api_calls / emails / mau |
| limit                   | integer number | nullable     | null      | null means unlimited                                               |
| enforcement             | text           | NOT NULL     | `observe` | observe / block_creation                                           |
| updated_by              | text           | nullable     | null      | Instance Manager user id                                           |
| created_at / updated_at | integer ts_ms  | NOT NULL     | See 9.3   |                                                                    |

Primary key: `PRIMARY KEY(tenant_id, quota_key)`. Index:
`INDEX(quota_key, tenant_id)`. The `seats` row is the authoritative hard seat-creation quota;
`organizations.seat_limit` on the root organization is updated in the same plan mutation as a
compatibility mirror. Seats are distinct active `memberships.user_id` values across the complete
tenant, including child organizations. Migration-owned BEFORE triggers atomically enforce new
distinct active seats, child-organization creation/restoration, and SSO-connection
creation/restoration. The membership UPDATE trigger excludes `OLD.id` and evaluates the destination
tenant, preserving moves while preventing cross-tenant bypasses. Only `seats`, `organizations`, and
`sso_connections` may use `block_creation`; `api_calls`, `emails`, and `mau` are observational
because they must not interrupt authentication, token issuance, refresh, transactional
authentication delivery, or an already configured protocol.

Top-level tenant creation inserts its Free `seats` quota and root compatibility mirror in the same
D1 batch. A child organization never owns a seat quota: Management API create and patch requests
that try to set its `seat_limit` are rejected. Migration 0005 backfills one hard `seats` row from
each existing root mirror, preserving null as unlimited rather than silently imposing a new limit.

billing_meter_reports:

| Field                      | Type           | Constraints               | Default | Notes                                                     |
| -------------------------- | -------------- | ------------------------- | ------- | --------------------------------------------------------- |
| tenant_id                  | text           | composite PK              | --      | Top-level organization id                                 |
| meter_key                  | text           | composite PK              | --      | Provider meter identity                                   |
| period                     | text           | composite PK              | --      | Accounting period such as `YYYY-MM`                       |
| reported_value             | integer number | NOT NULL                  | `0`     | Provider-acknowledged cumulative target                   |
| pending_identifier         | text           | nullable, globally UNIQUE | null    | Stable provider idempotency identifier                    |
| pending_value              | integer number | nullable                  | null    | Delta reserved for the pending report                     |
| pending_target             | integer number | nullable                  | null    | Cumulative target committed after provider acknowledgment |
| pending_customer_id        | text           | nullable                  | null    | Customer frozen when the pending report is reserved       |
| pending_event_name         | text           | nullable                  | null    | Meter event name frozen when the report is reserved       |
| pending_timestamp          | integer number | nullable                  | null    | Provider payload timestamp frozen with the report         |
| pending_reserved_at        | integer ts_ms  | nullable                  | null    | Start of the provider idempotency retry window            |
| provider_accepted_at       | integer ts_ms  | nullable                  | null    | Provider acceptance persisted before local finalization   |
| reconciliation_required_at | integer ts_ms  | nullable                  | null    | Operator reconciliation required; provider resend blocked |
| created_at / updated_at    | integer ts_ms  | NOT NULL                  | See 9.3 |                                                           |

Primary key: `PRIMARY KEY(tenant_id, meter_key, period)`. Indexes: partial
`UNIQUE(pending_identifier)` when non-null, `INDEX(period, meter_key, tenant_id)`. A reporter
persists every pending field before the provider call and reuses the complete first payload,
including the identifier, customer, event name, value, and timestamp, on every retry. It advances
`reported_value` and clears the pending fields only after provider acknowledgment. A successful
provider response first persists `provider_accepted_at`; a retry with that marker performs only the
local finalization and never calls the provider again. When acceptance could not be persisted,
provider retries are allowed only inside the 24-hour provider deduplication window. Crossing that
boundary sets `reconciliation_required_at` and fails closed instead of risking a duplicate charge.

stripe_checkout_reservations:

| Field                    | Type          | Constraints      | Default    | Notes                                                            |
| ------------------------ | ------------- | ---------------- | ---------- | ---------------------------------------------------------------- |
| tenant_id                | text          | PK               | --         | One active Checkout reservation per top-level organization       |
| request_id               | text          | NOT NULL         | --         | Caller attempt identifier retained for operational tracing       |
| plan                     | text          | NOT NULL         | --         | Frozen starter / pro / enterprise selection                      |
| customer_id              | text          | nullable         | null       | Frozen existing Stripe customer binding                          |
| provider_idempotency_key | text          | NOT NULL, UNIQUE | --         | Server-generated key persisted before the provider call          |
| session_id               | text          | nullable         | null       | Stripe Checkout Session id                                       |
| session_url              | text          | nullable         | null       | Validated Stripe-hosted redirect URL                             |
| expires_at               | integer ts_ms | nullable         | null       | Provider session expiry                                          |
| status                   | text          | NOT NULL         | `reserved` | reserved / ready / completed / expired / reconciliation_required |
| created_at / updated_at  | integer ts_ms | NOT NULL         | See 9.3    |                                                                  |

Indexes: `UNIQUE(provider_idempotency_key)`,
`INDEX(status, expires_at, tenant_id)`. Core persists the server-generated provider key before
creating a Checkout Session, so concurrent caller retries reuse the same provider operation. A live
`ready` session is returned rather than replaced. Once its local expiry passes, Core retrieves the
authoritative Stripe Session: `complete` fails closed, and only an explicit provider `expired`
status permits a replacement reservation. An unresolved `reserved` row that outlives Stripe's
idempotency retention becomes `reconciliation_required`, and an active customer subscription blocks
new Checkout creation.

stripe_webhook_events:

| Field                   | Type          | Constraints | Default | Notes                                          |
| ----------------------- | ------------- | ----------- | ------- | ---------------------------------------------- |
| event_id                | text          | PK          | --      | Stripe event id and durable idempotency key    |
| event_type              | text          | NOT NULL    | --      | Provider event type                            |
| tenant_id               | text          | nullable    | null    | Resolved top-level organization when available |
| event_created           | integer ts_ms | NOT NULL    | --      | Provider event creation time                   |
| status                  | text          | NOT NULL    | --      | pending / processed / failed / ignored         |
| error_code              | text          | nullable    | null    | Static operational code only                   |
| processed_at            | integer ts_ms | nullable    | null    | Successful processing time                     |
| created_at / updated_at | integer ts_ms | NOT NULL    | See 9.3 |                                                |

Indexes: `INDEX(status, created_at, event_id)`,
`INDEX(tenant_id, event_created, event_id)`. The handler claims `event_id` before applying a billing
transition, so provider retries cannot apply the same transition twice.

### 17.3d platform_announcements

| Field                    | Type          | Constraints         | Default       | Notes                                      |
| ------------------------ | ------------- | ------------------- | ------------- | ------------------------------------------ |
| id                       | text          | PK                  | `ann_` id     |                                            |
| scope_type / scope_value | text / text   | NOT NULL / nullable | global / null | Explicit global, tenant, or plan targeting |
| title / body             | text / text   | NOT NULL            | --            | Localizable operator-authored content      |
| severity                 | text          | NOT NULL            | `info`        | info / success / warning / critical        |
| status                   | text          | NOT NULL            | `draft`       | draft / published / archived               |
| starts_at / ends_at      | integer ts_ms | NOT NULL / nullable | -- / null     | Active window                              |
| created_by / updated_by  | text          | NOT NULL            | --            | Instance Manager user ids                  |
| created_at / updated_at  | integer ts_ms | NOT NULL            | See 9.3       |                                            |

Indexes: `INDEX(status, starts_at, ends_at)`,
`INDEX(scope_type, scope_value, status)`.

### 17.3e status_incidents / status_incident_updates

status_incidents stores the current incident summary; status_incident_updates is the append-only
public timeline.

| Table                   | Fields                                                                                                                                  | Indexes                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| status_incidents        | `id` (`inc_`, PK), `title`, `status`, `impact`, `summary`, `started_at`, nullable `resolved_at`, `created_by`, `updated_by`, timestamps | `INDEX(status, started_at, id)`, `INDEX(started_at, id)` |
| status_incident_updates | `id` (`incu_`, PK), `incident_id`, `status`, `message`, `created_by`, `created_at`                                                      | `INDEX(incident_id, created_at, id)`                     |

Incident status is investigating / identified / monitoring / resolved. Impact is none / minor /
major / critical. The public status endpoint and Nimbus `/status` read these records; an independent
external availability probe and historical uptime series remain separate external evidence.

### 17.3f privacy_requests

| Field                                              | Type          | Constraints | Default   | Notes                                        |
| -------------------------------------------------- | ------------- | ----------- | --------- | -------------------------------------------- |
| id                                                 | text          | PK          | `prv_` id |                                              |
| tenant_id / user_id                                | text / text   | NOT NULL    | --        | Request owner                                |
| request_type                                       | text          | NOT NULL    | --        | export / erasure                             |
| status                                             | text          | NOT NULL    | `pending` | Workflow state                               |
| storage_key / content_type                         | text / text   | nullable    | null      | R2 export artifact metadata                  |
| available_at / expires_at                          | integer ts_ms | nullable    | null      | Export download window                       |
| scheduled_for                                      | integer ts_ms | nullable    | null      | Erasure time after the 30-day grace period   |
| processing_started_at / completed_at / canceled_at | integer ts_ms | nullable    | null      | Lifecycle timestamps                         |
| error_code                                         | text          | nullable    | null      | Static retry-safe code, never exception text |
| created_at / updated_at                            | integer ts_ms | NOT NULL    | See 9.3   |                                              |

Indexes: `INDEX(tenant_id, user_id, created_at, id)`,
`INDEX(request_type, status, scheduled_for, id)`.

Deletion scheduling and execution both query `memberships`, `manager_assignments`, and active
`users`. A request cannot erase the sole active owner of any affected Organization or the last active
platform `instance_manager` in the same Instance scope. Replacement ManagerAssignment rows require
equal `scope_id` values, with null matching only null. The execution check is repeated as the first statement of the D1 batch;
the `privacy_requests.id` NOT NULL invariant acts as the atomic abort guard when roles changed
during the grace period, rolling back the user erasure and completion audit outbox together.

### 17.3g compliance_documents

| Field                     | Type                 | Constraints | Default     | Notes                             |
| ------------------------- | -------------------- | ----------- | ----------- | --------------------------------- |
| id                        | text                 | PK          | `cmp_` id   |                                   |
| tenant_id                 | text                 | nullable    | null        | null means instance-wide          |
| document_type / title     | text / text          | NOT NULL    | --          | Artifact classification and label |
| status                    | text                 | NOT NULL    | `available` | draft / available / retired       |
| storage_key / checksum    | text / text          | nullable    | null        | R2 key and integrity checksum     |
| version                   | text                 | NOT NULL    | --          | Tenant/type/version identity      |
| accepted_by / accepted_at | text / integer ts_ms | nullable    | null        | Optional acceptance record        |
| generated_by              | text                 | nullable    | null        | Generator or operator identity    |
| created_at / updated_at   | integer ts_ms        | NOT NULL    | See 9.3     |                                   |

Indexes: `UNIQUE(tenant_id, document_type, version)`,
`INDEX(document_type, status, tenant_id)`.

### 17.3h platform_audit_outbox

Every platform mutation persists a redacted audit intent before or atomically with its state change.
Queue dispatch uses `platform-audit:{id}` as a stable source id; hourly recovery retries pending rows,
and the audit consumer marks the row delivered only after AuditSeqDO appends or terminalizes it.

| Field                    | Type           | Constraints         | Default    | Notes                          |
| ------------------------ | -------------- | ------------------- | ---------- | ------------------------------ |
| id                       | text           | PK                  | `paud_` id | Stable audit delivery identity |
| tenant_id / org_id       | text / text    | NOT NULL / nullable | -- / null  | Audit scope                    |
| action / actor_id        | text / text    | NOT NULL / nullable | -- / null  | Event name and operator        |
| payload                  | text json      | NOT NULL            | `{}`       | Redacted before persistence    |
| status                   | text           | NOT NULL            | `pending`  | pending / queued / delivered   |
| available_at / queued_at | integer ts_ms  | NOT NULL / nullable | -- / null  | Retry and dispatch timestamps  |
| attempt_count            | integer number | NOT NULL            | `0`        | Queue handoff failures         |
| last_error_code          | text           | nullable            | null       | Static code only               |
| created_at / updated_at  | integer ts_ms  | NOT NULL            | See 9.3    |                                |

Indexes: `INDEX(status, available_at, id)`,
`INDEX(tenant_id, created_at, id)`.

### 17.4 webhooks + webhook_deliveries (see the api-sdk-conventions rule and chapter 07 section 5)

webhooks (subscriptions):

| Field                     | Type          | Constraints                      | Default      | Notes                                                                                                             |
| ------------------------- | ------------- | -------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------- |
| id                        | text          | PK                               | `wh_`+nanoid |                                                                                                                   |
| tenant_id                 | text          | NOT NULL, FK -> organizations.id | --           |                                                                                                                   |
| url                       | text          | NOT NULL                         | --           | The delivery target                                                                                               |
| event_types               | text json     | NOT NULL                         | `[]`         | Subscribed events `<object>.<action>` (see the api-sdk-conventions rule)                                          |
| signing_secret_hash       | text          | NOT NULL                         | --           | A legacy column (a SHA-256 hash, unusable for HMAC signing, retained for historical compatibility)                |
| signing_secret_iv         | text          | nullable                         | null         | The signing secret envelope encryption IV (base64url; a null on an old row means undeliverable and it is skipped) |
| signing_secret_ciphertext | text          | nullable                         | null         | The signing secret ciphertext (AES-256-GCM, with the KEK in Workers Secrets, decrypted at runtime for HMAC)       |
| signing_secret_tag        | text          | nullable                         | null         | The GCM tag                                                                                                       |
| status                    | text          | NOT NULL                         | `'active'`   | `active`/`disabled`                                                                                               |
| created_at / updated_at   | integer ts_ms | NOT NULL                         | See 9.3      |                                                                                                                   |

Indexes: `INDEX(tenant_id, status)`.

webhook_deliveries (delivery records, retries and dead letters):

| Field                   | Type           | Constraints                                   | Default     | Notes                                                                                     |
| ----------------------- | -------------- | --------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| id                      | text           | PK                                            | nanoid      | The svix-id (replay defense, see the api-sdk-conventions rule)                            |
| delivery_key            | text           | nullable                                      | null        | The producer-side idempotency key (a partial `UNIQUE`, effective when non-null)           |
| tenant_id               | text           | NOT NULL, FK -> organizations.id              | --          |                                                                                           |
| webhook_id              | text           | NOT NULL, FK -> webhooks.id ON DELETE cascade | --          |                                                                                           |
| event_type              | text           | NOT NULL                                      | --          |                                                                                           |
| payload                 | text json      | NOT NULL                                      | --          |                                                                                           |
| status                  | text           | NOT NULL                                      | `'pending'` | `pending`/`delivered`/`failed`/`dead_letter` (exponential backoff, dead letters go to D1) |
| attempt_count           | integer number | NOT NULL                                      | `0`         |                                                                                           |
| response_status         | integer number | nullable                                      | null        | The last response code                                                                    |
| next_retry_at           | integer ts_ms  | nullable                                      | null        |                                                                                           |
| delivered_at            | integer ts_ms  | nullable                                      | null        |                                                                                           |
| created_at / updated_at | integer ts_ms  | NOT NULL                                      | See 9.3     |                                                                                           |

Indexes: `INDEX(tenant_id, webhook_id, status)`, `INDEX(status, next_retry_at)`.

### 17.5 api_keys (scoped, hashed storage, see the api-sdk-conventions rule)

| Field                   | Type          | Constraints                      | Default      | Notes                                                                                                                                          |
| ----------------------- | ------------- | -------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| id                      | text          | PK                               | `ak_`+nanoid |                                                                                                                                                |
| tenant_id               | text          | NOT NULL, FK -> organizations.id | --           |                                                                                                                                                |
| name                    | text          | NOT NULL                         | --           |                                                                                                                                                |
| key_hash                | text          | NOT NULL, UNIQUE                 | --           | `SHA-256(sk_live_xxx)` (the plaintext carries the `sk_live_`/`sk_test_` prefix, see the api-sdk-conventions rule); the plaintext is shown once |
| key_prefix              | text          | NOT NULL                         | --           | A plaintext prefix fragment (such as `sk_live_a1b2`) for recognition, never the full value                                                     |
| environment             | text          | NOT NULL                         | `'live'`     | `live`/`test` (`sk_live_`/`sk_test_`)                                                                                                          |
| scopes                  | text json     | NOT NULL                         | `[]`         | The restricted capabilities                                                                                                                    |
| last_used_at            | integer ts_ms | nullable                         | null         |                                                                                                                                                |
| expires_at              | integer ts_ms | nullable                         | null         | null means it never expires                                                                                                                    |
| revoked_at              | integer ts_ms | nullable                         | null         |                                                                                                                                                |
| created_at / updated_at | integer ts_ms | NOT NULL                         | See 9.3      |                                                                                                                                                |

Indexes: `UNIQUE(key_hash)`, `INDEX(tenant_id)`.

### 17.6 platform_admins (platform-level, no tenant_id, reserved)

> Note: the current platform management path uses ManagerAssignment (instance_manager, see 13.5) plus
> the unified console. `platform_admins` is retained as the historical platform account table and as a
> reservation for a future break-glass path. It is not a current authentication entry point, is never
> written into business token claims, and does not constitute a separate admin RBAC system.

| Field                   | Type          | Constraints                                    | Default            | Notes                                                                                    |
| ----------------------- | ------------- | ---------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------- |
| id                      | text          | PK                                             | `padmin_`+nanoid   |                                                                                          |
| instance_id             | text          | NOT NULL, FK -> instances.id ON DELETE cascade | --                 | The platform instance                                                                    |
| email                   | text          | NOT NULL, UNIQUE                               | --                 | The platform operations sign-in identifier                                               |
| role                    | text          | NOT NULL                                       | `'platform_admin'` | A historically retained field; current platform management does not depend on this claim |
| status                  | text          | NOT NULL                                       | `'active'`         | `active`/`disabled`                                                                      |
| created_at / updated_at | integer ts_ms | NOT NULL                                       | See 9.3            |                                                                                          |

Indexes: `UNIQUE(email)`, `INDEX(instance_id)`.

### 17.8 notification_failures (the notification dead letter queue, see chapter 07 section 3)

| Field             | Type           | Constraints | Default | Notes                                                                                                     |
| ----------------- | -------------- | ----------- | ------- | --------------------------------------------------------------------------------------------------------- |
| id                | text           | PK          | --      |                                                                                                           |
| source_message_id | text           | nullable    | null    | The Queue message idempotency key, `UNIQUE`                                                               |
| tenant_id         | text           | nullable    | null    | Null for platform-level notifications (xid.dev system mail) that have no tenant context                   |
| channel           | text           | NOT NULL    | --      | `email`/`whatsapp`/`sms`                                                                                  |
| recipient         | text           | NOT NULL    | --      | The recipient identifier (a hash or non-secret metadata only; never a full email address or phone number) |
| type              | text           | NOT NULL    | --      | The notification template name (verify_email / magic_link / otp / password_reset and so on)               |
| payload           | text json      | NOT NULL    | `{}`    | Non-secret metadata (no token, link, code, or body content)                                               |
| provider          | text           | nullable    | null    | The provider name (cloudflare/twilio/meta/vonage); the email consumer does not currently write it         |
| reason            | text           | NOT NULL    | --      | The failure reason                                                                                        |
| attempts          | integer number | NOT NULL    | `1`     |                                                                                                           |
| failed_at         | text           | NOT NULL    | --      | ISO 8601 UTC                                                                                              |
| created_at        | integer ts_ms  | NOT NULL    | See 9.3 |                                                                                                           |

Indexes: `UNIQUE(source_message_id)`, `INDEX(tenant_id)`, `INDEX(channel, type)`, `INDEX(failed_at)`.

### 17.9 notification_delivery_outbox (the durable notification delivery outbox)

Persists notifications awaiting redelivery when the Queue is briefly unavailable. Both the recipient
and the payload are stored as a KEK envelope encryption triple, so no plaintext recipient, token,
link, or OTP is ever persisted.

| Field                   | Type           | Constraints                      | Default     | Notes                                                                                                 |
| ----------------------- | -------------- | -------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------- |
| id                      | text           | PK                               | nanoid      |                                                                                                       |
| tenant_id               | text           | NOT NULL, FK -> organizations.id | --          |                                                                                                       |
| delivery_key            | text           | NOT NULL                         | --          | The idempotency key, `UNIQUE(tenant_id, delivery_key)`                                                |
| source_message_id       | text           | nullable                         | null        | The Queue message id                                                                                  |
| delivery_identity       | text           | nullable                         | null        | The delivery identity idempotency key (when non-null, `UNIQUE(tenant_id, delivery_identity)`)         |
| channel                 | text           | NOT NULL                         | --          | `email`/`whatsapp`/`sms`                                                                              |
| type                    | text           | NOT NULL                         | --          | The notification template name                                                                        |
| provider                | text           | nullable                         | null        |                                                                                                       |
| recipient_hash          | text           | NOT NULL                         | --          | The recipient hash (for lookup and idempotency)                                                       |
| recipient_iv            | text           | NOT NULL                         | --          | The recipient envelope encryption triple (base64url TEXT)                                             |
| recipient_ciphertext    | text           | NOT NULL                         | --          |                                                                                                       |
| recipient_tag           | text           | NOT NULL                         | --          |                                                                                                       |
| payload_iv              | text           | NOT NULL                         | --          | The payload envelope encryption triple (base64url TEXT)                                               |
| payload_ciphertext      | text           | NOT NULL                         | --          |                                                                                                       |
| payload_tag             | text           | NOT NULL                         | --          |                                                                                                       |
| status                  | text           | NOT NULL                         | `'pending'` | `pending`/`sending`/`provider_accepted`/`auditing`/`delivered`/`provider_rejected`/`unknown_delivery` |
| attempt_count           | integer number | NOT NULL                         | `0`         |                                                                                                       |
| available_at            | integer ts_ms  | NOT NULL                         | --          | When it becomes schedulable (backoff)                                                                 |
| lease_until             | integer ts_ms  | nullable                         | null        | When the consumer lease expires                                                                       |
| last_error_code         | text           | nullable                         | null        |                                                                                                       |
| failure_kind            | text           | nullable                         | null        | Failure classification                                                                                |
| failed_at               | integer ts_ms  | nullable                         | null        |                                                                                                       |
| provider_accepted_at    | integer ts_ms  | nullable                         | null        | When the provider explicitly accepted it                                                              |
| audit_queued_at         | integer ts_ms  | nullable                         | null        |                                                                                                       |
| queued_at               | integer ts_ms  | nullable                         | null        |                                                                                                       |
| delivered_at            | integer ts_ms  | nullable                         | null        |                                                                                                       |
| dead_at                 | integer ts_ms  | nullable                         | null        | The terminal-state time (a reserved column with no current writes)                                    |
| created_at / updated_at | integer ts_ms  | NOT NULL                         | See 9.3     |                                                                                                       |

Indexes: `UNIQUE(tenant_id, delivery_key)`, `UNIQUE(tenant_id, delivery_identity)` (partial),
`INDEX(tenant_id, status, available_at)`, `INDEX(status, available_at, lease_until)`,
`INDEX(status, failure_kind, failed_at)`.

### 17.10 notification_delivery_failures (provider rejections and indeterminate delivery records)

Both an explicit provider rejection and an indeterminate call result are persisted separately. A Queue
retry can only escalate an indeterminate delivery to manual handling based on this record; an unknown
result MUST NOT be resent to the external provider.

| Field                   | Type           | Constraints                      | Default | Notes                                                                                      |
| ----------------------- | -------------- | -------------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| id                      | text           | PK                               | nanoid  |                                                                                            |
| tenant_id               | text           | NOT NULL, FK -> organizations.id | --      |                                                                                            |
| channel                 | text           | NOT NULL                         | --      |                                                                                            |
| source_message_id       | text           | NOT NULL                         | --      |                                                                                            |
| delivery_identity       | text           | NOT NULL                         | --      | `UNIQUE(tenant_id, delivery_identity)`                                                     |
| provider                | text           | NOT NULL                         | --      |                                                                                            |
| outcome                 | text           | NOT NULL                         | --      | `rejected` (the provider explicitly rejected it) / `indeterminate` (the result is unknown) |
| reason                  | text           | NOT NULL                         | --      |                                                                                            |
| attempt_count           | integer number | NOT NULL                         | --      |                                                                                            |
| failed_at               | integer ts_ms  | NOT NULL                         | --      |                                                                                            |
| created_at / updated_at | integer ts_ms  | NOT NULL                         | See 9.3 |                                                                                            |

Indexes: `UNIQUE(tenant_id, delivery_identity)`, `INDEX(tenant_id, outcome, failed_at)`,
`INDEX(channel, source_message_id)`.

### 17.11 queue_dead_letters (encrypted business Queue dead letters)

The platform-level operational record is readable only through the `instance_manager` path. A
nullable `tenant_id` lets malformed or instance-level messages be retained, while tenant-scoped code
can access tenant-owned rows through `createTenantDb`.

| Field                     | Type                 | Constraints | Default                      | Notes                                                                    |
| ------------------------- | -------------------- | ----------- | ---------------------------- | ------------------------------------------------------------------------ |
| id                        | text                 | PK          | `dlq_`+nanoid                |                                                                          |
| source_queue              | text                 | NOT NULL    | --                           | One of the eight business Queue names                                    |
| dead_letter_queue         | text                 | NOT NULL    | --                           | The independent DLQ observed in `MessageBatch.queue`                     |
| message_id                | text                 | NOT NULL    | --                           | `UNIQUE(source_queue, message_id)`                                       |
| tenant_id / org_id        | text                 | nullable    | null                         | Bounded routing metadata only                                            |
| event_type                | text                 | NOT NULL    | `'unknown'`                  | Bounded template/action/event name, never a message body                 |
| error_code                | text                 | NOT NULL    | `consumer_retries_exhausted` | Static operational code, never a provider response                       |
| status                    | text                 | NOT NULL    | `'pending'`                  | `pending`/`replaying`/`replayed`                                         |
| attempts                  | integer number       | NOT NULL    | `1`                          | Attempt count exposed by the DLQ consumer message                        |
| payload_iv                | text                 | NOT NULL    | --                           | Existing KEK AES-256-GCM envelope, base64url                             |
| payload_ciphertext        | text                 | NOT NULL    | --                           | There is no plaintext payload/body/recipient column                      |
| payload_tag               | text                 | NOT NULL    | --                           |                                                                          |
| payload_kek_version       | integer number       | NOT NULL    | `1`                          |                                                                          |
| source_enqueued_at        | integer ts_ms        | NOT NULL    | --                           | Queue message timestamp                                                  |
| failed_at                 | integer ts_ms        | NOT NULL    | --                           | DLQ persistence time                                                     |
| replay_requested_at       | integer ts_ms        | nullable    | null                         | Atomic replay claim time and five-minute lease start                     |
| replayed_at / replayed_by | integer ts_ms / text | nullable    | null                         | Completion and Instance Manager actor                                    |
| replay_count              | integer number       | NOT NULL    | `0`                          | Observable completed replay transitions; lease recovery is at-least-once |
| last_replay_error_code    | text                 | nullable    | null                         | Static retry-safe code; never exception text                             |
| created_at / updated_at   | integer ts_ms        | NOT NULL    | See 9.3                      |                                                                          |

Indexes: `UNIQUE(source_queue, message_id)`, `INDEX(status, failed_at, id)`,
`INDEX(tenant_id, failed_at, id)`, `INDEX(source_queue, status)`.

> FeatureFlag lives in KV (`flag:{tenant_id}:{flag_name}` / `flag:global:{flag_name}`, see chapter 07
> section 1 and the cloudflare-bindings rule) and **has no D1 table**. OrgBranding lives in KV
> (`brand:{tenant_id}` / `brand:{tenant_id}:{org_id}`, see chapter 07 section 2) plus R2 (logo and
> CSS) and has no D1 table. Of the OrgBranding and OrgMetadata entries in this chapter's entity
> inventory, OrgMetadata has been folded into organizations.public/private_metadata (section 11 does
> not give it its own table). OrganizationQuota has its own `organization_quotas` table for
> operator-configured resource limits. Its `seats` row is authoritative; the root
> `organizations.seat_limit` is a compatibility mirror, while billing computes seat usage from
> tenant-wide distinct active membership users.

## 18. Field decision summary (settled items affecting security and interoperability)

| Entity.field                      | Decision                                                                                          | Rationale                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| instance_signing_keys private key | iv/ciphertext/tag in **three separate blob columns** plus kek_version                             | Independent reads, no JSON ambiguity, rotation compatible (see the signing-keys rule)                                                            |
| cert_store private key            | Same three-column split                                                                           | Consistent with the signing key                                                                                                                  |
| passkey_credentials.public_key    | Stores the **raw COSE bytes (blob)**, not JWK JSON                                                | The normalized COSE is the source of truth, and authentication imports it directly without renegotiation (see registration step 9 in chapter 01) |
| passkey_credentials.aaguid        | A 16-byte blob                                                                                    | Platform-synced passkeys may be all zeros, so it MUST be preserved verbatim for the check                                                        |
| refresh_tokens                    | token_hash (UNIQUE) + family_id + parent_token_id + revoked_at + expires_at + absolute_expires_at | Rotation plus family replay detection plus dual idle/absolute expiry (see chapter 03 section 11)                                                 |
| sessions.device_fingerprint       | Stores the **SHA-256 hash**, not the plaintext                                                    | Privacy, and the hash is sufficient for comparison (see chapter 05 section 8)                                                                    |
| sessions.refresh_token_hash       | Stores SHA-256; the plaintext appears only in Set-Cookie                                          | A database leak cannot be replayed (see chapter 05 section 8.2)                                                                                  |
| Every token and secret            | Always **stored as a hash or ciphertext**, with the plaintext shown once                          | password_reset / invite / scim_token / api_key / webhook_secret / social_token (see the relevant chapters)                                       |
| Tenant-scoped unique constraints  | The first column of a composite UNIQUE MUST be tenant_id                                          | The same value in different tenants does not collide (see 9.5 and the tenant-isolation rule)                                                     |
| Timestamps                        | Always Unix millisecond integers (audit.occurred_at is the ISO TEXT exception)                    | Drizzle `timestamp_ms` maps to Date; audit occurred_at feeds the hash so it stays ISO (see chapter 07 section 5.1.2)                             |
| Primary key id                    | A prefixed nanoid rather than a UUID                                                              | URL-friendly and does not expose an auto-increment value (see 9.1 and the 9.6 prefix table)                                                      |
