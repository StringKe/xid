# @xid-kit/expo

Distribution status: release artifacts are verified locally, but no npm publish has been performed.
Install commands become registry-backed only after an authorized release. See
https://github.com/StringKe/xid/blob/main/docs/sdks/distribution.md.

**Status: current package.** Expo SDK for XID identity platform. Wraps `@xid-kit/react-native` with ready-made adapters for `expo-secure-store` and `expo-web-browser`, plus an Expo Router `useProtectedRoute` hook.

See `docs/sdks/platform-matrix.md` for the full capability matrix and current limitations.
`useAuth().isSignedIn` is restored directly from the verified SecureStore token session; it does
not depend on browser-cookie synchronization.

## Peer dependencies

```
expo >= 51
expo-secure-store >= 13
expo-web-browser >= 14
react ^19
react-native >= 0.73
```

## Installation

```sh
pnpm add @xid-kit/expo
pnpm add expo-secure-store expo-web-browser expo react@^19 react-native
```

The Expo package re-exports the native provider and hooks. It does not require `@xid-kit/react`,
`@xid-kit/core` or `react-dom`.

## Quick start

```tsx
import * as SecureStore from 'expo-secure-store'
import * as WebBrowser from 'expo-web-browser'
import { XidProvider, createSecureStoreAdapter, createExpoWebBrowserAdapter } from '@xid-kit/expo'

const tokenCache = createSecureStoreAdapter({ secureStore: SecureStore })
const browser = createExpoWebBrowserAdapter({ webBrowser: WebBrowser })

export default function App() {
  return (
    <XidProvider
      issuer="https://xid.dev"
      clientId="your_client_id"
      redirectUri="myapp://auth/callback"
      tokenCache={tokenCache}
      browser={browser}
    >
      <RootLayout />
    </XidProvider>
  )
}
```

## Sign in

```tsx
import { useSignIn } from '@xid-kit/expo'
import { Button } from 'react-native'

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

Errors (browser failure, CSRF state mismatch, token exchange failure) surface as `signInState.status === 'error'` with `signInState.error.message`.

## Sign out

```tsx
import { useSignOut } from '@xid-kit/expo'

function SignOutButton() {
  const { signOut } = useSignOut()
  return <Button title="Sign Out" onPress={() => void signOut()} />
}
```

## Expo Router route guard

Use `useProtectedRoute` in a layout component to redirect based on auth state:

```tsx
import { useProtectedRoute } from '@xid-kit/expo'
import { useRouter, usePathname } from 'expo-router'

export default function RootLayout() {
  const router = useRouter()
  const pathname = usePathname()

  useProtectedRoute({
    signInRoute: '/sign-in',
    protectedRoute: '/(app)',
    pathname,
    replace: router.replace,
  })

  return <Slot />
}
```

## keyPrefix for SecureStore namespacing

The key separator is `.` (dot), which is within the allowed character set for `expo-secure-store` (`[A-Za-z0-9._-]`).
Adapters created with the same prefix expose the same `coordinationNamespace`, so independently
created wrappers share one serialized session-mutation boundary.

```ts
const tokenCache = createSecureStoreAdapter({
  secureStore: SecureStore,
  keyPrefix: 'myapp',
  // Keys will be stored as 'myapp.xid.access_token', etc.
})
```

## Architecture

- `createSecureStoreAdapter` and `createExpoWebBrowserAdapter` accept injected module instances -- no top-level Expo module import, CI typecheck stays clean without Expo peer deps installed.
- `useProtectedRoute` reads the restored native `isLoaded` / `isSignedIn` state and calls `replace`
  from Expo Router.
- PKCE, nonce, ID token verification and authorization-code-only session handling live in
  `@xid-kit/react-native`; this package provides platform adapters and Expo Router integration.
- `offline_access` is rejected until the native SDK implements DPoP sender binding. After access
  token expiry, start sign-in again.
