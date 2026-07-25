---
type: rules
name: api-sdk-conventions
description: Management API conventions (/v1/ prefix, cursor pagination, sk_live_ keys, shared auth guards), structured XidAPIError, webhook events, SDK networkless verification
priority: normal
applyTo:
  - 'apps/server/worker/**/admin/**/*.ts'
  - 'apps/server/worker/**/v1/**/*.ts'
  - 'packages/core/**/*.ts'
  - 'packages/backend/**/*.ts'
  - 'packages/react/**/*.tsx'
targets: [claude-code, codex]
---

# Management API / SDK / Webhooks

Design source: `docs/design/06-developer-experience.md`.

## MUST

- Every Management API route lives under `/v1/` and registers through
  `apps/server/worker/v1/index.ts`; never mount one from `worker/index.ts`.
- Auth is a secret key bearer (`sk_live_` / `sk_test_`) checked by the shared guards. Never hand-roll
  an auth or scope check. Minting an API key MUST NOT escalate privilege -- the new key's scopes are
  a subset of the caller's.
- Pagination is cursor-based only, capped at 100 per page. Do not add offset pagination.
- Never reference a `/v1` resource that is not implemented; chapter 06 describes several that do not
  exist, so check the code first.
- Errors are thrown as `AppError` and shaped by Hono `onError`. Internal detail (stack, SQL, upstream
  reason) MUST NOT reach the client; messages render from the per-request i18n instance.
- SDKs hold no secrets; public clients verify with public keys only.
- Webhook delivery is queued and **never blocks the login path**. Emit only event names that exist,
  and add a new name to the code and chapter 06 together.

## References

- Implemented `/v1` resources, API key scope model and guards, pagination, the `XidAPIError` wire
  shape, SDK layering, dev key prefixes: reference `management-api-surface` -- read before adding a
  route, guard, or SDK helper.
- Event names, the svix signature scheme and replay window, retry and dead-letter behavior, the
  unimplemented replay / Events API: reference `webhook-event-contract`.
