---
type: rules
name: tenant-context
description: TenantContext is the single source of issuer / signing keys / RPID / policy; the default issuer is always the instance issuer
priority: high
applyTo:
  - 'apps/server/worker/**/*.ts'
  - 'packages/protocol/**/*.ts'
  - 'packages/crypto/**/*.ts'
  - 'packages/db/**/*.ts'
targets: [claude-code, codex]
---

# TenantContext: the single multi-tenant context

One codebase runs single-tenant and multi-tenant deployments; the only difference is how
TenantContext resolves. Type `packages/types/src/tenant.ts`, resolvers `packages/db/src/tenant-context.ts`.

## Iron rules

- issuer, signing keys, RPID and tenant policy MUST come from TenantContext. A module-level constant
  holding a tenant-sensitive value (`const ISSUER = ...`) is a violation.
- Every OIDC / OAuth / WebAuthn / session entry point MUST obtain TenantContext first. In the Worker
  that is `c.get('tenant')`, populated by `apps/server/worker/middleware/tenant.ts`.
- `issuer` is always the instance issuer (`https://{instances.primary_domain}`). An org or tenant
  subdomain MUST NOT become the OIDC issuer, and the root entry MUST NOT be hardcoded to a fixed org
  (`admin`, `app`, `default`) -- it always goes through the instance login resolver.
- In multi-tenant mode `rpId` MUST be the concrete tenant subdomain, never the parent domain.
- The resolution mode comes from `instances.mode` in D1, not build flags. Never fork behavior with
  code removal or feature flags.
- Never hand-roll a tenant lookup in a handler; use the `@xid-kit/db` resolvers. Resolution failure
  is expected, not exceptional -- resolvers return `Result`, and the middleware collapses
  `tenant_not_found` / `tenant_suspended` into an opaque 404 so existence never leaks.

Full field list, both resolution modes, every resolver entry point, domain-to-RPID mapping, the
unbuilt custom hostname state machine: reference `tenant-context-shape` -- read before adding a
field, choosing a resolver, or touching domain / RPID behavior.
