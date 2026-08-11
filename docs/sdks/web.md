# Web/Core SDK

`@xid-kit/core` is the browser client SDK: session state load and cache, multi-session switching, active organization switching, short-lived JWT access, and Management API helpers. It does not hold any client secret and does not expose refresh token material to browser scripts.

## Install

Registry status is `UNPUBLISHED`: local release artifacts are verified, but no npm publication has
been performed or authorized. The registry command below is post-publication only and becomes valid
after an independently verified authorized release. Until then, install from a source checkout or
audited tarball as described in [SDK Distribution](./distribution.md).

```sh
# Post-publication only
pnpm add @xid-kit/core
```

## Quickstart

An application on a different origin uses the OIDC browser mode. Register a public OAuth client and
pass the returned `client_id`; XID has no separate publishable-key credential.

```ts
import { XidClient } from '@xid-kit/core'

const xid = new XidClient({
  mode: 'oidc',
  issuer: 'https://xid.dev',
  clientId: 'client_abc123',
  redirectUri: `${window.location.origin}/auth/callback`,
})

// Restore a cached OIDC session, if one exists.
await xid.load()

const authorization = await xid.createAuthorizationUrl({ returnUrl: '/dashboard' })
if (!authorization.ok) throw authorization.error
window.location.assign(authorization.value)
```

On the registered callback route:

```ts
const callback = await xid.handleRedirectCallback(window.location.href)
if (!callback.ok) throw callback.error

const token = await xid.getToken()
if (!token.ok) throw token.error
await fetch('/api/profile', {
  headers: { Authorization: `Bearer ${token.value}` },
})
```

When the access session expires, `signInSilent()` reauthorizes without UI: a best-effort
hidden-iframe `prompt=none` attempt first, then `signInSilentWithRedirect()` as the reliable
top-level redirect fallback. A failure whose `error.code` is `login_required`,
`consent_required`, or `interaction_required` means interactive sign-in is required.

`mode: 'same-origin'` is reserved for XID-owned UI or an application that reverse-routes Core
authentication endpoints onto its exact origin. In that mode the browser uses the HttpOnly opaque
Core cookie and can switch sessions and active organizations:

```ts
const xid = new XidClient({ mode: 'same-origin' })
await xid.load()
await xid.setActiveOrganization({ organizationId: 'org_abc123' })
```

## Exported API

### Top-level client and store

| Export             | Kind  | Description                                                                                                        |
| ------------------ | ----- | ------------------------------------------------------------------------------------------------------------------ |
| `XidClient`        | class | Top-level browser client: load, signIn, getToken, setActiveOrganization, signOut, and Management API helpers       |
| `XidStore`         | class | Framework-agnostic reactive store; framework bindings (e.g. `@xid-kit/react`) subscribe via `useSyncExternalStore` |
| `TokenManager`     | class | Short-lived JWT cache and scheduled refresh (advanced use and testing)                                             |
| `XidApiClient`     | class | HTTP client for `/v1/me` and token endpoints                                                                       |
| `BrowserOidcError` | class | Typed browser OIDC discovery, callback, and token-exchange error                                                   |

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

### Passkey ceremony (WebAuthn)

| Export                           | Kind     | Description                                                                                                                                             |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createPasskeyCredential`        | function | Runs `navigator.credentials.create` and serializes the attestation for `/auth/passkey/register/verify`; cancellation maps to an expected-failure Result |
| `registrationOptionsToPublicKey` | function | Converts server registration options (base64url fields) into `PublicKeyCredentialCreationOptions`                                                       |
| `b64urlToBytes`                  | function | Decodes a base64url string to bytes                                                                                                                     |
| `bytesToB64url`                  | function | Encodes bytes as base64url                                                                                                                              |
| `PasskeyRegistrationOptions`     | type     | `/auth/passkey/register/options` response shape                                                                                                         |
| `PasskeyRegistrationVerifyBody`  | type     | `/auth/passkey/register/verify` request body                                                                                                            |

### Constants

| Export                        | Kind             | Description                                                                                    |
| ----------------------------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| `SESSION_STATUS`              | `as const` tuple | Valid session status values: `active`, `pending`, `expired`, `removed`, `ended`, `revoked`     |
| `CLIENT_STATUS`               | `as const` tuple | Valid SDK client status values: `loading`, `ready`, `degraded`, `error`                        |
| `SILENT_AUTHORIZATION_ERRORS` | `as const` tuple | `prompt=none` interaction errors: `login_required`, `consent_required`, `interaction_required` |
| `PACKAGE`                     | string constant  | Package name identifier `'@xid-kit/core'`                                                      |

### Types

| Export                         | Description                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `XidUser`                      | Read-only view of the authenticated user (no secrets or hashes)                      |
| `XidOrganization`              | Public organization view                                                             |
| `XidOrganizationMembership`    | User membership in an org; `role` is `owner`, `admin`, or `member`                   |
| `XidSession`                   | Session view including status, expiry, and active org                                |
| `XidApiKey`                    | API key without secret (list view)                                                   |
| `XidApiKeyWithSecret`          | API key returned once at creation, includes `key` field                              |
| `XidPage<T>`                   | Cursor-paginated response envelope                                                   |
| `CreateApiKeyInput`            | Input type for `createApiKey`                                                        |
| `SignInPasswordInput`          | Input type for `signInPassword`                                                      |
| `SignInResult`                 | Result from `signInPassword`: next step or redirect URL                              |
| `SessionStatus`                | Union of `SESSION_STATUS` values                                                     |
| `ClientStatus`                 | Union of `CLIENT_STATUS` values                                                      |
| `XidState`                     | Full SDK state snapshot subscribed from `XidStore`                                   |
| `XidStateListener`             | State change listener callback type                                                  |
| `Unsubscribe`                  | Return type of `XidStore.subscribe`                                                  |
| `GetTokenOptions`              | Options for `getToken`: skipCache, leewaySeconds, signal                             |
| `XidClientOptions`             | Union of explicit `same-origin` and `oidc` browser options                           |
| `SameOriginXidClientOptions`   | Exact-origin cookie mode options                                                     |
| `OidcXidClientOptions`         | Cross-origin OIDC options: issuer, clientId, redirectUri, scopes                     |
| `CreateAuthorizationUrlInput`  | OIDC authorize redirect options                                                      |
| `HandleRedirectCallbackResult` | Validated OIDC callback result                                                       |
| `ListUsersInput`               | Input type for `listUsers`                                                           |
| `ListSessionsInput`            | Input type for `listSessions`                                                        |
| `ManagementUser`               | Management API user resource shape                                                   |
| `ManagementSession`            | Management API session resource shape                                                |
| `TokenResponse`                | Raw token endpoint response shape                                                    |
| `ClientStateResponse`          | Raw `/v1/me` response shape                                                          |
| `DecodedTokenClaims`           | JWT payload claims returned by `decodeTokenClaims`                                   |
| `UpgradeGuestWithPasskeyInput` | Input type for `upgradeGuestWithPasskey`: optional `deviceName`, `signal`            |
| `SignInSilentInput`            | Input type for `signInSilent`: optional `timeoutMs` (default 10 s), `signal`         |
| `SilentAuthorizationError`     | Union of `SILENT_AUTHORIZATION_ERRORS` values                                        |
| `SilentRedirectCallbackResult` | Internal silent-callback variant mapped by `XidClient` to an expected-failure Result |

Organization membership roles use the fixed `OrganizationMembershipRole` contract. Tenant-defined
Project roles such as `viewer` or `billing_admin` are separate business-role records and are never
accepted by Organization membership guards.

## Management API helpers

`XidClient` wraps common Management API reads and API key lifecycle. Pass `secretKey: 'sk_live_xxx'` in the constructor (server-side only) to send `Authorization: Bearer sk_*`; browser session mode uses the HttpOnly cookie instead.

```ts
const xid = new XidClient({
  apiUrl: 'https://xid.dev',
  secretKey: process.env.XID_SECRET_KEY,
})

const keys = await xid.listApiKeys()
const created = await xid.createApiKey({ name: 'CI deploy', scopes: ['read'] })
if (!created.ok) throw created.error
const revoked = await xid.revokeApiKey({ id: created.value.id })
if (!revoked.ok) throw revoked.error

const users = await xid.listUsers({ limit: 50 })
const user = await xid.getUser({ userId: 'user_abc' })
const orgs = await xid.listOrganizations()
const sessions = await xid.listSessions({ userId: 'user_abc' })
```

Other Organization-scoped resources, including
`/v1/organizations/:orgId/memberships` and
`/v1/organizations/:orgId/invitations`, still require direct REST calls or framework server
helpers.

## Error handling

`XidNetworkError` is thrown for transport-level failures. Structured API errors from the server
conform to `XidError` (check with `isXidErrorShape`). Expected failures return
`Result<T, XidError>`; check `result.ok` before reading `result.value`.

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
