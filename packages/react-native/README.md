# @xid-kit/react-native

Distribution status: release artifacts are verified locally, but no npm publish has been performed.
Install commands become registry-backed only after an authorized release. See
https://github.com/StringKe/xid/blob/main/docs/sdks/distribution.md.

**Status: implemented locally.** This package owns a secure native OIDC token session. It
implements Hosted Auth, state-keyed PKCE S256 and nonce, JWKS ID token verification, restart
restore, native auth hooks and local sign-out. Real device
adapters and a real-IdP L4 round trip remain pending.

See `docs/sdks/platform-matrix.md` for the full capability matrix.

## What works

- `XidProvider` -- wraps your app with RN-specific auth context (tokenCache, browser adapters).
- `useSignIn` -- persists verifier, redirect URI and nonce under random state, opens the browser,
  verifies the callback ID token, then stores one session envelope.
- `useAuth`, `useUser`, `useSession` -- read the verified native token session; no browser-cookie
  synchronization is required.
- `useSignOut` -- deterministic local session clearing with no refresh or revoke network path.
- Expired authorization-code-only sessions are cleared and require a new sign-in.
- Authorization commits, clear and sign-out are coordinated per storage namespace.

## Not implemented

- Organization management/list hooks and native organization UI.
- Multiple simultaneous local accounts or account switching.
- Device/emulator and real-IdP L4 verification.
- DPoP sender binding and therefore `offline_access` / refresh tokens.

## Installation

```sh
pnpm add @xid-kit/react-native
pnpm add react@^19 react-native
```

The package does not depend on `@xid-kit/react`, `@xid-kit/core` or `react-dom`.

## Quick start

```tsx
import { XidProvider, useSignIn, useSignOut } from '@xid-kit/react-native'
import type { TokenCache, BrowserInterface } from '@xid-kit/react-native'

// 1. Implement TokenCache (example using react-native-keychain)
import * as Keychain from 'react-native-keychain'

const keychainCache: TokenCache = {
  async getToken(key) {
    const result = await Keychain.getGenericPassword({ service: key })
    return result ? result.password : null
  },
  async saveToken(key, value) {
    await Keychain.setGenericPassword('xid', value, { service: key })
  },
  async deleteToken(key) {
    await Keychain.resetGenericPassword({ service: key })
  },
}

// 2. Implement BrowserInterface (or use @xid-kit/expo for the Expo adapter)
const linkingBrowser: BrowserInterface = {
  async openAuthSession(url, redirectUri) {
    // Open url via Linking or InAppBrowser; listen for deep link on redirectUri scheme.
    // Return { type: 'success', url: callbackUrl } or { type: 'cancel' }.
    throw new Error('Implement with your preferred in-app browser library.')
  },
}

// 3. Wrap your app
export default function App() {
  return (
    <XidProvider
      issuer="https://xid.dev"
      clientId="your_client_id"
      redirectUri="myapp://auth/callback"
      tokenCache={keychainCache}
      browser={linkingBrowser}
    >
      <RootNavigator />
    </XidProvider>
  )
}
```

## Sign in

```tsx
import { useSignIn } from '@xid-kit/react-native'

function SignInScreen() {
  const { signIn, signInState } = useSignIn()

  return (
    <Button
      title={signInState.status === 'pending' ? 'Signing in...' : 'Sign In'}
      onPress={() => void signIn()}
    />
  )
}
```

Errors from browser failure, CSRF state mismatch, or token exchange are surfaced as `signInState.status === 'error'` -- check `signInState.error.message`.

## Deep link callback

Register your redirect URI scheme (e.g. `myapp://auth/callback`) in your app manifest. On iOS add a URL scheme; on Android add an intent filter.

```tsx
import { useSignIn } from '@xid-kit/react-native'
import { useEffect } from 'react'
import { Linking } from 'react-native'

function DeepLinkHandler() {
  const { handleRedirect } = useSignIn()

  useEffect(() => {
    const sub = Linking.addEventListener('url', ({ url }) => {
      if (url.startsWith('myapp://auth/callback')) {
        void handleRedirect(url)
      }
    })
    return () => sub.remove()
  }, [handleRedirect])

  return null
}
```

## Sign out

```tsx
import { useSignOut } from '@xid-kit/react-native'

function SignOutButton() {
  const { signOut, signOutState } = useSignOut()
  return <Button title="Sign Out" onPress={() => void signOut()} />
}
```

## Expo

Use `@xid-kit/expo` for ready-made `createSecureStoreAdapter()` (`expo-secure-store`) and `createExpoWebBrowserAdapter()` (`expo-web-browser`). The expo package re-exports this package's full API.

## Architecture note

`XidProvider` creates an `XidSessionManager` around the injected `TokenCache`. The provider restores
that envelope on startup and updates all native hooks after sign-in or sign-out. ID token claims are
stored only after signature, issuer, audience, time and authorization nonce validation. This public
client does not implement DPoP, so `offline_access` is rejected and access-token expiry requires
reauthorization. The historical `xid.refresh_token` key is delete-only migration cleanup; current
code never reads or writes a refresh credential and never calls refresh or revoke endpoints. The web
SDK's cookie session is deliberately not part of this state machine.

PKCE uses `crypto.subtle.digest` and `crypto.getRandomValues` (Web Crypto, available in React Native >= 0.73 via the built-in Hermes polyfill or `react-native-quick-crypto`).
