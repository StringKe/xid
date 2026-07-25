# @xid-kit/tauri

XID identity SDK for [Tauri](https://tauri.app/) v2 desktop apps.

Provides:

- JS bridge (WebView side): PKCE S256 authorization URL, deeplink callback handler, token exchange, refresh rotation, session storage via OS keychain
- Rust plugin template (src-tauri side): `plugin:xid-keychain` backed by OS-native secret store

## Installation

```
pnpm add @xid-kit/tauri
```

Tauri plugins used at runtime (install separately in your app):

```
pnpm add @tauri-apps/api @tauri-apps/plugin-deep-link @tauri-apps/plugin-shell
```

## Quick start

### 1. Configure Tauri (tauri.conf.json)

```json
{
  "bundle": {
    "identifier": "com.example.myapp"
  },
  "plugins": {
    "deep-link": {
      "desktop": { "schemes": ["myapp"] }
    }
  }
}
```

### 2. Add the Rust plugin

Copy `templates/xid-keychain-plugin.rs` into `src-tauri/src/xid_keychain.rs` and register it (see `templates/tauri-app-setup.rs`).

Add to `src-tauri/Cargo.toml`:

```toml
[dependencies]
tauri-plugin-deep-link = "2"
tauri-plugin-shell = "2"
keyring = "2"
```

### 3. JS integration

```ts
import { createXidTauriClient, createTauriKeychainAdapter } from '@xid-kit/tauri'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-shell'
import { onOpenUrl } from '@tauri-apps/plugin-deep-link'

const client = createXidTauriClient({
  issuer: 'https://xid.dev',
  clientId: 'YOUR_CLIENT_ID',
  redirectUri: 'myapp://auth/callback',
  keychain: createTauriKeychainAdapter({ invoke }),
})

// Register deeplink handler once (e.g. in App component mount)
await onOpenUrl(async (urls) => {
  for (const url of urls) {
    await client.handleRedirect(url)
  }
})

// Trigger sign-in: opens the system browser
await client.signIn({ openUrl: open })
```

### 4. Token retrieval

```ts
// Get current access token (transparently refreshes if near expiry)
const token = await client.getAccessToken()

// Get full session (includes userId, organizationId, expiresAt)
const session = await client.getSession()
if (session) {
  console.log(session.userId, session.accessToken)
}
```

### 5. Sign-out

```ts
// Revokes server session and clears all keychain entries
await client.signOut()

// OIDC RP-initiated logout URL (opens in system browser for full IdP sign-out)
const logoutUrl = client.buildSignOutUrl({
  postLogoutRedirectUri: 'myapp://logout',
})
await open(logoutUrl.toString())
```

## Dev / test without Tauri runtime

Use the memory adapter -- no Tauri runtime or keychain required:

```ts
import { createXidTauriClient, createMemoryKeychainAdapter } from '@xid-kit/tauri'

const client = createXidTauriClient({
  issuer: 'http://localhost:8788',
  clientId: 'test-client',
  redirectUri: 'http://localhost:1420/callback',
  keychain: createMemoryKeychainAdapter(),
})
```

## API reference

### `createXidTauriClient(options)`

| Option        | Type                 | Description                                                |
| ------------- | -------------------- | ---------------------------------------------------------- |
| `issuer`      | `string`             | XID issuer URL, e.g. `"https://xid.dev"`                   |
| `clientId`    | `string`             | OAuth 2.0 client_id registered in the XID console          |
| `redirectUri` | `string`             | Custom URI scheme callback, e.g. `"myapp://auth/callback"` |
| `scopes`      | `readonly string[]`  | OAuth scopes. Default: `["openid", "profile", "email"]`    |
| `keychain`    | `XidKeychainAdapter` | Token storage adapter. Default: `MemoryKeychainAdapter`    |
| `fetcher`     | `typeof fetch`       | Override fetch (testing). Default: `globalThis.fetch`      |
| `now`         | `() => number`       | Override clock in epoch seconds (testing)                  |

Returns an `XidTauriClient`:

| Method                      | Description                                                      |
| --------------------------- | ---------------------------------------------------------------- |
| `signIn(options?)`          | Build PKCE authorize URL; optionally open via `openUrl` callback |
| `handleRedirect(url)`       | Parse deeplink, validate state, exchange code for tokens         |
| `getSession()`              | Return `TauriSession` or `null`; refreshes token if near expiry  |
| `getAccessToken(options?)`  | Return access token string or `null`; refreshes if near expiry   |
| `signOut()`                 | Revoke server session and clear keychain                         |
| `buildSignOutUrl(options?)` | Build OIDC end_session URL                                       |
| `setTokenStorage(adapter)`  | Swap keychain adapter at runtime                                 |

### Keychain adapters

| Factory                                                 | Description                        |
| ------------------------------------------------------- | ---------------------------------- |
| `createTauriKeychainAdapter({ invoke, pluginPrefix? })` | Calls Rust plugin via Tauri invoke |
| `createMemoryKeychainAdapter()`                         | In-memory (dev / tests)            |

### Rust plugin contract

The JS adapter calls these Tauri commands:

```
plugin:xid-keychain|get    { key: String }                   -> Option<String>
plugin:xid-keychain|set    { key: String, value: String }    -> ()
plugin:xid-keychain|delete { key: String }                   -> ()
```

See `templates/xid-keychain-plugin.rs` for the full `keyring`-backed implementation.
See `templates/tauri-app-setup.rs` for app setup with deep-link registration.

## Token endpoint

The SDK posts to `{issuer}/token` (the XID server registers this path in `tenant-routes.ts`). Do not configure a path that includes `/oauth/`.

## PKCE

PKCE S256 is always used. `plain` is never generated. Verifier entropy is 64 bytes (512 bits, well above the RFC 7636 minimum of 32 bytes). Web Crypto (`crypto.subtle.digest('SHA-256', ...)`) is used for the challenge derivation.

## Token storage keys

All keys are namespaced under `xid.*`:

| Key                 | Contents                                                      |
| ------------------- | ------------------------------------------------------------- |
| `xid.access_token`  | Current access token JWT                                      |
| `xid.refresh_token` | Refresh token (rotation: new token replaces old on every use) |
| `xid.session`       | JSON-serialised `StoredSession` (userId, orgId, expiresAt)    |
| `xid.pkce_verifier` | Ephemeral PKCE verifier (cleared after exchange)              |
| `xid.oauth_state`   | Ephemeral OAuth state (cleared after exchange)                |

## Re-exports from @xid-kit/core

All public types from `@xid-kit/core` are re-exported so callers need only one import:
`XidClient`, `XidStore`, `SESSION_STATUS`, `XidUser`, `XidSession`, etc.
