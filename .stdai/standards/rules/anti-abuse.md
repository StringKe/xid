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

Design source `docs/design/01-authentication.md` 7, `07-platform-operations.md` 6. Thresholds,
backoff tiers, the RateLimitStore check/reserve contract, Turnstile enforcement points, unbuilt
anomaly-detection and device-trust designs: reference `rate-limit-policies` -- read before adding or
tuning any limit.

## Rate limiting (MUST)

- Layers: Cloudflare Rate Limiting / WAF (edge, outside this repo) + Turnstile (forms) +
  RateLimitStore Durable Object (business). Business counters live in the DO, never in KV.
- Turnstile is configured only as the pair `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET`. Both absent is
  the dev/test bypass; either value missing is a fail-closed configuration error. When configured,
  every protected flow MUST validate both `success=true` and the expected action. The remote failure
  reason never reaches the response body.
- Fails closed: DO unavailability MUST NOT be read as "allowed".
- The DO `check` action is check-and-increment, not a read -- call it exactly once per attempt.

## Enumeration protection (MUST)

- One opaque response whether the account is missing or the credential is wrong: sign-in returns
  `invalid_credentials` both ways, locked and suspended both return `account_locked`,
  `/auth/forgot-password` returns 200 for unknown email and malformed input alike, and rate limit
  rejections use one `rate_limited` code that never names the dimension.
- Equalize work, not just the message: a no-such-user path that skips the KDF is a timing oracle, so
  `verifyUserPassword` burns a full Argon2id hash against `DUMMY_ARGON2`.
- All secret comparisons are constant-time; never `===` a hash, code, token, or client secret.
- Social sign-in MUST NOT branch on `provider_user_id` existence, Conditional UI MUST NOT error on an
  empty result, and credential-field validation failures map to the opaque credential error.

Reviewed and accepted: the instance login resolver reveals whether an email maps to one org or
several, and a magic link GET establishes a session directly. Do not "fix" either without a design
change.
