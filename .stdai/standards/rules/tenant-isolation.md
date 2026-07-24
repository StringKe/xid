---
type: rules
name: tenant-isolation
description: D1 has no RLS -- tenant isolation is enforced by the Drizzle scoped query layer injecting tenant_id/org_id, no ad-hoc SQL in request handlers, cross-tenant tests required (P0)
priority: high
applyTo:
  - 'packages/db/**/*.ts'
  - 'apps/server/worker/**/*.ts'
targets: [claude-code, codex]
---

# Tenant data isolation (P0 control point)

D1 has no row-level security, so isolation is **enforced entirely in the application layer**. This is the highest-priority security control in the product and every business entity needs cross-tenant tests. Design source: `docs/design/00-overview.md` 5.3, `docs/design/02-tenancy-rbac.md` section 6, `docs/design/08-data-model.md` (isolation principles and 9.5).

## Iron rules

- Request-scoped business code MUST go through the scoped query layer in `packages/db/src/tenant-db.ts`. `createTenantDb(d1, tenantContext)` returns a handle whose every accessor already has `WHERE tenant_id = ?` as the leading predicate; org-level entities add `org_id` on top.
- Never build a Drizzle query directly against a tenant table in a handler. `db.select().from(table)` without a tenant predicate is a defect, not a style issue.
- Raw `env.DB.prepare(...)` is allowed **only** where the scoped accessor cannot express the statement -- atomic conditional INSERT / compare-and-swap / UPSERT (refresh token rotation, consent merge) -- or where no per-request TenantContext exists (queue consumers, cron jobs, Durable Objects). Every such statement MUST bind `tenant_id` explicitly in its `WHERE` and `VALUES`. Adding raw SQL anywhere else needs a stated reason.
- Management endpoints run on **separate paths** and MUST NOT reuse business APIs. Instance-wide queries live under `/v1/platform/*` (`apps/server/worker/platform/`), gated by cookie session plus a `manager_assignments` row with `manager_role = 'instance_manager'` and `scope_type = 'instance'`.
- `tenant_id` comes from TenantContext, never from the request body. An `org_id` taken from a path parameter MUST be validated against the current tenant first (`requireOrg` in `apps/server/worker/v1/shared.ts`), which itself goes through the scoped handle.
- Any new "unique within a tenant" constraint MUST be a composite UNIQUE whose first column is `tenant_id`. A bare `UNIQUE (email)` is a cross-tenant leak and a collision bug.
- Short-lived strongly-consistent state (challenges, OAuth state / nonce, PAR, device flow, session revocation sets, rate-limit counters, audit sequence, metering) belongs in Durable Objects, not in relational tables.

## Cross-tenant tests

Every business entity's CRUD needs a cross-tenant test: act with org A's context against org B's resource and assert 403 or 404 without leaking whether the resource exists. No new tenant-scoped route ships without one.

Scoped query API surface, the org-scoped table list, the per-tenant UNIQUE constraint table, Instance-Manager-versus-Org-Admin behavior, and the cross-tenant test file anchors: reference `tenant-scoped-query-api`. Read it before adding a tenant table, an org-scoped route, or a new isolation test.
