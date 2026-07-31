# React Native SDK

**Status: implemented.** `@xid-kit/react-native` owns a native OIDC session rather than reusing
the web-cookie state from `@xid-kit/react`. Hosted Auth uses Authorization Code + PKCE S256,
state and nonce are persisted per pending authorization, the ID token is verified from JWKS before
storage, and `useAuth` / `useUser` / `useSession` restore from the injected secure `TokenCache`.
This public client does not implement DPoP, so it rejects `offline_access`; access-token expiry
clears the local session and requires reauthorization. Real Keychain, EncryptedSharedPreferences,
deep-link and real-IdP device evidence remain pending.

## Install

Registry status is `UNPUBLISHED`: local release artifacts are verified, but no npm publication has
been performed or authorized. The XID registry command below is post-publication only and becomes
valid after an independently verified authorized release. Until then, install XID from a source
checkout or audited tarball as described in [SDK Distribution](./distribution.md). React and React
Native keep their normal registry installation.

```sh
# Post-publication only
pnpm add @xid-kit/react-native

# Public peer dependencies
pnpm add react@^19 react-native
```

This package has no runtime dependency on `@xid-kit/react`, `@xid-kit/core` or `react-dom`.

## Quickstart

```tsx
import { XidProvider, useSignIn, useSignOut } from '@xid-kit/react-native'
import type { TokenCache, BrowserInterface } from '@xid-kit/react-native'

// 1. Implement TokenCache with a native secure storage library.
const tokenCache: TokenCache = {
  getToken: (key) => SecureStorage.getItem(key),
  saveToken: (key, value) => SecureStorage.setItem(key, value),
  deleteToken: (key) => SecureStorage.removeItem(key),
}

// 2. Implement BrowserInterface (or use @xid-kit/expo for the Expo adapter).
const browser: BrowserInterface = {
  openAuthSession: (url, redirectUri) => InAppBrowser.openAuth(url, redirectUri),
}

// 3. Wrap app with XidProvider.
export default function App() {
  return (
    <XidProvider
      issuer="https://xid.dev"
      clientId="your_client_id"
      redirectUri="myapp://oauth/callback"
      scopes={['openid', 'profile', 'email']}
      tokenCache={tokenCache}
      browser={browser}
    >
      <RootNavigator />
    </XidProvider>
  )
}
```

## Exported API

### Provider

| Export             | Description                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `XidProvider`      | Restores the native token session, then publishes auth state to native hooks.                  |
| `XidProviderProps` | `tokenCache`, `browser`, `issuer`, `clientId`, `redirectUri`, optional `scopes` and `fetcher`. |

### Hooks (RN-specific)

| Export       | Description                                                                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useSignIn`  | Returns `{ signIn, handleRedirect, signInState }`. `signIn()` opens the browser for PKCE S256 authorize; `handleRedirect(url)` processes the deep-link callback. |
| `useSignOut` | Returns `{ signOut, signOutState }`. Deterministically clears local state without a refresh or revoke network path.                                              |

### Native token-session hooks

- `useAuth()` exposes `isLoaded`, `isSignedIn`, `isAnonymous`, verified `userId` / `sessionId`,
  `getToken()` and native `signOut()`.
- `useUser()` maps verified ID token claims to `NativeUser`.
- `useSession()` exposes the stored token envelope; `getToken()` returns `null` after expiry.
- `SignedIn`, `SignedOut`, `XidLoaded` and `XidLoading` use this native session state.

Organization CRUD/list hooks and web UI components are not exported by this package. Use the
Management API with the verified access token when an application needs those flows.

### Adapter types

| Export             | Description                                                                            |
| ------------------ | -------------------------------------------------------------------------------------- |
| `TokenCache`       | `{ getToken, saveToken, deleteToken, coordinationNamespace? }` secure storage adapter. |
| `BrowserInterface` | `{ openAuthSession(url, redirectUri) }` in-app browser adapter.                        |
| `BrowserResult`    | Success with callback URL, or a `cancel` / `dismiss` result.                           |

### PKCE utilities (advanced / testing)

| Export                          | Description                                                         |
| ------------------------------- | ------------------------------------------------------------------- |
| `createPkceVerifier(length?)`   | Generate RFC 7636 code_verifier (delegates to `@xid-kit/protocol`). |
| `createPkceChallenge(verifier)` | Compute S256 code_challenge (delegates to `@xid-kit/protocol`).     |
| `createRandomString(length)`    | Generate URL-safe random state/nonce material.                      |

## Security

- Authorization Code with PKCE S256 only. No implicit grant, no password grant.
- Public clients never store client secrets.
- PKCE verifier, redirect URI and an independent nonce are stored under the random state key.
- Pending authorization records are consumed once, so replayed callbacks cannot exchange again.
- CSRF protection validates `state` before exchange; OIDC replay protection validates nonce after
  JWKS signature, issuer, audience and time checks.
- The active session is one fail-closed envelope. A pending marker prevents restart from observing
  a partially replaced token set.
- Authorization session commits, clear and sign-out share a per-namespace mutation queue.
- XID requires DPoP sender binding before a public client can receive a refresh token. This SDK has
  no DPoP proof implementation, rejects `offline_access`, and never advertises automatic refresh.
- Sign-out clears local state and any legacy credential storage without making a revoke request.
- The historical `xid.refresh_token` key is delete-only migration cleanup; current code never reads
  or writes a refresh credential.

## Known limits

- Real secure-storage, browser and deep-link adapters require device or emulator verification.
- The real-IdP L4 authorize -> callback -> token round trip is not verified.
- DPoP sender binding and refresh-token support are not implemented.
- One active local account is supported per `TokenCache` namespace. Multi-session and account
  switching are not implemented.
- Organization management hooks and native organization UI are not implemented.

Status: implemented locally; real device / real IdP round-trip pending.
