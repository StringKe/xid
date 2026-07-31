# Backend SDK

`@xid-kit/backend` provides server-side and edge-runtime JWT verification, request authentication, and webhook signature validation. Uses Web Crypto via `@xid-kit/crypto`; never loads instance signing private keys.

## Install

Registry availability is currently `UNKNOWN`: the repository verifies installable local tarballs,
but no npm publication has been performed or authorized. From a source checkout, use the workspace
package directly or build and install the audited tarball:

```sh
pnpm --filter @xid-kit/backend build
pnpm --dir packages/backend pack --pack-destination /tmp/xid-sdk-packs
npm install /tmp/xid-sdk-packs/xid-kit-backend-0.1.0-alpha.0.tgz
```

After an independently verified npm release, the registry-backed command is
`pnpm add @xid-kit/backend`. See [SDK Distribution](./distribution.md).

## Runtime support

- Cloudflare Workers (primary target)
- Vercel Edge Runtime
- Node.js server runtime
- Any Web Crypto compatible runtime (Bun, Deno)

## Quickstart

```ts
import { authenticateRequest } from '@xid-kit/backend'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const state = await authenticateRequest(request, {
      jwtKey: env.XID_JWKS_PUBLIC_KEY,
      issuer: 'https://xid.dev',
      // Only when /v1/sessions/token on this exact origin is routed to XID Core:
      sessionTokenExchange: { endpoint: '/v1/sessions/token' },
    })
    if (!state.isSignedIn) {
      return new Response('Unauthorized', { status: 401 })
    }
    return new Response(`Hello user ${state.userId}`)
  },
}
```

`__Host-xid.rt.*` contains an opaque refresh token, not a JWT. The SDK never parses or verifies that
value. In a same-origin deployment, `sessionTokenExchange` forwards the complete Cookie header to
Core's trusted `POST /v1/sessions/token` route, then verifies the returned short-lived JWT. The
endpoint is rejected if it resolves to another origin.

For a separate application origin, send a short-lived JWT as
`Authorization: Bearer <token>`. Alternatively, place that JWT in an application-owned HttpOnly
cookie and explicitly set `jwtCookieName`. Do not copy or forward a Core refresh cookie across
origins.

## Exported API

### Authentication

| Export                 | Kind     | Description                                                                                                        |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `authenticateRequest`  | function | Verify Bearer or explicit app JWT credentials; optionally exchange a same-origin Core cookie for a JWT             |
| `exchangeSessionToken` | function | Forward Core opaque cookies to an exact same-origin session-token endpoint and return its short-lived JWT          |
| `verifyToken`          | function | Low-level access token verification: signature, exp, nbf, iss, aud, azp. Pass `jwtKey` to skip network round-trips |
| `verifyWebhook`        | function | Validate Svix-style webhook signatures with 5-minute replay window                                                 |

### JWKS

| Export           | Kind            | Description                                                                                                           |
| ---------------- | --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `toVerifyKeySet` | function        | Convert a `JwtKey` (JWK, JWKS, or imported `CryptoKey`) to a `VerifyKeySet` for verification                          |
| `JwksCache`      | class           | Optional network-fetching JWKS cache with configurable TTL (default 3600 s). Use only when `jwtKey` is not pre-loaded |
| `PACKAGE`        | string constant | Package name identifier `'@xid-kit/backend'`                                                                          |

### Errors

| Export                | Kind             | Description                                                                                                                       |
| --------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `AppError`            | class            | Thrown for unrecoverable SDK errors: missing JWT key, JWKS fetch failure, invalid options, session-token exchange failure         |
| `BACKEND_ERROR_CODES` | `as const` tuple | All defined `BackendErrorCode` values: `missing_jwt_key`, `jwks_fetch_failed`, `invalid_options`, `session_token_exchange_failed` |

### Types

| Export                        | Description                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `JwtKey`                      | Accepted public key forms: `PublicJwk`, `Jwks`, or `{ alg, publicKey: CryptoKey }`             |
| `JwksCacheOptions`            | Constructor options for `JwksCache`: jwksUri, ttlSec, fetchFn                                  |
| `VerifyTokenOptions`          | Options for `verifyToken`: jwtKey, issuer, audience, authorizedParties, clockToleranceSec, now |
| `VerifyTokenError`            | Structured error returned when token verification fails (expected failure; not thrown)         |
| `AuthenticateRequestOptions`  | Verification options plus jwtCookieName and sessionTokenExchange                               |
| `SessionTokenExchangeOptions` | Same-origin endpoint, server fetcher, and abort signal for Core cookie-to-JWT exchange         |
| `RequestState`                | Discriminated union: `SignedInState` or `SignedOutState`                                       |
| `SignedInState`               | Valid signed JWT state with `userId`, optional `sessionId`, and verified `claims`              |
| `SignedOutState`              | State when no valid token is present; reason field indicates cause                             |
| `VerifyWebhookOptions`        | Options for `verifyWebhook`: secret and toleranceSec (replay window seconds)                   |
| `WebhookVerifyError`          | Structured error for missing headers, invalid signatures, replay, or invalid payloads          |
| `VerifiedWebhook`             | Verified message metadata and a typed `{ type, data }` payload envelope                        |
| `BackendErrorCode`            | Union of `BACKEND_ERROR_CODES` values                                                          |

## verifyToken

Pass `jwtKey` from JWKS to avoid network calls on cold start:

```ts
import { verifyToken } from '@xid-kit/backend'

const result = await verifyToken(token, {
  jwtKey: env.XID_JWKS_PUBLIC_KEY,
  issuer: 'https://xid.dev',
  audience: 'my-api',
})

if (!result.ok) {
  // result.error is VerifyTokenError (expected failure, not thrown)
  return new Response('Unauthorized', { status: 401 })
}
const { sub, org_id } = result.value
```

## verifyWebhook

```ts
import { verifyWebhook } from '@xid-kit/backend'

const result = await verifyWebhook(request, {
  secret: env.XID_WEBHOOK_SECRET,
})
if (!result.ok) {
  return new Response('Invalid webhook', { status: 400 })
}
const { type, data } = result.value.payload
```

## JwksCache

Use `JwksCache` only when you cannot pre-load the JWKS public key. The networkless default (passing `jwtKey` directly) is preferred for cold-start performance:

```ts
import { JwksCache, toVerifyKeySet } from '@xid-kit/backend'

const cache = new JwksCache({
  jwksUri: 'https://xid.dev/jwks',
  ttlSec: 3600,
})

const keySet = await cache.getKeys()
```

## Error handling

Expected failures (invalid token, bad signature) are returned as `Result` types rather than thrown. `AppError` is thrown only for SDK misuse or external dependency failures.

```ts
import { AppError, BACKEND_ERROR_CODES } from '@xid-kit/backend'

try {
  const state = await authenticateRequest(request, options)
} catch (err) {
  if (err instanceof AppError) {
    // err.code is one of BACKEND_ERROR_CODES
    console.error('SDK error', err.code, err.message)
  }
}
```

## Security boundaries

- Uses public JWKS only. Never loads instance signing private keys.
- Never treats Core `__Host-xid.rt.*` opaque refresh cookies as JWTs.
- Same-origin exchange is enforced before any incoming Cookie header is forwarded.
- Verification uses Web Crypto via `@xid-kit/crypto`.
- Expected failures return `Result` types; unexpected errors throw `AppError`.
- Webhook validation binds body, timestamp, and signature with a 5-minute replay window.

Status: current workspace package with locally verified release artifacts. npm registry
availability remains `UNKNOWN`.
