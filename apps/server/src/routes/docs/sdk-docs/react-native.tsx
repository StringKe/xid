// @xid-kit/react-native 参考页。API 真相源:packages/react-native/src/index.ts
// 与 packages/react-native/README.md。状态措辞按 docs/sdks/platform-matrix.md:Current package。

import { Trans } from '@lingui/react/macro'
import { Link } from '../../../lib/router'
import { defineSdkDoc } from './shared'
import type { SdkDocSection } from './shared'

const sections: readonly SdkDocSection[] = [
  {
    heading: <Trans>Status</Trans>,
    body: [
      <Trans>
        Package status is <strong>Current package</strong>. It implements the shared native
        contract: Hosted Auth redirect with PKCE S256, CSRF state validation on the deep-link
        callback, authorization code exchange against the token endpoint, and secure token
        persistence through an injected storage adapter.
      </Trans>,
      <Trans>
        A real IdP round-trip on production infrastructure is still pending manual verification.
        This page documents implemented behavior; it is not a readiness claim.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Provider setup</Trans>,
    body: [
      <Trans>
        Inject a <code>TokenCache</code> (platform secure storage) and a{' '}
        <code>BrowserInterface</code> (in-app browser) into <code>XidProvider</code>. The SDK does
        not hard-bind any native module; Expo apps can use the ready-made adapters from{' '}
        <Link to="/docs/sdks/expo">@xid-kit/expo</Link>.
      </Trans>,
    ],
    code: `import { XidProvider } from '@xid-kit/react-native'
import type { BrowserInterface, TokenCache } from '@xid-kit/react-native'
import * as Keychain from 'react-native-keychain'

const tokenCache: TokenCache = {
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

const browser: BrowserInterface = {
  async openAuthSession(url, redirectUri) {
    // Open url with your in-app browser library, wait for the redirectUri
    // deep link, then return { type: 'success', url } or { type: 'cancel' }.
    throw new Error('Implement with your preferred in-app browser library.')
  },
}

export function App() {
  return (
    <XidProvider
      publishableKey="pk_live_..."
      apiUrl="https://xid.dev"
      issuer="https://xid.dev"
      clientId="your_client_id"
      redirectUri="myapp://auth/callback"
      tokenCache={tokenCache}
      browser={browser}
    >
      <RootNavigator />
    </XidProvider>
  )
}`,
  },
  {
    heading: <Trans>Sign in</Trans>,
    body: [
      <Trans>
        <code>signIn()</code> builds the PKCE S256 authorize URL, stores the verifier and OAuth
        state in the token cache, opens the browser adapter, and exchanges the returned code for
        tokens. Browser failure, CSRF state mismatch, and token exchange errors surface as{' '}
        <code>signInState.status === 'error'</code>.
      </Trans>,
    ],
    code: `import { useSignIn } from '@xid-kit/react-native'

function SignInScreen() {
  const { signIn, signInState } = useSignIn()

  return (
    <Button
      title={signInState.status === 'pending' ? 'Signing in...' : 'Sign in'}
      onPress={() => void signIn()}
    />
  )
}`,
  },
  {
    heading: <Trans>Deep link callback</Trans>,
    body: [
      <Trans>
        When the browser adapter cannot capture the redirect itself, register the redirect URI
        scheme in your app manifest and forward the deep link to <code>handleRedirect(url)</code>.
        It validates the OAuth state, exchanges the code, and stores the token set.
      </Trans>,
    ],
    code: `import { useSignIn } from '@xid-kit/react-native'
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
}`,
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
            Wraps the @xid-kit/react provider and injects tokenCache, browser, issuer, clientId,
            redirectUri, and scopes
          </Trans>,
        ],
        [
          <code key="e">useSignIn</code>,
          <Trans>hook</Trans>,
          <Trans>
            signIn(options?) runs the full redirect flow; handleRedirect(url) processes a deep-link
            callback; signInState reports idle, pending, complete, cancelled, or error
          </Trans>,
        ],
        [
          <code key="e">useSignOut</code>,
          <Trans>hook</Trans>,
          <Trans>
            signOut() clears the local token set, then revokes the server session through
            useAuth().signOut; signOutState reports progress
          </Trans>,
        ],
        [
          <code key="e">useXidRnContext</code>,
          <Trans>hook</Trans>,
          <Trans>Raw adapter context (advanced use and testing)</Trans>,
        ],
        [
          <code key="e">exchangeCodeForTokens</code>,
          <Trans>function</Trans>,
          <Trans>
            Low-level POST to the token endpoint with grant_type authorization_code and the PKCE
            verifier; returns a TokenSet
          </Trans>,
        ],
        [
          <code key="e">saveTokenSet / clearTokenSet</code>,
          <Trans>functions</Trans>,
          <Trans>Persist or remove the token set in the TokenCache adapter</Trans>,
        ],
        [
          <code key="e">TOKEN_KEYS</code>,
          <Trans>as const object</Trans>,
          <Trans>
            TokenCache key names for access, refresh, and ID tokens plus PKCE verifier and OAuth
            state
          </Trans>,
        ],
        [
          <code key="e">createPkceVerifier / createPkceChallenge</code>,
          <Trans>functions</Trans>,
          <Trans>PKCE S256 utilities delegated to @xid-kit/protocol (Web Crypto)</Trans>,
        ],
        [
          <code key="e">createRandomString / base64UrlEncode</code>,
          <Trans>functions</Trans>,
          <Trans>URL-safe random string for OAuth state; base64url encoding helper</Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Re-exports from @xid-kit/react</Trans>,
    body: [
      <Trans>
        Session hooks and control components are re-exported unchanged from{' '}
        <Link to="/docs/sdks/react">@xid-kit/react</Link>: <code>useAuth</code>,{' '}
        <code>useUser</code>, <code>useSession</code>, <code>useSessionList</code>,{' '}
        <code>useOrganization</code>, <code>useOrganizationList</code>, <code>useAPIKeys</code>,{' '}
        <code>SignedIn</code>, <code>SignedOut</code>, <code>Protect</code>, <code>XidLoaded</code>,{' '}
        <code>XidLoading</code>, <code>XidFailed</code>, and <code>XidDegraded</code>.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Types</Trans>,
    table: {
      headers: [<Trans>Type</Trans>, <Trans>Description</Trans>],
      rows: [
        [
          <code key="t">XidProviderProps</code>,
          <Trans>
            @xid-kit/react provider props plus tokenCache, browser, issuer, clientId, redirectUri,
            and optional scopes (default openid, profile, email)
          </Trans>,
        ],
        [
          <code key="t">TokenCache</code>,
          <Trans>Storage adapter contract: getToken, saveToken, deleteToken (all async)</Trans>,
        ],
        [
          <code key="t">BrowserInterface</code>,
          <Trans>openAuthSession(url, redirectUri) resolving to a BrowserResult</Trans>,
        ],
        [
          <code key="t">BrowserResult</code>,
          <Trans>Union of success (with callback URL), cancel, and dismiss</Trans>,
        ],
        [
          <code key="t">SignInOptions</code>,
          <Trans>Per-call overrides for signIn: redirectUri, scopes</Trans>,
        ],
        [
          <code key="t">SignInState / SignOutState</code>,
          <Trans>Discriminated status unions returned by the hooks</Trans>,
        ],
        [
          <code key="t">UseSignInReturn / UseSignOutReturn</code>,
          <Trans>Hook return shapes: actions plus state</Trans>,
        ],
        [
          <code key="t">TokenExchangeInput / TokenSet</code>,
          <Trans>
            Input and result of exchangeCodeForTokens: accessToken, refreshToken, idToken, expiresIn
          </Trans>,
        ],
        [
          <code key="t">XidRnContextValue</code>,
          <Trans>Adapter context shape returned by useXidRnContext</Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Known limitations</Trans>,
    bullets: [
      <Trans>
        No automatic session refresh on token expiry; the stored refresh token is available for
        application-managed renewal.
      </Trans>,
      <Trans>
        useAuth().isSignedIn reflects the XidClient cookie session, not TokenCache contents. Reload
        client state after a successful token exchange to drive live auth state.
      </Trans>,
      <Trans>Organization context is not populated from stored tokens yet.</Trans>,
    ],
  },
  {
    heading: <Trans>Security</Trans>,
    bullets: [
      <Trans>Authorization code with PKCE S256 only. No implicit or password grant.</Trans>,
      <Trans>Public clients never store client secrets.</Trans>,
      <Trans>
        PKCE verifier and OAuth state live in the injected secure storage adapter and are deleted
        after the code exchange.
      </Trans>,
      <Trans>
        signOut clears the local token set and revokes the server session; failures surface in
        signOutState instead of being swallowed.
      </Trans>,
    ],
  },
]

export const REACT_NATIVE_DOC = defineSdkDoc({
  slug: 'sdks/react-native',
  packageName: '@xid-kit/react-native',
  summary: (
    <Trans>
      React Native provider and hooks for Hosted Auth redirect, PKCE S256, deep-link callback, and
      secure token storage adapters.
    </Trans>
  ),
  sections,
})
