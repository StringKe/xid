---
type: rules
name: tenant-isolation
description: D1 has no RLS - isolation is enforced by the Drizzle scoped query layer injecting tenant_id/org_id, no ad-hoc SQL in handlers, cross-tenant tests required (P0)
priority: high
applyTo:
  - 'packages/db/**/*.ts'
  - 'apps/server/worker/**/*.ts'
targets: [claude-code, codex]
---

# Tenant data isolation (P0 control point)

D1 has no row-level security, so isolation is **enforced entirely in the application layer**. Design
source `docs/design/00-overview.md` 5.3, `02-tenancy-rbac.md` 6, `08-data-model.md`.

## Iron rules

- Request-scoped business code MUST go through `createTenantDb(d1, tenantContext)` in
  `packages/db/src/tenant-db.ts`; every accessor leads with `WHERE tenant_id = ?`, org-level entities
  add `org_id`. `db.select().from(table)` without a tenant predicate in a handler is a defect.
- Raw `env.DB.prepare(...)` is allowed **only** where the scoped accessor cannot express the
  statement (atomic conditional INSERT / compare-and-swap / UPSERT) or where no per-request
  TenantContext exists (queue consumers, cron, Durable Objects). Every such statement MUST bind
  `tenant_id` explicitly in its `WHERE` and `VALUES`; anywhere else needs a stated reason.
- Management endpoints run on **separate paths** and MUST NOT reuse business APIs. Instance-wide
  queries live under `/v1/platform/*`, gated by cookie session plus a `manager_assignments` row with
  `manager_role = 'instance_manager'`, `scope_type = 'instance'`.
- `tenant_id` comes from TenantContext, never the request body. An `org_id` from a path parameter
  MUST be validated against the current tenant first (`requireOrg` in `worker/v1/shared.ts`).
- Any new "unique within a tenant" constraint MUST be a composite UNIQUE whose first column is
  `tenant_id`; a bare `UNIQUE (email)` is a cross-tenant leak.
- Short-lived strongly-consistent state belongs in Durable Objects, not relational tables (see
  cloudflare-bindings rule).
- Every business entity's CRUD needs a cross-tenant test: act with org A's context against org B's
  resource, assert 403 or 404 without leaking existence. No tenant-scoped route ships without one.

Scoped query API surface, org-scoped table list, per-tenant UNIQUE constraints, Instance-Manager
versus Org-Admin behavior, cross-tenant test anchors: reference `tenant-scoped-query-api`.
