# @xid-kit/react-native

**Status: current package.** This package implements the core Hosted Auth redirect flow with PKCE S256, secure token storage adapter contract, and the OAuth callback/token exchange layer. It does not provide automatic session refresh, organisation management UI, or online auth-state synchronisation -- those require a network-connected `XidClient`, which is not viable in the mobile React Native fetch context where cookie-based session state does not flow from an in-app browser back to the app's JS process.

See `docs/sdks/platform-matrix.md` for the full capability matrix.

## What works

- `XidProvider` -- wraps your app with RN-specific auth context (tokenCache, browser adapters).
- `useSignIn` -- builds the PKCE S256 authorize URL, opens the browser, and exchanges the code for tokens stored in `TokenCache`.
- `useSignOut` -- clears local token storage and calls the server session revocation endpoint via `@xid-kit/react`.
- `useAuth()`, `useUser()`, `useSession()`, etc. -- re-exported from `@xid-kit/react`. **Note:** `isSignedIn` reflects the `XidClient` web-cookie session state. In a typical RN setup, the `XidClient` cannot read the Hosted Auth session cookie (set in the in-app browser context, not the JS process). These hooks are wired and will work once an application-level mechanism updates the client state after token exchange -- see the architecture note below.

## What is not yet implemented (scaffold items)

- Automatic session refresh on token expiry.
- `isSignedIn` / `useUser` live state driven from the local `TokenCache` instead of web cookie session.
- Organisation context population from stored tokens.
- Server revocation call on sign-out (only local storage is cleared today).

## Installation

```sh
pnpm add @xid-kit/react-native @xid-kit/react @xid-kit/core
# Peer deps:
pnpm add react-native react
```

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
      publishableKey="pk_live_..."
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

`XidProvider` wraps `@xid-kit/react` `XidProvider` and adds `XidRnContext` (the tokenCache and browser adapters). The inner `XidClient` from `@xid-kit/core` uses the same cookie/session model as the web SDK. In a mobile context the session cookie is set in the in-app browser process and does not propagate to the React Native JS fetch context. As a result `useAuth().isSignedIn` reflects the XidClient's loaded session, not the presence of tokens in TokenCache.

The intended production pattern is to reload the client state (or call `client.load()`) after successful token exchange, using the access token to authenticate the subsequent session fetch. This wiring is not yet implemented in the scaffold.

PKCE uses `crypto.subtle.digest` and `crypto.getRandomValues` (Web Crypto, available in React Native >= 0.73 via the built-in Hermes polyfill or `react-native-quick-crypto`).
