# Backend SDK

`@xid-kit/backend` provides server-side and edge-runtime JWT verification, request authentication, and webhook signature validation. Uses Web Crypto via `@xid-kit/crypto`; never loads instance signing private keys.

## Install

```sh
pnpm add @xid-kit/backend
```

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
    })
    if (state.status !== 'signed-in') {
      return new Response('Unauthorized', { status: 401 })
    }
    const { userId } = state.toAuth()
    return new Response(`Hello user ${userId}`)
  },
}
```

## Exported API

### Authentication

| Export                | Kind     | Description                                                                                                        |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `authenticateRequest` | function | Extract bearer token or session cookie from a `Request`, verify signature and claims, return `RequestState`        |
| `verifyToken`         | function | Low-level access token verification: signature, exp, nbf, iss, aud, azp. Pass `jwtKey` to skip network round-trips |
| `verifyWebhook`       | function | Validate Svix-style webhook signatures with 5-minute replay window                                                 |

### JWKS

| Export           | Kind            | Description                                                                                                           |
| ---------------- | --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `toVerifyKeySet` | function        | Convert a `JwtKey` (JWK, JWKS, or imported `CryptoKey`) to a `VerifyKeySet` for verification                          |
| `JwksCache`      | class           | Optional network-fetching JWKS cache with configurable TTL (default 3600 s). Use only when `jwtKey` is not pre-loaded |
| `PACKAGE`        | string constant | Package name identifier `'@xid-kit/backend'`                                                                          |

### Errors

| Export                | Kind             | Description                                                                                      |
| --------------------- | ---------------- | ------------------------------------------------------------------------------------------------ |
| `AppError`            | class            | Thrown for unrecoverable SDK errors: missing JWT key, JWKS fetch failure, invalid options        |
| `BACKEND_ERROR_CODES` | `as const` tuple | All defined `BackendErrorCode` values: `missing_jwt_key`, `jwks_fetch_failed`, `invalid_options` |

### Types

| Export                       | Description                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `JwtKey`                     | Accepted public key forms: `PublicJwk`, `Jwks`, or `{ alg, publicKey: CryptoKey }`     |
| `JwksCacheOptions`           | Constructor options for `JwksCache`: jwksUri, ttlSec, fetchFn                          |
| `VerifyTokenOptions`         | Options for `verifyToken`: jwtKey, issuer, audience, clockSkewSec, signal              |
| `VerifyTokenError`           | Structured error returned when token verification fails (expected failure; not thrown) |
| `AuthenticateRequestOptions` | Options for `authenticateRequest`: jwtKey, issuer, audience, cookieName                |
| `RequestState`               | Discriminated union: `SignedInState` or `SignedOutState`                               |
| `SignedInState`              | State when a valid session token is found; includes `toAuth()` for claims access       |
| `SignedOutState`             | State when no valid token is present; reason field indicates cause                     |
| `VerifyWebhookOptions`       | Options for `verifyWebhook`: secret, tolerance (replay window seconds)                 |
| `WebhookVerifyError`         | Structured error when webhook signature is invalid or replayed                         |
| `VerifiedWebhook`            | Parsed and verified webhook payload                                                    |
| `BackendErrorCode`           | Union of `BACKEND_ERROR_CODES` values                                                  |

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

const event = await verifyWebhook(request, {
  secret: env.XID_WEBHOOK_SECRET,
})
// event.type, event.data are typed
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
- Verification uses Web Crypto via `@xid-kit/crypto`.
- Expected failures return `Result` types; unexpected errors throw `AppError`.
- Webhook validation binds body, timestamp, and signature with a 5-minute replay window.

Status: current package.
