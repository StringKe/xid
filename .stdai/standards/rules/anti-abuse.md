---
type: rules
name: anti-abuse
description: Three-layer abuse prevention (Cloudflare Rate Limiting / Turnstile / RateLimitStore Durable Object), fail-closed rate limiting, constant-time account enumeration protection
priority: normal
applyTo:
  - 'apps/server/worker/auth/**/*.ts'
  - 'apps/server/worker/me-auth/**/*.ts'
  - 'apps/server/worker/middleware/**/*.ts'
  - 'apps/server/worker/lib/rate-limit.ts'
  - 'apps/server/worker/lib/verify-rate-limit.ts'
  - 'apps/server/worker/durable-objects/rate-limit-store.ts'
targets: [claude-code, codex]
---

# Abuse Prevention, Rate Limiting, Enumeration Protection

Design source: `docs/design/01-authentication.md` section 7 and
`docs/design/07-platform-operations.md` section 6. Implementation lives in
`apps/server/worker/durable-objects/rate-limit-store.ts`, `lib/rate-limit.ts`,
`lib/verify-rate-limit.ts`, `me-auth/shared.ts`.

## Three layers

Cloudflare Rate Limiting / WAF (network edge, configured outside this repo) + Turnstile (forms) +
RateLimitStore Durable Object (business logic).

- Turnstile is mandatory whenever `env.TURNSTILE_SECRET` is set and MUST NOT be bypassed. Its
  siteverify call sits on the login critical path, so it stays short-timeout and its remote failure
  reason never reaches the response body.
- All business counters live in the RateLimitStore Durable Object, NOT in KV. Counting must be
  strongly consistent and serialized.
- Rate limiting fails closed. Durable Object unavailability MUST NOT be treated as "allowed".
- The DO `check` action is check-and-increment, not a read -- call it exactly once per attempt.

Threshold table, backoff tiers, the RateLimitStore check/reserve contract, the Turnstile
enforcement points, and the unbuilt anomaly-detection and device-trust designs: reference
`rate-limit-policies`. Read it before adding or tuning any limit.

## Account enumeration protection (MUST)

- Every auth endpoint returns the same opaque response whether the account is missing or the
  credential is wrong. Password sign-in returns `invalid_credentials` in both cases; locked and
  suspended accounts both return `account_locked`.
- Equalize work, not just the message. When no password row exists, `verifyUserPassword` still runs
  a full Argon2id hash against `DUMMY_ARGON2`, and `verifyPassword` burns a dummy hash on an unknown
  algo or an unparseable stored hash. A no-such-user path that skips the KDF is a timing oracle.
- All secret comparisons are constant-time (`timingSafeStrEqual` / `constantTimeEqualStr`). Never
  use `===` on a hash, code, token, or client secret.
- `/auth/forgot-password` returns 200 for unknown email, malformed JSON, and malformed email shape
  alike. Only `organizationId`, a non-credential field, may produce a 422.
- Rate limit rejections use the single opaque `rate_limited` error and MUST NOT reveal which
  dimension tripped.
- Social sign-in MUST NOT branch its response on whether `provider_user_id` already exists.
- WebAuthn Conditional UI MUST NOT error on an empty result.
- Validation failures on credential fields map to the opaque credential error, not
  `validation_failed`; only non-credential fields get a 422 with `meta.paramName` (see
  error-handling rule).

Two enumeration trade-offs are reviewed and accepted (`docs/design/01-authentication.md` section 7):
the instance login resolver necessarily reveals whether an email maps to one org or several, and a
magic link GET establishes a session directly. Do not "fix" either without a design change.
