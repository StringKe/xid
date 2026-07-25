# React Native SDK

**Status: current package.** `@xid-kit/react-native` implements the Hosted Auth redirect flow, deep-link callback parsing with CSRF guard, PKCE S256 challenge generation, token exchange with `TokenCache` persistence, server-side session cleanup on `signOut`, and re-exports the full `@xid-kit/react` hook set (`useAuth` / `useUser` / `useOrganization` / `useSession`) backed by the core client. Known limits: no automatic refresh-token rotation (the refresh token is stored; exchange is manual), and `isSignedIn` is driven by the client session state rather than local token presence.

## Install

```sh
pnpm add @xid-kit/react-native @xid-kit/react @xid-kit/core
```

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
      publishableKey="pk_live_..."
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

| Export             | Description                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `XidProvider`      | Root provider -- wraps `@xid-kit/react` XidProvider and adds RN adapter context.                                                |
| `XidProviderProps` | Props type: extends `@xid-kit/react` XidProviderProps + `tokenCache`, `browser`, `issuer`, `clientId`, `redirectUri`, `scopes`. |

### Hooks (RN-specific)

| Export       | Description                                                                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useSignIn`  | Returns `{ signIn, handleRedirect, signInState }`. `signIn()` opens the browser for PKCE S256 authorize; `handleRedirect(url)` processes the deep-link callback. |
| `useSignOut` | Returns `{ signOut, signOutState }`. Clears local token cache and calls server session revocation.                                                               |

### Hooks (re-exported from @xid-kit/react)

`useAuth`, `useUser`, `useSession`, `useSessionList`, `useOrganization`, `useOrganizationList`, `useAPIKeys`.

**Note:** `useAuth().isSignedIn` reflects the `XidClient` session loaded from the server, not the presence of tokens in `TokenCache`. In a typical React Native setup the Hosted Auth session cookie set in the in-app browser does not propagate back to the JS fetch context, so `isSignedIn` will be false after sign-in until the client is explicitly reloaded with the stored access token.

### Control components (re-exported from @xid-kit/react)

`SignedIn`, `SignedOut`, `Protect`, `XidLoaded`, `XidLoading`, `XidFailed`, `XidDegraded`.

**Note:** `SignedIn` and `SignedOut` depend on `useAuth().isSignedIn` -- see above.

### Adapter types

| Export | Description |
| ------------------ | --------------------------------------------------------------------------- | ------------------ | -------------------- |
| `TokenCache` | `{ getToken, saveToken, deleteToken }` -- secure storage adapter interface. |
| `BrowserInterface` | `{ openAuthSession(url, redirectUri) }` -- in-app browser adapter interface. |
| `BrowserResult` | `{ type: 'success'; url: string }                                           | { type: 'cancel' } | { type: 'dismiss' }` |

### PKCE utilities (advanced / testing)

| Export                          | Description                                                         |
| ------------------------------- | ------------------------------------------------------------------- |
| `createPkceVerifier(length?)`   | Generate RFC 7636 code_verifier (delegates to `@xid-kit/protocol`). |
| `createPkceChallenge(verifier)` | Compute S256 code_challenge (delegates to `@xid-kit/protocol`).     |
| `createRandomString(length)`    | Generate URL-safe random string for OAuth state.                    |

## Security

- Authorization Code with PKCE S256 only. No implicit grant, no password grant.
- Public clients never store client secrets.
- PKCE verifier and OAuth state stored in the injected `TokenCache`, not in-memory.
- CSRF protection: `handleRedirect` validates `state` against the stored value before exchanging the code.

## Known limits

- No automatic refresh-token rotation on expiry: the refresh token is persisted in `TokenCache`, but the exchange must be triggered by the caller.
- `isSignedIn` reflects the core client session state (network-backed), not local `TokenCache` token presence.

Status: current package (real device / real IdP round-trip pending).
