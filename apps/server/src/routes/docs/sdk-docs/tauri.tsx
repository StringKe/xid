// @xid-kit/tauri 参考页。API 真相源:packages/tauri/src/index.ts, client.ts, keychain.ts。

import { Trans } from '@lingui/react/macro'
import { defineSdkDoc } from './shared'
import type { SdkDocSection } from './shared'

const sections: readonly SdkDocSection[] = [
  {
    heading: <Trans>Status</Trans>,
    body: [
      <Trans>
        Package status is <strong>Current package</strong>. JS bridge, PKCE S256 flow, deeplink
        callback handler, OS keychain adapter, and Rust plugin template are implemented. A real IdP
        round-trip on production infrastructure is still pending manual verification.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Tauri configuration</Trans>,
    code: `// tauri.conf.json
{
  "bundle": { "identifier": "com.example.myapp" },
  "plugins": {
    "deep-link": { "desktop": { "schemes": ["myapp"] } }
  }
}`,
  },
  {
    heading: <Trans>Rust plugin</Trans>,
    body: [
      <Trans>
        Copy <code>templates/xid-keychain-plugin.rs</code> into{' '}
        <code>src-tauri/src/xid_keychain.rs</code> and register it following{' '}
        <code>templates/tauri-app-setup.rs</code>. Add <code>keyring = "2"</code>,{' '}
        <code>tauri-plugin-deep-link = "2"</code>, and <code>tauri-plugin-shell = "2"</code> to{' '}
        <code>src-tauri/Cargo.toml</code>.
      </Trans>,
    ],
  },
  {
    heading: <Trans>JS integration</Trans>,
    code: `import { createXidTauriClient, createTauriKeychainAdapter } from '@xid-kit/tauri'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-shell'
import { onOpenUrl } from '@tauri-apps/plugin-deep-link'

const client = createXidTauriClient({
  issuer: 'https://xid.dev',
  clientId: 'YOUR_CLIENT_ID',
  redirectUri: 'myapp://auth/callback',
  keychain: createTauriKeychainAdapter({ invoke }),
})

// Register deeplink handler (e.g. on App component mount)
await onOpenUrl(async (urls) => {
  for (const url of urls) await client.handleRedirect(url)
})

// Trigger sign-in: opens system browser
await client.signIn({ openUrl: open })`,
  },
  {
    heading: <Trans>Token retrieval and sign-out</Trans>,
    code: `// Get current access token (refreshes transparently if near expiry)
const token = await client.getAccessToken()

// Get full session (userId, organizationId, expiresAt)
const session = await client.getSession()

// Revoke server session and clear all keychain entries
await client.signOut()

// OIDC RP-initiated logout URL for full IdP sign-out
const logoutUrl = client.buildSignOutUrl({ postLogoutRedirectUri: 'myapp://logout' })
await open(logoutUrl.toString())`,
  },
  {
    heading: <Trans>Dev/test without Tauri runtime</Trans>,
    code: `import { createXidTauriClient, createMemoryKeychainAdapter } from '@xid-kit/tauri'

const client = createXidTauriClient({
  issuer: 'http://localhost:8788',
  clientId: 'test-client',
  redirectUri: 'http://localhost:1420/callback',
  keychain: createMemoryKeychainAdapter(),
})`,
  },
  {
    heading: <Trans>createXidTauriClient options</Trans>,
    table: {
      headers: [<Trans>Option</Trans>, <Trans>Type</Trans>, <Trans>Description</Trans>],
      rows: [
        [<code key="o">issuer</code>, <Trans>string</Trans>, <Trans>XID issuer URL</Trans>],
        [<code key="o">clientId</code>, <Trans>string</Trans>, <Trans>OAuth 2.0 client_id</Trans>],
        [
          <code key="o">redirectUri</code>,
          <Trans>string</Trans>,
          <Trans>Custom URI scheme callback</Trans>,
        ],
        [
          <code key="o">scopes</code>,
          <Trans>readonly string[]</Trans>,
          <Trans>Default: openid, profile, email</Trans>,
        ],
        [
          <code key="o">keychain</code>,
          <Trans>XidKeychainAdapter</Trans>,
          <Trans>
            Token storage adapter; default is MemoryKeychainAdapter (use Tauri adapter in
            production)
          </Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>XidTauriClient methods</Trans>,
    table: {
      headers: [<Trans>Method</Trans>, <Trans>Description</Trans>],
      rows: [
        [
          <code key="m">signIn(options?)</code>,
          <Trans>Build PKCE authorize URL; open via openUrl callback</Trans>,
        ],
        [
          <code key="m">handleRedirect(url)</code>,
          <Trans>Parse deeplink, validate state, exchange code for tokens</Trans>,
        ],
        [
          <code key="m">getSession()</code>,
          <Trans>TauriSession or null; refreshes token if near expiry</Trans>,
        ],
        [
          <code key="m">getAccessToken(options?)</code>,
          <Trans>Access token string or null; refreshes if near expiry</Trans>,
        ],
        [<code key="m">signOut()</code>, <Trans>Revoke server session and clear keychain</Trans>],
        [
          <code key="m">buildSignOutUrl(options?)</code>,
          <Trans>Build OIDC end_session URL for RP-initiated logout</Trans>,
        ],
        [
          <code key="m">setTokenStorage(adapter)</code>,
          <Trans>Swap keychain adapter at runtime</Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>PKCE and token storage</Trans>,
    bullets: [
      <Trans>PKCE S256 is always used. Plain challenge is never generated.</Trans>,
      <Trans>
        Verifier entropy is 64 bytes; challenge derived via Web Crypto{' '}
        <code>crypto.subtle.digest('SHA-256', ...)</code>.
      </Trans>,
      <Trans>
        All keys are namespaced under <code>xid.*</code>: <code>xid.access_token</code>,{' '}
        <code>xid.refresh_token</code>, <code>xid.session</code>, <code>xid.pkce_verifier</code>,{' '}
        <code>xid.oauth_state</code>.
      </Trans>,
    ],
  },
]

export const TAURI_DOC = defineSdkDoc({
  slug: 'sdks/tauri',
  packageName: '@xid-kit/tauri',
  summary: (
    <Trans>
      Tauri v2 desktop SDK with PKCE S256 flow, deeplink callback handler, OS keychain adapter, and
      Rust plugin template.
    </Trans>
  ),
  sections,
})
