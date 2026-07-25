# Web/Core SDK

`@xid-kit/core` is the browser client SDK: session state load and cache, multi-session switching, active organization switching, short-lived JWT access, and Management API helpers. It does not hold any client secret and does not expose refresh token material to browser scripts.

## Install

```sh
pnpm add @xid-kit/core
```

## Quickstart

```ts
import { XidClient } from '@xid-kit/core'

const xid = new XidClient({
  apiUrl: 'https://xid.dev',
})

// Load session state from /v1/me
await xid.load()

// Get a short-lived JWT for API calls
const token = await xid.getToken()

// Switch active organization
await xid.setActiveOrganization('org_abc123')

// Sign out
await xid.signOut()
```

## Exported API

### Top-level client and store

| Export         | Kind  | Description                                                                                                        |
| -------------- | ----- | ------------------------------------------------------------------------------------------------------------------ |
| `XidClient`    | class | Top-level browser client: load, signIn, getToken, setActiveOrganization, signOut, and Management API helpers       |
| `XidStore`     | class | Framework-agnostic reactive store; framework bindings (e.g. `@xid-kit/react`) subscribe via `useSyncExternalStore` |
| `TokenManager` | class | Short-lived JWT cache and scheduled refresh (advanced use and testing)                                             |
| `XidApiClient` | class | HTTP client for `/v1/me` and token endpoints                                                                       |

### Errors

| Export            | Kind     | Description                                                                                  |
| ----------------- | -------- | -------------------------------------------------------------------------------------------- |
| `XidNetworkError` | class    | Thrown on transport failures: network error, non-JSON response, 5xx with no structured body  |
| `makeXidError`    | function | Construct a structured `XidError` for local validation failures without a network round-trip |
| `isXidErrorShape` | function | Type guard: checks whether an unknown value conforms to `XidError` shape from the wire       |

### JWT decode

| Export              | Kind     | Description                                                                           |
| ------------------- | -------- | ------------------------------------------------------------------------------------- |
| `decodeTokenClaims` | function | Decode JWT payload claims for scheduling purposes only; does not verify the signature |
| `isTokenExpiring`   | function | Returns `true` when the token will expire within the leeway window (default 10 s)     |

### Constants

| Export           | Kind             | Description                                                                                |
| ---------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| `SESSION_STATUS` | `as const` tuple | Valid session status values: `active`, `pending`, `expired`, `removed`, `ended`, `revoked` |
| `CLIENT_STATUS`  | `as const` tuple | Valid SDK client status values: `loading`, `ready`, `degraded`, `error`                    |
| `PACKAGE`        | string constant  | Package name identifier `'@xid-kit/core'`                                                  |

### Types

| Export                      | Description                                                          |
| --------------------------- | -------------------------------------------------------------------- |
| `XidUser`                   | Read-only view of the authenticated user (no secrets or hashes)      |
| `XidOrganization`           | Public organization view                                             |
| `XidOrganizationMembership` | User membership in an org with role and permissions                  |
| `XidSession`                | Session view including status, expiry, and active org                |
| `XidApiKey`                 | API key without secret (list view)                                   |
| `XidApiKeyWithSecret`       | API key returned once at creation, includes `key` field              |
| `XidPage<T>`                | Cursor-paginated response envelope                                   |
| `CreateApiKeyInput`         | Input type for `createApiKey`                                        |
| `SignInPasswordInput`       | Input type for `signInPassword`                                      |
| `SignInResult`              | Result from `signInPassword`: next step or redirect URL              |
| `SessionStatus`             | Union of `SESSION_STATUS` values                                     |
| `ClientStatus`              | Union of `CLIENT_STATUS` values                                      |
| `XidState`                  | Full SDK state snapshot subscribed from `XidStore`                   |
| `XidStateListener`          | State change listener callback type                                  |
| `Unsubscribe`               | Return type of `XidStore.subscribe`                                  |
| `GetTokenOptions`           | Options for `getToken`: template, skipCache, leewaySeconds, signal   |
| `XidClientOptions`          | Constructor options for `XidClient`: apiUrl, secretKey, fetcher, now |
| `ListUsersInput`            | Input type for `listUsers`                                           |
| `ListSessionsInput`         | Input type for `listSessions`                                        |
| `ManagementUser`            | Management API user resource shape                                   |
| `ManagementSession`         | Management API session resource shape                                |
| `TokenResponse`             | Raw token endpoint response shape                                    |
| `ClientStateResponse`       | Raw `/v1/me` response shape                                          |
| `DecodedTokenClaims`        | JWT payload claims returned by `decodeTokenClaims`                   |

## Management API helpers

`XidClient` wraps common Management API reads and API key lifecycle. Pass `secretKey: 'sk_live_xxx'` in the constructor (server-side only) to send `Authorization: Bearer sk_*`; browser session mode uses the HttpOnly cookie instead.

```ts
const xid = new XidClient({
  apiUrl: 'https://xid.dev',
  secretKey: process.env.XID_SECRET_KEY,
})

const keys = await xid.listApiKeys()
const created = await xid.createApiKey({ name: 'CI deploy', scopes: ['read'] })
await xid.revokeApiKey(created.id)

const users = await xid.listUsers({ limit: 50 })
const user = await xid.getUser({ userId: 'user_abc' })
const orgs = await xid.listOrganizations()
const sessions = await xid.listSessions({ userId: 'user_abc' })
```

Other resources (`/v1/members`, `/v1/invitations`, etc.) still require direct REST calls or framework server helpers.

## Error handling

`XidNetworkError` is thrown for transport-level failures. Structured API errors from the server conform to `XidError` (check with `isXidErrorShape`). Expected failures such as sign-in validation errors are returned as `SignInResult` rather than thrown.

```ts
import { XidNetworkError, isXidErrorShape } from '@xid-kit/core'

try {
  await xid.load()
} catch (err) {
  if (err instanceof XidNetworkError) {
    console.error('Transport error', err.status, err.message)
  }
}
```

## Security boundaries

- Session cookie is set `HttpOnly` by the Worker; the SDK never reads it directly.
- SDK caches only the short-lived access token and public state.
- Refresh token material is never exposed to browser scripts.
- No private keys or signing material of any kind.

Status: current package.
