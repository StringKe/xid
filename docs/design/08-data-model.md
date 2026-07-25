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

The 8 current Durable Objects (binding -> class):

| Binding            | Class           | Purpose                                                                        |
| ------------------ | --------------- | ------------------------------------------------------------------------------ |
| SESSION_REVOCATION | SessionDO       | Per-user session revocation set (the source of truth for revocation, see 17.1) |
| WEBAUTHN_CHALLENGE | ChallengeStore  | WebAuthn challenge (destroyed after verification, see the webauthn rule)       |
| OAUTH_STATE        | OAuthFlowDO     | Authorize parameters staged before sign-in, plus state/nonce CSRF defense      |
| PAR_STORE          | ParStore        | PAR request_uri parameters (60s, single use, see 15.3)                         |
| DEVICE_FLOW        | DeviceFlowStore | device_code/user_code state machine (see 15.2)                                 |
| RATE_LIMITER       | RateLimitStore  | Per-tenant rate limit counters                                                 |
| AUDIT_SEQ          | AuditSeqDO      | Audit seq issuance (sharded by `audit-seq:{tenantId}`, see 17.2)               |
| METERING           | MeteringDO      | Exact DAU/MAU deduplication (sharded by `metering:{tenantId}`, see 17.3)       |

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

---

# Field-level Drizzle schema implementation spec

The sections below are the **single source of truth** for `packages/db` (the Drizzle schema) and
`packages/types` (the TypeScript types). Each core entity gets a complete field table plus index
declarations plus foreign key ON DELETE policies. Once a field name and physical type are settled, the
implementation MUST NOT deviate; adding, removing, or changing a field means changing this chapter
first and the implementation second. There are currently 57 D1 tables (matching
`packages/db/src/schema` and the `packages/db/drizzle` migrations); device_codes and par_requests are
logical structures inside Durable Objects and do not count as tables.

## 9. Shared conventions (applying to every table)

### 9.1 IDs and primary keys

- Every primary key `id` is `text`, holding a prefixed nanoid (the external identifier, which does not
  expose an auto-increment value; see the sub convention in chapter 05 section 8.1). The prefix table
  is in 9.6.
- Primary key nanoid generation: 21 characters from a base62 alphabet (`A-Za-z0-9`) with the prefix
  followed by `_` (for example `user_V1StGXR8Z5jdHi6BmyT`), unique across the table. UUIDs are not used
  as primary keys (prefixed nanoids are URL-friendly and smaller); UUIDs are used only where a protocol
  requires UUID v4, such as jti and audit.id.

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

| Relationship type                                                          | ON DELETE                                                       | Rationale                                                                                                           |
| -------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| A child that dies with its parent (a user's credentials, emails, sessions) | `cascade`                                                       | Deleting a user MUST clear every credential, leaving nothing dangling                                               |
| A reference that must retain history (audit.actor_id, token.user_id)       | `no action` (soft delete or anonymize at the application layer) | The audit chain cannot be cascade-deleted; GDPR replaces the value with `[deleted_user]` (see chapter 07 section 8) |
| An optional association (session.active_org_id)                            | `set null`                                                      | After an org is deleted, the session falls back to having no org context                                            |
| Configuration ownership (application -> project)                           | `cascade`                                                       | Deleting a project deletes its applications too                                                                     |

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
| organization_domains | `UNIQUE (domain)`                                | Globally unique domain (one domain can be claimed by only one org, see chapter 04 section 5); not tenant-scoped |
| refresh_tokens       | `UNIQUE (token_hash)`                            | Globally unique hash (see chapter 03 section 11.1)                                                              |
| roles                | `UNIQUE (tenant_id, project_id, key)`            | Role key unique within the project                                                                              |
| permissions          | `UNIQUE (tenant_id, project_id, key)`            | Permission key unique within the project                                                                        |

> A SQLite UNIQUE index treats multiple NULLs as distinct (no collision), which is why external_id and
> username can be nullable and still constrained.

### 9.5.1 Query path index baseline (P0)

Indexes are designed around the actual query predicates. A tenant isolation unique index MUST NOT be
mistaken for a cross-tenant resolution index:

| Query path                                  | Index requirement                                                   | Purpose                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Apex-domain sign-in by email/phone          | `INDEX(email,user_id,tenant_id)`, `INDEX(phone,user_id,tenant_id)`  | Identify which organization a user belongs to from the apex domain, across tenants |
| Apex-domain sign-in by username/external_id | `INDEX(username,tenant_id)`, `INDEX(external_id,tenant_id)`         | Match the sign-in field first, then return the tenant                              |
| Host-based tenant resolution                | `INDEX(instance_id,slug)`                                           | Resolve an organization by slug within an instance, exactly                        |
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
| Permission              | `perm_`  | Directory                           | `dir_`                                        |
| UserGrant               | `ug_`    | SigningKey (id)                     | `sk_`                                         |
| ManagerAssignment       | `mgr_`   | CertStore                           | `cert_`                                       |
| MfaFactor               | `mfa_`   | Webhook                             | `wh_`                                         |
| TrustedDevice           | `dev_`   | ApiKey (id)                         | `ak_`                                         |
| PasskeyCredential       | `pk_`    | PlatformAdmin                       | `padmin_`                                     |
| UserIdentity            | `idn_`   | Instance                            | `inst_`                                       |

> Note: `pk_test_` and `sk_live_` are the prefixes of the **plaintext token** for an ApiKey or a
> publishable key (see the api-sdk-conventions rule). They are a separate namespace from this table's
> internal id prefixes (`ak_`) and the two MUST NOT be conflated.

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
| slug                    | text            | NOT NULL                                           | --                  | Used in URLs and subdomains, see 9.5 `UNIQUE(tenant_id,slug)`                                        |
| name                    | text            | NOT NULL                                           | --                  | Display name                                                                                         |
| logo_url                | text            | nullable                                           | null                | R2 logo URL (branding lives in OrgBranding)                                                          |
| public_metadata         | text json       | NOT NULL                                           | `{}`                | Readable by the frontend (see chapter 02 section 5)                                                  |
| private_metadata        | text json       | NOT NULL                                           | `{}`                | Server and admin only                                                                                |
| seat_limit              | integer number  | nullable                                           | null                | Billing seat cap; null means unlimited (see chapter 02 section 2)                                    |
| seat_used               | integer number  | NOT NULL                                           | `0`                 | The current active member count                                                                      |
| enrollment_mode         | text            | NOT NULL                                           | `'invite_required'` | `automatic`/`invite_required` (automatic domain assignment, see chapter 02 section 2)                |
| allow_org_self_service  | integer boolean | NOT NULL                                           | `1`                 | When off, an org admin cannot change SSO or MFA (see chapter 02 section 6)                           |
| status                  | text            | NOT NULL                                           | `'active'`          | `active`/`suspended`/`deleted`                                                                       |
| deleted_at              | integer ts_ms   | nullable                                           | null                | Soft delete marker (an Instance Manager deleting an org)                                             |
| created_at / updated_at | integer ts_ms   | NOT NULL                                           | See 9.3             |                                                                                                      |

Indexes: `UNIQUE(tenant_id, slug)`, `INDEX(instance_id)`, `INDEX(parent_org_id)`,
`INDEX(tenant_id, status)`.

### 10.3 projects (role namespace)

| Field                   | Type          | Constraints                                        | Default        | Notes                             |
| ----------------------- | ------------- | -------------------------------------------------- | -------------- | --------------------------------- |
| id                      | text          | PK                                                 | `proj_`+nanoid |                                   |
| tenant_id               | text          | NOT NULL, FK -> organizations.id                   | --             | Isolation key                     |
| org_id                  | text          | NOT NULL, FK -> organizations.id ON DELETE cascade | --             | The owning org (may be a sub-org) |
| name                    | text          | NOT NULL                                           | --             |                                   |
| description             | text          | nullable                                           | null           |                                   |
| created_at / updated_at | integer ts_ms | NOT NULL                                           | See 9.3        |                                   |

Indexes: `INDEX(tenant_id, org_id)`.

### 10.4 applications (= OAuthClient, the OIDC/SAML client)

Chapter 02's Application and chapter 03's OAuthClient are merged into one table (two views of the same
entity).

| Field                          | Type            | Constraints                                   | Default                                         | Notes                                                                                                                                                  |
| ------------------------------ | --------------- | --------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| id                             | text            | PK                                            | `app_`+nanoid                                   |                                                                                                                                                        |
| tenant_id                      | text            | NOT NULL, FK -> organizations.id              | --                                              | Isolation key                                                                                                                                          |
| project_id                     | text            | FK -> projects.id ON DELETE cascade, nullable | null                                            | Bound project (inheriting its role set, see chapter 02 section 1); a platform-level app may be null                                                    |
| client_id                      | text            | NOT NULL, UNIQUE                              | = id or an independent string                   | The OAuth client_id, exposed externally                                                                                                                |
| client_secret_hash             | text            | nullable                                      | null                                            | Hashed storage (see chapter 03 section 4; plaintext is never stored); null for public clients                                                          |
| client_type                    | text            | NOT NULL                                      | `'confidential'`                                | `confidential`/`public`/`native`/`m2m` (see chapter 03 section 4)                                                                                      |
| token_endpoint_auth_method     | text            | NOT NULL                                      | `'client_secret_basic'`                         | `client_secret_basic`/`client_secret_post`/`private_key_jwt`/`tls_client_auth`/`self_signed_tls_client_auth`/`none` (see chapter 03 section 9.6)       |
| jwks                           | text json       | nullable                                      | null                                            | The client's public key set for private_key_jwt                                                                                                        |
| redirect_uris                  | text json       | NOT NULL                                      | `[]`                                            | An exact-match array; wildcards are forbidden (see the oidc-oauth rule)                                                                                |
| post_logout_redirect_uris      | text json       | NOT NULL                                      | `[]`                                            | Used by end_session                                                                                                                                    |
| frontchannel_logout_uri        | text            | nullable                                      | null                                            | (see chapter 03 section 7)                                                                                                                             |
| backchannel_logout_uri         | text            | nullable                                      | null                                            |                                                                                                                                                        |
| allowed_grant_types            | text json       | NOT NULL                                      | `["authorization_code","refresh_token"]`        | Allowlist (see chapter 03 section 9.0 step 5)                                                                                                          |
| allowed_response_types         | text json       | NOT NULL                                      | `["code"]`                                      |                                                                                                                                                        |
| allowed_scopes                 | text json       | NOT NULL                                      | `["openid","profile","email","offline_access"]` | The client_credentials scope allowlist                                                                                                                 |
| require_pkce                   | integer boolean | NOT NULL                                      | `1`                                             | Mandatory for public clients; configurable for confidential ones (PKCE downgrade defense, see chapter 03 section 9.1)                                  |
| dpop_bound_access_tokens       | integer boolean | NOT NULL                                      | `0`                                             | Registration requires DPoP (see chapter 03 section 9.0 step 6)                                                                                         |
| access_token_format            | text            | NOT NULL                                      | `'jwt'`                                         | `jwt`/`opaque` (see chapter 03 section 3)                                                                                                              |
| access_token_ttl_sec           | integer number  | nullable                                      | null                                            | Nullable; NULL means inherit the tenant token policy (the three-level chain application -> org -> instance, bounds 60-86400, see chapter 03 section 3) |
| id_token_signed_alg            | text            | NOT NULL                                      | `'ES256'`                                       | Overridable per client (`RS256`/`PS256`)                                                                                                               |
| first_party                    | integer boolean | NOT NULL                                      | `0`                                             | First-party clients skip consent (see chapter 03 section 10.5)                                                                                         |
| require_org_context            | integer boolean | NOT NULL                                      | `0`                                             | Force org selection (see chapter 02 section 4)                                                                                                         |
| custom_claims_config           | text json       | NOT NULL                                      | `{}`                                            | Client-level custom claim injection declaration (see chapter 02 section 7.1; keys MUST be declared explicitly)                                         |
| registration_access_token_hash | text            | nullable                                      | null                                            | The RFC 7592 dynamic registration management token hash                                                                                                |
| status                         | text            | NOT NULL                                      | `'active'`                                      | `active`/`inactive`                                                                                                                                    |
| created_at / updated_at        | integer ts_ms   | NOT NULL                                      | See 9.3                                         |                                                                                                                                                        |

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

| Field                     | Type            | Constraints                                       | Default        | Notes                                                                                                                                                                           |
| ------------------------- | --------------- | ------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                        | text            | PK                                                | `user_`+nanoid | Also the JWT sub (see chapter 05 section 8.1)                                                                                                                                   |
| tenant_id                 | text            | NOT NULL, FK -> organizations.id                  | --             | The owning tenant                                                                                                                                                               |
| username                  | text            | nullable                                          | null           | See 9.5 `UNIQUE(tenant_id,username)`                                                                                                                                            |
| external_id               | text            | nullable                                          | null           | See 9.5 `UNIQUE(tenant_id,external_id)`                                                                                                                                         |
| primary_email_id          | text            | FK -> user_emails.id ON DELETE set null, nullable | null           | Primary email (see chapter 05 section 1; a change requires re-verification)                                                                                                     |
| primary_phone_id          | text            | FK -> user_phones.id ON DELETE set null, nullable | null           | Primary phone                                                                                                                                                                   |
| first_name                | text            | nullable                                          | null           |                                                                                                                                                                                 |
| last_name                 | text            | nullable                                          | null           |                                                                                                                                                                                 |
| display_name              | text            | nullable                                          | null           |                                                                                                                                                                                 |
| avatar_url                | text            | nullable                                          | null           | R2 avatar                                                                                                                                                                       |
| locale                    | text            | nullable                                          | null           | Falls back to the tenant or instance when absent (see chapter 07 section 4)                                                                                                     |
| timezone                  | text            | nullable                                          | null           |                                                                                                                                                                                 |
| public_metadata           | text json       | NOT NULL                                          | `{}`           | Backend-written, frontend read-only (see chapter 05 section 1)                                                                                                                  |
| private_metadata          | text json       | NOT NULL                                          | `{}`           | Server only, not returned by default                                                                                                                                            |
| unsafe_metadata           | text json       | NOT NULL                                          | `{}`           | Writable by both frontend and backend                                                                                                                                           |
| custom_attributes         | text json       | NOT NULL                                          | `{}`           | Tenant-defined extra fields (see chapter 05 section 1; a generated column index can be configured)                                                                              |
| status                    | text            | NOT NULL                                          | `'active'`     | `active`/`banned`/`locked`/`suspended`/`pending_mfa_setup`/`deactivated`/`deleted` (see chapter 05 section 5, mandatory MFA in password-auth, and deprovisioning in chapter 04) |
| password_change_required  | integer boolean | NOT NULL                                          | `0`            | Forced password change flag (see chapter 05 section 6)                                                                                                                          |
| is_new_user               | integer boolean | NOT NULL                                          | `1`            | First sign-in onboarding (see chapter 05 section 2)                                                                                                                             |
| profile_completion_status | text            | NOT NULL                                          | `'incomplete'` | Progressive profiling (see chapter 05 section 2)                                                                                                                                |
| lockout_until             | integer ts_ms   | nullable                                          | null           | Account lockout expiry (exponential backoff, see the anti-abuse rule)                                                                                                           |
| failed_login_count        | integer number  | NOT NULL                                          | `0`            | Consecutive failure counter (triggers lockout)                                                                                                                                  |
| last_login_at             | integer ts_ms   | nullable                                          | null           |                                                                                                                                                                                 |
| merged_into_user_id       | text            | FK -> users.id ON DELETE set null, nullable       | null           | Account merging: the secondary account points at the primary (see chapter 05 section 3)                                                                                         |
| provisioned_by            | text            | nullable                                          | null           | `jit_sso`/`scim`/`signup`/`invite`/`admin` (see chapter 04 section 4)                                                                                                           |
| deleted_at                | integer ts_ms   | nullable                                          | null           | Soft delete (PII hard-deleted after 30 days, see chapter 05 section 7)                                                                                                          |
| created_at / updated_at   | integer ts_ms   | NOT NULL                                          | See 9.3        |                                                                                                                                                                                 |

Indexes: `UNIQUE(tenant_id, username)`, `UNIQUE(tenant_id, external_id)`, `INDEX(tenant_id, status)`,
`INDEX(tenant_id, created_at)`, `INDEX(primary_email_id)`, `INDEX(merged_into_user_id)`.
primary_email_id/primary_phone_id and user_emails/user_phones reference each other, so after table
creation use a deferred FK or maintain it at the application layer (SQLite does not support
ALTER ADD FK; declaring the FK in Drizzle is sufficient, and it is not enforced at runtime).

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
| created_at / updated_at | integer ts_ms   | NOT NULL                                   | See 9.3        |                                                                                                 |

Indexes: `UNIQUE(tenant_id, email)`, `INDEX(tenant_id, user_id)`.

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

| Field         | Type           | Constraints                                | Default | Notes                                                                        |
| ------------- | -------------- | ------------------------------------------ | ------- | ---------------------------------------------------------------------------- |
| id            | text           | PK                                         | nanoid  |                                                                              |
| tenant_id     | text           | NOT NULL, FK -> organizations.id           | --      |                                                                              |
| user_id       | text           | NOT NULL, FK -> users.id ON DELETE cascade | --      |                                                                              |
| token_hash    | text           | NOT NULL, UNIQUE                           | --      | The magic link token SHA-256; the plaintext never enters the database        |
| code_hash     | text           | nullable                                   | null    | OTP HMAC-SHA256 (null for non-OTP purposes)                                  |
| channel       | text           | nullable                                   | null    | `email`/`sms`                                                                |
| purpose       | text           | NOT NULL                                   | --      | `magic_link`/`otp` and so on, distinguishing the purpose                     |
| attempt_count | integer number | NOT NULL                                   | `0`     | OTP failure counter; invalidated after at most 5 (see chapter 01 section 4)  |
| consumed_at   | integer ts_ms  | nullable                                   | null    | Single use; filled in on consumption                                         |
| expires_at    | integer ts_ms  | NOT NULL                                   | --      | magic link 15min / email OTP 10min / sms OTP 5min (see chapter 01 section 4) |
| created_at    | integer ts_ms  | NOT NULL                                   | See 9.3 |                                                                              |

Indexes: `UNIQUE(token_hash)`, `INDEX(tenant_id, user_id)`, and the partial
`UNIQUE(tenant_id, user_id, purpose, coalesce(channel,'')) WHERE consumed_at IS NULL AND purpose IN ('magic_link','otp')`
(at most one active row per user, purpose, and channel; a resend invalidates the old row first).

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
| enterprise_attestation_verified | integer boolean | NOT NULL                                   | `0`          | The result of the enterprise attestation chain check performed by `verifyRegistration`, gating AAL3 `direct` mode                                                                                                            |
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

| Field                | Type          | Constraints                                      | Default | Notes                                                                                                                       |
| -------------------- | ------------- | ------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| id                   | text          | PK                                               | nanoid  |                                                                                                                             |
| tenant_id            | text          | NOT NULL, FK -> organizations.id                 | --      |                                                                                                                             |
| role_id              | text          | NOT NULL, FK -> roles.id ON DELETE cascade       | --      |                                                                                                                             |
| permission_id        | text          | NOT NULL, FK -> permissions.id ON DELETE cascade | --      |                                                                                                                             |
| condition_expression | text json     | nullable                                         | null    | The ABAC v1 condition (a single condition or `{and:[...]}`, see chapter 02 section 7.3); null means granted unconditionally |
| created_at           | integer ts_ms | NOT NULL                                         | See 9.3 |                                                                                                                             |

Indexes: `UNIQUE(role_id, permission_id)`, `INDEX(tenant_id, role_id)`.

### 13.4 user_grants (user role grants, see chapter 02 sections 7.2 and 7.4)

| Field                   | Type          | Constraints                                         | Default      | Notes                                                                                            |
| ----------------------- | ------------- | --------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------ |
| id                      | text          | PK                                                  | `ug_`+nanoid |                                                                                                  |
| tenant_id               | text          | NOT NULL, FK -> organizations.id                    | --           | In the Grant scenario the tenant is org A (see the step 1 note in chapter 02 section 7.4)        |
| user_id                 | text          | NOT NULL, FK -> users.id ON DELETE cascade          | --           |                                                                                                  |
| project_id              | text          | NOT NULL, FK -> projects.id ON DELETE cascade       | --           |                                                                                                  |
| role_id                 | text          | NOT NULL, FK -> roles.id ON DELETE cascade          | --           |                                                                                                  |
| granted_via_grant_id    | text          | FK -> project_grants.id ON DELETE cascade, nullable | null         | Non-null takes the Grant query path (see chapter 02 section 7.4)                                 |
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

Indexes: `UNIQUE(user_id, manager_role, scope_type, scope_id)`, `INDEX(tenant_id, user_id)`,
`INDEX(scope_type, scope_id)`.

## 14. Organization membership entities (see chapter 02 section 2)

### 14.1 memberships (the User-Organization relationship)

| Field                   | Type            | Constraints                                        | Default       | Notes                                                                                     |
| ----------------------- | --------------- | -------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------- |
| id                      | text            | PK                                                 | `mem_`+nanoid |                                                                                           |
| tenant_id               | text            | NOT NULL, FK -> organizations.id                   | --            |                                                                                           |
| org_id                  | text            | NOT NULL, FK -> organizations.id ON DELETE cascade | --            | The org the member belongs to                                                             |
| user_id                 | text            | NOT NULL, FK -> users.id ON DELETE cascade         | --            |                                                                                           |
| role                    | text            | NOT NULL                                           | `'member'`    | The org-level role (independent per org, see chapter 02 section 4)                        |
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
| email                   | text           | NOT NULL                                           | --            | The invited email (bound, pre-filled on acceptance, see chapter 05 section 2)                                                                                      |
| role                    | text           | NOT NULL                                           | `'member'`    | The invited role                                                                                                                                                   |
| token_hash              | text           | NOT NULL, UNIQUE                                   | --            | The invitation token SHA-256 (stored in the database rather than as a JWT so it can be revoked, see chapter 02 section 2); the plaintext never enters the database |
| invite_type             | text           | NOT NULL                                           | `'email'`     | `email`/`link` (a link invitation can be reusable or single use)                                                                                                   |
| max_uses                | integer number | nullable                                           | null          | Use limit for a link invitation; null means unlimited                                                                                                              |
| used_count              | integer number | NOT NULL                                           | `0`           |                                                                                                                                                                    |
| status                  | text           | NOT NULL                                           | `'pending'`   | `pending`/`accepted`/`revoked`/`expired`                                                                                                                           |
| invited_by_user_id      | text           | FK -> users.id ON DELETE set null, nullable        | null          |                                                                                                                                                                    |
| accepted_by_user_id     | text           | FK -> users.id ON DELETE set null, nullable        | null          |                                                                                                                                                                    |
| expires_at              | integer ts_ms  | NOT NULL                                           | now+72h       | Valid 24-72 hours (see chapter 02 section 2)                                                                                                                       |
| created_at / updated_at | integer ts_ms  | NOT NULL                                           | See 9.3       |                                                                                                                                                                    |

Indexes: `UNIQUE(token_hash)`, `INDEX(tenant_id, org_id, status)`, `INDEX(tenant_id, email)`.

### 14.3 organization_domains (organization email domains, see chapter 02 section 5 and chapter 04 section 5)

Shared by SSO routing and automatic domain assignment.

| Field                   | Type            | Constraints                                        | Default             | Notes                                                                                     |
| ----------------------- | --------------- | -------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------- |
| id                      | text            | PK                                                 | nanoid              |                                                                                           |
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
| idp_metadata_url              | text            | nullable                                           | null           | Polled and refreshed every 24 hours (see chapter 04 section 1)                                                                       |
| idp_certificates              | text json       | NOT NULL                                           | `[]`           | IdP X.509 verification certificates (an array of base64 DER; old and new coexist during rotation, see chapter 04 section 9.5 step 1) |
| oidc_client_id                | text            | nullable                                           | null           | The OIDC RP client_id                                                                                                                |
| oidc_client_secret_ciphertext | blob buffer     | nullable                                           | null           | AES-256-GCM encrypted (`version\|\|iv\|\|ciphertext\|\|tag`)                                                                         |
| oidc_discovery_url            | text            | nullable                                           | null           | OIDC Discovery                                                                                                                       |
| sp_cert_id                    | text            | FK -> cert_store.id ON DELETE set null, nullable   | null           | The SP signing/decryption certificate (see 16.2 and chapter 04 section 1)                                                            |
| want_authn_response_signed    | integer boolean | NOT NULL                                           | `1`            | Require the Response to be signed (see chapter 04 section 9.3)                                                                       |
| want_assertions_signed        | integer boolean | NOT NULL                                           | `1`            | Require the Assertion to be signed                                                                                                   |
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
| usage                   | text           | NOT NULL                         | --             | `sp_signing`/`sp_encryption`/`idp_signing` (XID as the IdP)                                                                         |
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

Indexes: `INDEX(tenant_id, usage, status)`.

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

| Field                   | Type            | Constraints                                      | Default    | Notes                                                                                   |
| ----------------------- | --------------- | ------------------------------------------------ | ---------- | --------------------------------------------------------------------------------------- |
| id                      | text            | PK                                               | nanoid     | The SCIM User.id                                                                        |
| tenant_id               | text            | NOT NULL, FK -> organizations.id                 | --         |                                                                                         |
| directory_id            | text            | NOT NULL, FK -> directories.id ON DELETE cascade | --         |                                                                                         |
| user_id                 | text            | FK -> users.id ON DELETE set null, nullable      | null       | The bidirectional binding (the directory_user_id foreign key, see chapter 04 section 6) |
| external_id             | text            | nullable                                         | null       | The SCIM externalId                                                                     |
| user_name               | text            | NOT NULL                                         | --         | The SCIM userName (the primary sign-in identifier)                                      |
| scim_raw                | text json       | NOT NULL                                         | `{}`       | The raw SCIM resource (meta.version, ETag, and so on)                                   |
| active                  | integer boolean | NOT NULL                                         | `1`        | active=false means deprovisioned (a soft delete, see chapter 04 section 10.1.2)         |
| status                  | text            | NOT NULL                                         | `'active'` | `active`/`deactivated`/`deleted`                                                        |
| deleted_at              | integer ts_ms   | nullable                                         | null       | The SCIM DELETE soft delete marker                                                      |
| created_at / updated_at | integer ts_ms   | NOT NULL                                         | See 9.3    |                                                                                         |

Indexes: `UNIQUE(directory_id, user_name)`, `UNIQUE(directory_id, external_id)`,
`INDEX(tenant_id, directory_id)`, `INDEX(user_id)`.

### 16.7 directory_groups (SCIM-synced groups plus the group-to-role mapping, see chapter 04 section 6)

| Field                   | Type          | Constraints                                      | Default    | Notes                                                                                                  |
| ----------------------- | ------------- | ------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------ |
| id                      | text          | PK                                               | nanoid     | The SCIM Group.id                                                                                      |
| tenant_id               | text          | NOT NULL, FK -> organizations.id                 | --         |                                                                                                        |
| directory_id            | text          | NOT NULL, FK -> directories.id ON DELETE cascade | --         |                                                                                                        |
| display_name            | text          | NOT NULL                                         | --         | The group-to-role mapping key (a change updates the mapping in step, see chapter 04 sections 6 and 10) |
| mapped_role             | text          | nullable                                         | null       | The mapped org role                                                                                    |
| status                  | text          | NOT NULL                                         | `'active'` | `active`/`deleted`                                                                                     |
| deleted_at              | integer ts_ms | nullable                                         | null       | The SCIM DELETE soft delete marker                                                                     |
| created_at / updated_at | integer ts_ms | NOT NULL                                         | See 9.3    |                                                                                                        |

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
| id                      | text          | PK                                                 | nanoid                                                     |                                                                                                    |
| tenant_id               | text          | NOT NULL, FK -> organizations.id                   | --                                                         |                                                                                                    |
| org_id                  | text          | NOT NULL, FK -> organizations.id ON DELETE cascade | --                                                         | The org the SP belongs to                                                                          |
| sp_entity_id            | text          | NOT NULL                                           | --                                                         | The per-SP EntityID (see chapter 04 section 2)                                                     |
| acs_url                 | text          | NOT NULL                                           | --                                                         | The SP ACS URL                                                                                     |
| slo_url                 | text          | nullable                                           | null                                                       | The SP SLO receiving endpoint                                                                      |
| slo_binding             | text          | NOT NULL                                           | `'redirect'`                                               | The SLO binding (`redirect`/`post`)                                                                |
| sp_certificates         | text json     | NOT NULL                                           | `[]`                                                       | SP X.509 certificates (an array of base64 DER, used for SLO signature verification and encryption) |
| attribute_mapping       | text json     | NOT NULL                                           | `{}`                                                       | Assertion field mapping                                                                            |
| name_id_format          | text          | NOT NULL                                           | `'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress'` |                                                                                                    |
| idp_signing_cert_id     | text          | FK -> cert_store.id ON DELETE set null, nullable   | null                                                       | The XID IdP signing certificate (usage=idp_signing)                                                |
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

| Field                   | Type          | Constraints                                        | Default    | Notes                                                                                                                     |
| ----------------------- | ------------- | -------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| id                      | text          | PK                                                 | nanoid     |                                                                                                                           |
| tenant_id               | text          | NOT NULL, FK -> organizations.id                   | --         |                                                                                                                           |
| org_id                  | text          | NOT NULL, FK -> organizations.id ON DELETE cascade | --         |                                                                                                                           |
| provider                | text          | NOT NULL                                           | --         | The downstream SaaS identifier (see chapter 04 section 3)                                                                 |
| base_url                | text          | NOT NULL                                           | --         | The downstream SCIM endpoint base URL                                                                                     |
| token_secret_ref        | text          | NOT NULL                                           | --         | The secret reference for the downstream bearer token (stored in Workers Secrets; the plaintext never enters the database) |
| user_filter             | text json     | NOT NULL                                           | `{}`       | The push scope filter (which users and groups go outbound)                                                                |
| status                  | text          | NOT NULL                                           | `'active'` | `active` (outbound sync reads only active rows)                                                                           |
| last_sync_at            | integer ts_ms | nullable                                           | null       |                                                                                                                           |
| created_at / updated_at | integer ts_ms | NOT NULL                                           | See 9.3    |                                                                                                                           |

Indexes: `INDEX(tenant_id, org_id)`, `INDEX(tenant_id, status)`.

## 17. Session and platform operations entities

### 17.1 sessions (user sessions, see chapter 05 section 8)

**Key decisions: the device_fingerprint is stored as a hash rather than plaintext; the refresh token is
stored as a hash; status drives revocation.**

| Field                   | Type            | Constraints                                         | Default        | Notes                                                                                                                                        |
| ----------------------- | --------------- | --------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| id                      | text            | PK                                                  | `sess_`+nanoid | The JWT sid; the first 8 characters form the cookie namespace (see chapter 05 section 8.4)                                                   |
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
| aal                     | integer number  | nullable                                            | null           | The NIST AAL level 1/2/3; AAL3 is issued only by the passkey MFA hardware-assured path                                                       |
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

| Field             | Type           | Constraints | Default                       | Notes                                                                                                     |
| ----------------- | -------------- | ----------- | ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| seq               | integer number | NOT NULL    | Issued by AuditSeqDO          | Monotonic within a tenant (AuditSeqDO is sharded by `audit-seq:{tenantId}`, see chapter 07 section 5.1.3) |
| id                | text           | NOT NULL    | UUID v4                       |                                                                                                           |
| source_message_id | text           | nullable    | null                          | The producer-side idempotency key (for deduplication; a partial `UNIQUE(tenant_id,source_message_id)`)    |
| tenant_id         | text           | NOT NULL    | --                            | The first column of the composite primary key                                                             |
| org_id            | text           | nullable    | null                          | Null for platform-level events (partitioned by org, see chapter 02 section 6)                             |
| event_type        | text           | NOT NULL    | --                            | `<domain>.<action>` (the enumeration is in chapter 07 section 5.1.5)                                      |
| actor_id          | text           | nullable    | null                          | The user_id or `system`; GDPR deletion replaces it with `[deleted_user]` (see chapter 07 section 8)       |
| actor_ip          | text           | nullable    | null                          |                                                                                                           |
| target_type       | text           | nullable    | null                          |                                                                                                           |
| target_id         | text           | nullable    | null                          |                                                                                                           |
| meta              | text json      | NOT NULL    | `{}`                          | Extra business fields (the hash uses the canonical form, see chapter 07 section 5.1.2)                    |
| occurred_at       | text           | NOT NULL    | ISO 8601 ms                   | The exception: TEXT (it feeds the hash input, with millisecond precision in UTC)                          |
| prev_hash         | text           | NOT NULL    | 64 zeros for the first record | The previous record's hash                                                                                |
| hash              | text           | NOT NULL    | --                            | This record's SHA-256 (see chapter 07 section 5.1.2)                                                      |

Primary key: `PRIMARY KEY (tenant_id, seq)`. Indexes: `INDEX(tenant_id, occurred_at)`,
`INDEX(tenant_id, actor_id)`, `INDEX(tenant_id, event_type)`. **INSERT only, with no UPDATE or
DELETE** (protected by a read-only account at the DDL layer, see chapter 07 section 5.1.1). No foreign
keys (the chain cannot be cascade-deleted).

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
| key_hash                | text          | NOT NULL, UNIQUE                 | --           | `SHA-256(sk_live_xxx)` (the plaintext carries the `sk_live_`/`pk_test_` prefix, see the api-sdk-conventions rule); the plaintext is shown once |
| key_prefix              | text          | NOT NULL                         | --           | A plaintext prefix fragment (such as `sk_live_a1b2`) for recognition, never the full value                                                     |
| environment             | text          | NOT NULL                         | `'live'`     | `live`/`test` (`pk_test_`/`sk_live_`)                                                                                                          |
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

> FeatureFlag lives in KV (`flag:{tenant_id}:{flag_name}` / `flag:global:{flag_name}`, see chapter 07
> section 1 and the cloudflare-bindings rule) and **has no D1 table**. OrgBranding lives in KV
> (`brand:{tenant_id}` / `brand:{tenant_id}:{org_id}`, see chapter 07 section 2) plus R2 (logo and
> CSS) and has no D1 table. Of the OrgBranding, OrgMetadata, and OrgQuota entries in this chapter's
> entity inventory, OrgMetadata has been folded into organizations.public/private_metadata (section 11
> does not give it its own table) and OrgQuota has been folded into
> organizations.seat_limit/seat_used.

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
