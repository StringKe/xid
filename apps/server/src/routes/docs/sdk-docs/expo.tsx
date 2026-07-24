// @xid-kit/expo 参考页。API 真相源:packages/expo/src/index.ts。
// 注意:STATUS 为 Current package,real IdP round-trip 待人工验证。

import { Trans } from '@lingui/react/macro'
import { Link } from '../../../lib/router'
import { defineSdkDoc } from './shared'
import type { SdkDocSection } from './shared'

const sections: readonly SdkDocSection[] = [
  {
    heading: <Trans>Status</Trans>,
    body: [
      <Trans>
        Package status is <strong>Current package</strong>. Expo SecureStore and WebBrowser
        adapters, XidProvider, and Expo Router route guard hook are implemented. A real IdP
        round-trip on production infrastructure is still pending manual verification.
      </Trans>,
      <Trans>
        All PKCE logic, token exchange, and session management live in{' '}
        <Link to="/docs/sdks/react-native">@xid-kit/react-native</Link>; this package provides
        adapters and Expo Router integration only.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Provider setup</Trans>,
    body: [
      <Trans>
        Inject <code>createSecureStoreAdapter</code> and <code>createExpoWebBrowserAdapter</code>{' '}
        into <code>XidProvider</code>. No top-level Expo module import is needed; adapters accept
        module instances so CI typecheck stays clean without Expo peer deps installed.
      </Trans>,
    ],
    code: `import * as SecureStore from 'expo-secure-store'
import * as WebBrowser from 'expo-web-browser'
import { XidProvider, createSecureStoreAdapter, createExpoWebBrowserAdapter } from '@xid-kit/expo'

const tokenCache = createSecureStoreAdapter({ secureStore: SecureStore })
const browser = createExpoWebBrowserAdapter({ webBrowser: WebBrowser })

export default function App() {
  return (
    <XidProvider
      publishableKey="pk_live_..."
      issuer="https://xid.dev"
      clientId="your_client_id"
      redirectUri="myapp://auth/callback"
      tokenCache={tokenCache}
      browser={browser}
    >
      <RootLayout />
    </XidProvider>
  )
}`,
  },
  {
    heading: <Trans>Sign in and sign out</Trans>,
    code: `import { useSignIn, useSignOut } from '@xid-kit/expo'
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

function SignOutScreen() {
  const { signOut } = useSignOut()
  return <Button title="Sign Out" onPress={() => void signOut()} />
}`,
  },
  {
    heading: <Trans>Expo Router route guard</Trans>,
    body: [
      <Trans>
        Call <code>useProtectedRoute</code> in a layout component. It reads <code>isLoaded</code>/
        <code>isSignedIn</code> from <code>useAuth</code> and calls <code>replace</code> from Expo
        Router inside a <code>useEffect</code>.
      </Trans>,
    ],
    code: `import { useProtectedRoute } from '@xid-kit/expo'
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
}`,
  },
  {
    heading: <Trans>SecureStore key namespacing</Trans>,
    body: [
      <Trans>
        Use <code>keyPrefix</code> to namespace keys under a custom prefix. The separator is{' '}
        <code>.</code> (dot), which is within the allowed character set for{' '}
        <code>expo-secure-store</code>.
      </Trans>,
    ],
    code: `const tokenCache = createSecureStoreAdapter({
  secureStore: SecureStore,
  keyPrefix: 'myapp',
  // keys: 'myapp.xid.access_token', 'myapp.xid.refresh_token', etc.
})`,
  },
  {
    heading: <Trans>Exported API</Trans>,
    table: {
      headers: [<Trans>Export</Trans>, <Trans>Kind</Trans>, <Trans>Purpose</Trans>],
      rows: [
        [
          <code key="e">XidProvider</code>,
          <Trans>component</Trans>,
          <Trans>
            Re-export of @xid-kit/react-native XidProvider accepting tokenCache and browser adapters
          </Trans>,
        ],
        [
          <code key="e">createSecureStoreAdapter</code>,
          <Trans>function</Trans>,
          <Trans>
            TokenCache adapter backed by expo-secure-store; accepts secureStore instance and
            optional keyPrefix
          </Trans>,
        ],
        [
          <code key="e">createExpoWebBrowserAdapter</code>,
          <Trans>function</Trans>,
          <Trans>BrowserInterface adapter backed by expo-web-browser</Trans>,
        ],
        [
          <code key="e">useSignIn</code>,
          <Trans>hook</Trans>,
          <Trans>Re-export from @xid-kit/react-native: signIn, handleRedirect, signInState</Trans>,
        ],
        [
          <code key="e">useSignOut</code>,
          <Trans>hook</Trans>,
          <Trans>Re-export from @xid-kit/react-native: signOut, signOutState</Trans>,
        ],
        [
          <code key="e">useProtectedRoute</code>,
          <Trans>hook</Trans>,
          <Trans>
            Reads isLoaded/isSignedIn and calls Expo Router replace for route protection
          </Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Known limitations</Trans>,
    bullets: [
      <Trans>
        <code>useAuth().isSignedIn</code> reflects the <code>XidClient</code> web-cookie session
        state, which does not auto-populate from the local SecureStore tokens after token exchange.
        Reload client state explicitly after a successful sign-in.
      </Trans>,
      <Trans>
        This package provides only adapters and Expo Router integration. For the base React Native
        PKCE flow, see <Link to="/docs/sdks/react-native">@xid-kit/react-native</Link>.
      </Trans>,
    ],
  },
]

export const EXPO_DOC = defineSdkDoc({
  slug: 'sdks/expo',
  packageName: '@xid-kit/expo',
  summary: (
    <Trans>
      Expo SecureStore and WebBrowser adapters for @xid-kit/react-native plus an Expo Router route
      guard hook.
    </Trans>
  ),
  sections,
})
