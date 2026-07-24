---
type: rules
name: utils-abstraction
description: Helpers and abstraction -- rule of three before extracting, pure functions with no side effects, topic-named modules instead of a utils dumping ground, D1 access only through the tenant query layer
priority: normal
applyTo:
  - '**/*.ts'
  - '**/*.tsx'
targets: [claude-code, codex]
---

# Helpers and Abstraction

## When to Extract (Follows the Global Rule)

- Simplest thing first. One use is not an abstraction. Extract a helper on the **third** similar occurrence.
- Never write an abstraction, feature flag, or backward-compatibility shim for a scenario that does not exist.
- Premature abstraction is worse than duplication: duplication is visible, a wrong abstraction has to be unwound.

## Helper Function Principles

- **Pure functions first**: no side effects, deterministic, no I/O, no globals, no clock, no randomness. Inject those as parameters when needed.
- Pure functions are easy to test, compose and cache. Keep side-effecting logic (I/O, network) separate from pure logic.
- Single responsibility: one helper does one thing. **Never create a catch-all `utils.ts`.** There is currently no `utils.ts` anywhere in `apps/` or `packages/` -- keep it that way.

## Hard Bans (placement detail in reference)

- **D1 is never touched directly.** All relational access goes through `createTenantDb` from
  `@xid-kit/db`. Raw SQL and unfiltered `db.select().from(...)` are forbidden (see tenant-isolation rule).
- Never inline a magic TTL number at a call site; TTLs and limits are centralized.
- Never reimplement signing, hashing, WebAuthn, or SAML in application code -- those live in
  `@xid-kit/crypto`, `@xid-kit/protocol`, `@xid-kit/webauthn`, `@xid-kit/saml`.

Where each kind of helper belongs (flat topic modules inside a package, `apps/server/worker/lib/`
for worker-wide helpers, `@xid-kit/types` for cross-package contracts), and the Queue / KV / R2 /
TTL access patterns with their concrete file paths, live in reference `helper-placement-guide`.
Read it before creating a new module or directory and before touching any Cloudflare binding.
