// sdk/ios 参考页。API 真相源:sdk/ios/Sources/Xid/ + sdk/ios/README.md。
// 状态措辞按 docs/sdks/platform-matrix.md:Implemented · verified locally。

import { Trans } from '@lingui/react/macro'
import { defineSdkDoc } from './shared'
import type { SdkDocSection } from './shared'

const sections: readonly SdkDocSection[] = [
  {
    heading: <Trans>Status</Trans>,
    body: [
      <Trans>
        Package status is <strong>Implemented · verified locally</strong>. Unit tests (19 passed)
        run on macOS targeting an iOS simulator. Real IdP round-trip on a running XID instance is
        pending manual verification. This page documents implemented behavior; it is not a
        production-readiness claim.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Requirements</Trans>,
    bullets: [
      <Trans>iOS 16+ / macOS 13+</Trans>,
      <Trans>Swift 5.9+ and Xcode 15+</Trans>,
      <Trans>No third-party dependencies — uses Apple system frameworks only</Trans>,
    ],
  },
  {
    heading: <Trans>Installation</Trans>,
    body: [
      <Trans>
        Add the package via Swift Package Manager in Xcode (File -{'>'} Add Package Dependencies) or
        directly in <code>Package.swift</code>:
      </Trans>,
    ],
    code: `// Package.swift
dependencies: [
    .package(url: "https://github.com/StringKe/xid", from: "0.1.0"),
],
targets: [
    .target(name: "YourApp", dependencies: [.product(name: "Xid", package: "xid")]),
]`,
  },
  {
    heading: <Trans>Quick start</Trans>,
    code: `import Xid

// 1. Configure in @main App.init
Xid.shared.configure(options: XidConfiguration(
    issuer: URL(string: "https://xid.dev")!,
    clientId: "your_client_id",
    redirectUri: URL(string: "com.example.app://auth/callback")!,
    scopes: ["openid", "profile", "email", "offline_access"]
))

// 2. Sign in (opens ASWebAuthenticationSession)
try await Xid.shared.signIn()

// 3. Handle redirect in SceneDelegate
let session = try await Xid.shared.handleRedirect(url: callbackUrl)

// 4. Get current session (auto-refreshes near expiry)
if let session = try await Xid.shared.getSession() {
    let token = try await Xid.shared.getAccessToken()
}

// 5. Sign out
try await Xid.shared.signOut(callEndSession: true)`,
  },
  {
    heading: <Trans>Core API</Trans>,
    table: {
      headers: [<Trans>Method</Trans>, <Trans>Description</Trans>],
      rows: [
        [
          <code key="m">configure(options:)</code>,
          <Trans>
            Initialize with issuer, clientId, redirectUri, scopes. Call before all others.
          </Trans>,
        ],
        [
          <code key="m">signIn(options:) async throws</code>,
          <Trans>
            Open ASWebAuthenticationSession with PKCE S256 authorization URL. Returns when the
            browser session ends.
          </Trans>,
        ],
        [
          <code key="m">handleRedirect(url:) async throws -{'>'} XidSession</code>,
          <Trans>
            Validate OAuth state, exchange authorization code at the token endpoint, persist tokens
            to Keychain, and return a session.
          </Trans>,
        ],
        [
          <code key="m">getSession() async throws -{'>'} XidSession?</code>,
          <Trans>
            Return the stored session, triggering a refresh token rotation if near expiry.
          </Trans>,
        ],
        [
          <code key="m">getAccessToken(forceRefresh:) async throws -{'>'} String</code>,
          <Trans>Return a valid access token string, refreshing automatically if needed.</Trans>,
        ],
        [
          <code key="m">signOut(callEndSession:) async throws</code>,
          <Trans>
            Clear Keychain tokens. Pass true to call the end_session endpoint via the browser.
          </Trans>,
        ],
        [
          <code key="m">setTokenStorage(_:) throws</code>,
          <Trans>
            Replace the default KeychainTokenStorage with a custom TokenStorageAdapter
            implementation.
          </Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Storage adapter</Trans>,
    body: [
      <Trans>
        The default storage uses Keychain with{' '}
        <code>kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly</code> — tokens are not synced to
        iCloud Keychain. Implement the <code>TokenStorageAdapter</code> protocol to use an
        enterprise Keychain policy:
      </Trans>,
    ],
    code: `struct EnterpriseKeychain: TokenStorageAdapter {
    func save(key: String, value: String) throws { /* ... */ }
    func load(key: String) throws -> String? { /* ... */ }
    func delete(key: String) throws { /* ... */ }
}
try Xid.shared.setTokenStorage(EnterpriseKeychain())`,
  },
  {
    heading: <Trans>Security</Trans>,
    bullets: [
      <Trans>Public client — no client secret stored or transmitted.</Trans>,
      <Trans>PKCE S256 only. Server rejects plain challenge method.</Trans>,
      <Trans>
        Random OAuth state generated per request; validated on redirect to prevent CSRF.
      </Trans>,
      <Trans>
        PKCE code_verifier written to Keychain only for the duration of the authorization flow and
        deleted immediately after the code exchange.
      </Trans>,
      <Trans>
        ASWebAuthenticationSession launched with prefersEphemeralWebBrowserSession = true to avoid
        sharing browser cookies across apps.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Known limitations</Trans>,
    bullets: [
      <Trans>
        JWKS-backed ES256/RS256 ID token verification, end_session logout, and refresh single-flight
        are implemented and locally tested. A real IdP round-trip on an iOS device or simulator is
        still required before L4 support.
      </Trans>,
      <Trans>Keychain behavior must be verified in an Xcode device or simulator test run.</Trans>,
    ],
  },
]

export const IOS_DOC = defineSdkDoc({
  slug: 'sdks/ios',
  packageName: 'sdk/ios',
  summary: (
    <Trans>
      Swift SDK for iOS and macOS using ASWebAuthenticationSession, PKCE S256 authorization code
      flow, and Keychain token storage.
    </Trans>
  ),
  sections,
})
