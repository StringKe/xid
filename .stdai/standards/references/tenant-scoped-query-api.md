---
type: references
name: tenant-scoped-query-api
description: The createTenantDb / TenantScoped / OrgScopedDb API surface, which tables are org-scoped, the per-tenant composite UNIQUE constraint table, how isolation shows up for Instance Manager versus Org Admin, and where the cross-tenant test suites live
---

# Tenant-scoped query API and isolation surface

Detail extracted from the `tenant-isolation` rule. Read this when you need the exact method list of
the scoped query handle, need to know whether an entity is org-scoped, need the per-tenant UNIQUE
constraint for a table, or need to know which existing test file a new cross-tenant test belongs in.
Implementation: `packages/db/src/tenant-db.ts` and `packages/db/src/schema/`. Design source:
`docs/design/02-tenancy-rbac.md` section 6 and `docs/design/08-data-model.md` 9.5. The iron rules
(no ad-hoc SQL, `tenant_id` never from the request body, management on separate paths) stay in the
`tenant-isolation` rule.

## Scoped query layer API

- `createTenantDb(d1, ctx)` -> `TenantDb`: one `TenantScoped` accessor per tenant table (51 tables in `TENANT_TABLES`), plus `tenantId` and `forOrg(orgId)`.
- `TenantScoped<T>` exposes only pre-scoped operations: `findMany`, `findOne`, `count`, `countDistinct`, `countBy`, `insert`, `insertMany`, `insertManyIgnore`, `update`, `hardDelete`. There is no raw query builder to escape through, and a caller-supplied `SQL` predicate is `AND`-ed onto the tenant predicate, so it can only narrow.
- `forOrg(orgId)` -> `OrgScopedDb`: the 8 entities that carry a real `org_id` column (`projects`, `orgPolicies`, `memberships`, `invitations`, `organizationDomains`, `ssoConnections`, `directories`, `scimTargets`) re-scoped to `tenant_id + org_id`. `applications` belongs to an org indirectly through `project_id` and is deliberately not in this list.
- The method is named `hardDelete` on purpose: soft delete is a column-level concern (`deleted_at`, see `docs/soft-delete.md`), so a physical delete has to be spelled out.

## Isolation principles

- Business entities are isolated by tenant (Organization); org-level entities are further scoped by org.
- Platform-level entities (`instances`, `platform_admins`) carry no `tenant_id` and are reached through the separate management path.
- Short-lived strongly-consistent state (WebAuthn challenges, OAuth state / nonce, PAR request_uri, device flow, session revocation sets, rate-limit counters, audit sequence, metering) lives in Durable Objects, not in relational tables.

## Per-tenant unique constraints

Every "unique within a tenant" constraint is a composite UNIQUE whose **first column is `tenant_id`**, so the same value in two tenants never collides (`docs/design/08-data-model.md` 9.5, implemented in `packages/db/src/schema/`):

| Table                 | Constraint                                       |
| --------------------- | ------------------------------------------------ |
| `user_emails`         | `UNIQUE (tenant_id, email)`                      |
| `user_phones`         | `UNIQUE (tenant_id, phone)`                      |
| `users`               | `UNIQUE (tenant_id, username)`                   |
| `users`               | `UNIQUE (tenant_id, external_id)`                |
| `user_identities`     | `UNIQUE (tenant_id, provider, provider_user_id)` |
| `passkey_credentials` | `UNIQUE (tenant_id, credential_id)`              |
| `organizations`       | `UNIQUE (tenant_id, slug)`                       |
| `roles`               | `UNIQUE (tenant_id, project_id, key)`            |
| `permissions`         | `UNIQUE (tenant_id, project_id, key)`            |

SQLite treats multiple NULLs in a UNIQUE index as distinct, so `username` and `external_id` stay nullable while the constraint still holds. Two constraints are deliberately global, not per-tenant: `organization_domains.domain` (a domain can be claimed by exactly one org) and `refresh_tokens.token_hash`.

## How isolation shows up in the product

- Instance Manager: read users / audit / usage across all orgs, suspend / resume / delete an org, seat and quota accounting. Served by `/v1/platform/*`, never by the business API.
- Org Admin: only their own org's users, members, roles and audit; configures SSO, MFA and branding. Org-scoped `/v1` routes accept either a `sk_live_` / `sk_test_` API key or a cookie session with membership role `owner` / `admin` / `org_manager` (`requireApiKeyOrOrgManager`).
- Audit events are keyed by `PRIMARY KEY (tenant_id, seq)`; `org_id` is an optional column for finer filtering, not the partition key.
- `organizations.allow_org_self_service` (default true): when false, an org console caller cannot change SSO / MFA / login policy and the platform has to step in (`apps/server/worker/v1/organizations.ts`).

## Cross-tenant test anchors

Existing suites: `apps/server/worker/v1/__tests__/isolation.test.ts` and `packages/db/src/__tests__/isolation.test.ts`. New tenant-scoped routes go into the first one.
