---
type: references
name: management-api-surface
description: Which /v1 resources exist today and which chapter-06 resources do not, the API key scope model and auth guards, cursor pagination mechanics, the XidAPIError wire shape, the SDK package layering, and the local development key prefixes
---

# Management API Surface, SDK Layering, and Error Shape

This is the detailed inventory of the XID Management API and SDK surface, moved out of the
`api-sdk-conventions` rule so the always-loaded rules stay small. Read it before adding or changing a
`/v1` route, before minting or validating an API key scope, when you need the exact pagination or
error wire shape, when picking which `@xid-kit/*` package a helper belongs in, or when you are about
to reference a resource and need to confirm it actually exists. Design source:
`docs/design/06-developer-experience.md`.

## Management API (REST)

- Versioning: `/v1/` URL prefix.
- Authentication: secret key via `Authorization: Bearer sk_live_xxx` or `sk_test_xxx`. `requireApiKey`
  in `apps/server/worker/v1/shared.ts` is the single guard -- it hashes the bearer with `sha256Hex`,
  matches `api_keys.key_hash`, and rejects revoked or expired keys. M2M clients use the
  `client_credentials` grant at `POST /token` (the OIDC token endpoint is mounted at the root, not at
  `/oauth/token`).
- API key scopes: `resource:action` where action is `read` / `write` / `*`, plus the bare `*` wildcard.
  The resource whitelist is `API_KEY_SCOPE_RESOURCES` in `v1/shared.ts` -- add new resources there or
  the minted key silently matches nothing. Minting MUST NOT escalate: a new key's scopes must be a
  subset of the caller's (`apiKeyScopesCover`).
- Pagination: cursor only, via `parsePagination` / `paginate`. Cursors are base64url-encoded row ids;
  responses are `{ data, next_cursor, has_more }`. `MAX_PAGE_SIZE` is 100 and also the default. There
  is no offset pagination -- do not add one.
- Rate limits: bulk invitations 50/hour/tenant, enforced atomically through the `RATE_LIMITER` Durable
  Object (`checkInvitationRateLimit`). The design target of 10/10s/user on metadata PATCH is NOT
  enforced yet; `POST /v1/users/bulk_metadata` currently has no limiter.
- Dual auth for org-scoped resources: `requireApiKeyOrOrgManager` accepts either an `sk_*` bearer or a
  cookie session belonging to an org `owner` / `admin` / platform `org_manager`. Flat tenant-level
  resources use `requireApiKeyOrTopLevelOrgManager`. Never hand-roll either check.
- Project-scoped dual auth lives in `v1/project-access.ts`. API keys keep their resource scopes.
  Cookie sessions are narrowed to the exact `project_manager` Project or
  `project_grant_manager` ProjectGrant; the recipient Organization owner/admin can manage
  UserGrants for its own active members. Neither Project manager role becomes Organization Admin.

### Implemented resources

`/v1/users`, `/v1/organizations` (plus nested members, roles, domains, branding, auth-policy,
delivery-channels, social-providers, sso-connections, directories, outbound-saml-apps, scim-targets,
custom-hostnames, audit-events), `/v1/organizations/:orgId/memberships`,
`/v1/organizations/:orgId/invitations`,
`/v1/sessions`, `/v1/applications`, `/v1/connections` (SSO), `/v1/directories` (SCIM), `/v1/projects`,
`/v1/roles`, `/v1/permissions`, `/v1/role-permissions`, `/v1/manager-assignments`, `/v1/webhooks`,
`/v1/api-keys`, `/v1/project-grants`, `/v1/user-grants`.

Projects provide tenant-scoped CRUD plus soft delete and restore. Role-permission mappings provide
list/create/read/update/delete for active Role and Permission records in the same active Project.
Manager assignments provide tenant-scoped list/provision/revoke for the fixed
`org_manager`/`org`, `project_manager`/`project`, and `project_grant_manager`/`grant` pairs.
`instance_manager` remains exclusively under `/v1/platform/*` and is deliberately invisible to the
tenant-scoped manager-assignment routes.

Registration is centralized in `apps/server/worker/v1/index.ts`; each module exports its own
`register*` function. Do not mount routes directly from `worker/index.ts`.

Custom hostnames use `custom_hostnames:read` / `custom_hostnames:write`. Create reserves the concrete
hostname globally before calling Cloudflare for SaaS. Refresh requires the exact provider id and
hostname to match. Delete is remote-first and retains a local tombstone. Local evidence exists, but
real provider, DNS, certificate and traffic evidence remains `UNKNOWN`.

Adjacent but separate route families, do not conflate them with the Management API:
`/v1/me/*` is the self-service account portal (cookie session, not `sk_*`), and `/v1/platform/*` is the
instance-manager Console API (cookie session + `requireInstanceManager`). The platform family owns
organization plans and quotas, optional Stripe Checkout / Portal configuration, user impersonation,
announcements, status incidents, compliance evidence, audit views and Queue dead-letter operations.
`GET /v1/platform/audit/verify` synchronously recomputes a bounded audit chain range in D1 batches;
the Console exposes the diagnostic. A Queue/KV verification job is not implemented.
`/v1/platform/dead-letters` exposes only redacted metadata;
`POST /v1/platform/dead-letters/:id/replay` decrypts inside Core and routes only to the recorded
source Queue. Neither ciphertext nor plaintext payload is returned to Console.

The signed Stripe callback is the public `/v1/billing/stripe/webhook` route and is registered before
tenant middleware. It is not a Management API or Console mutation. Repository evidence covers
signature validation, idempotency, ordering and crash-safe MAU retries; real Stripe provider L4
remains `UNKNOWN`.

Resources described in chapter 06 but NOT implemented: `emailAddresses`, `phoneNumbers`,
`allowlistIdentifiers`, `oauthApplications`, `redirectUrls`, and invoice/payment-method/subscription
CRUD. Do not reference them as if they exist. Platform accounting plans and quotas are implemented,
but they are not a licensing gate and they do not imply the missing financial-record CRUD.

## SDK Layering

```
@xid-kit/core       Browser core (session state / token / user + org info / API calls), vanilla JS
@xid-kit/backend    Server core (Web-standard runtimes: Workers / Node / Bun / Deno), networkless JWT verification
@xid-kit/react      React provider / hooks / components (primary target)
@xid-kit/nextjs     Next.js middleware and server helpers
Web frameworks      @xid-kit/{vue,nuxt,svelte,angular,remix,astro,solid}
Mobile              @xid-kit/react-native, @xid-kit/expo
Desktop             @xid-kit/electron, @xid-kit/tauri
Native server SDKs  sdk/{go,java,rust,php,ruby,python,dotnet}
Native client SDKs  sdk/{flutter,ios,android,macos,windows,linux}
```

Per-platform status is tracked in `docs/sdks/platform-matrix.md` -- keep that file and chapter 06 in
sync when a package changes state.

- `XidClient` / `TokenManager` expose `getToken()`, which fetches a short-lived JWT (~60s, refreshed
  ahead of expiry, concurrent calls deduplicated) from `POST /v1/sessions/token`. Paired with `jwtKey`
  (a JWKS public key) this gives networkless verification -- critical at the edge, no API round trip,
  cold-start friendly.
- Backend verification (`packages/backend/src`): `authenticateRequest(request, options)` reads the
  Authorization header or cookie and validates signature / exp / azp; `verifyToken(token, options)` is
  the low-level form that skips the network when `jwtKey` is supplied; `verifyWebhook(request, options)`
  validates the HMAC signature. `JwksCache` / `toVerifyKeySet` exist only for the explicit
  fetch-from-origin path.
- SDKs hold no secrets. Public clients verify with public keys only (see crypto-boundary rule).

## Structured Errors

The wire shape produced by the Hono `onError` handler
(`apps/server/worker/middleware/error.ts`) is `{ code, message, longMessage?, meta? }`, where `meta` is
`XidErrorMeta` (`{ paramName?: string }`) for exact form-field mapping. `code` is a `XidErrorCode` from
`packages/types/src/errors.ts`.

- Throw `AppError(code, { httpStatus?, meta?, longMessage?, cause? })` from `worker/lib/errors.ts`.
  HTTP status defaults from the code via `httpStatusForCode`.
- `message` is rendered per request from the i18n instance on the context (`c.get('i18n')._(...)`),
  never from an isolate-global locale. See the i18n-lingui rule.
- `cause` is server-log only. Internal details -- stack traces, SQL, upstream reasons -- MUST NOT reach
  the client. Unknown throwables collapse to `server_error` / 500.
- Error responses carry `Cache-Control: no-store`.
- SCIM endpoints are the documented exception: they return RFC7644 `scimError` shapes, not
  `XidAPIError`, because SCIM clients parse the Error URN.

## Local Development

Publishable keys use the `pk_test_` / `pk_live_` prefixes, secret keys `sk_test_` / `sk_live_`. The
worker accepts both secret prefixes identically -- environment separation comes from the deployment,
not from the prefix.

Turnstile verification is skipped only when both `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET` are
unset, which is how local dev bypasses bot checks. A partial pair fails closed; a complete pair
enforces Siteverify with a 5s timeout and action validation. The `/test-harness/*` routes
(fake IdP, fake social provider, fake LDAP, fake SWA, fake WS-Fed, OTP capture) exist for development
and test only and MUST NOT be reachable in production.
