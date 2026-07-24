// sdk/macos 参考页。API 真相源:sdk/macos/Sources/Xid/ + sdk/macos/README.md。
// 状态措辞按 docs/sdks/platform-matrix.md:Implemented · verified locally。

import { Trans } from '@lingui/react/macro'
import { defineSdkDoc } from './shared'
import type { SdkDocSection } from './shared'

const sections: readonly SdkDocSection[] = [
  {
    heading: <Trans>Status</Trans>,
    body: [
      <Trans>
        Package status is <strong>Implemented · verified locally</strong>. Unit tests (22 passed)
        run on macOS. Keychain access and the full ASWebAuthenticationSession OAuth callback flow
        require a running XID instance for L4 verification. Real IdP round-trip is pending manual
        verification. This page documents implemented behavior; it is not a production-readiness
        claim.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Requirements</Trans>,
    bullets: [
      <Trans>macOS 13+</Trans>,
      <Trans>Swift 5.9+ and Xcode 15+</Trans>,
      <Trans>
        No third-party dependencies — uses Apple system frameworks (AuthenticationServices,
        CryptoKit, Security)
      </Trans>,
    ],
  },
  {
    heading: <Trans>Installation</Trans>,
    body: [<Trans>Add via Swift Package Manager in Package.swift:</Trans>],
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

let client = XidClient()

// 1. Configure
client.configure(XidOptions(
    issuer: URL(string: "https://xid.dev")!,
    clientId: "your_client_id",
    redirectUri: "yourapp://callback"
))

// 2. Sign in (opens ASWebAuthenticationSession)
let session = try await client.signIn()

// 3. Get a valid access token (auto-refresh)
let token = try await client.getAccessToken()

// 4. Get current session
let current = try await client.getSession()

// 5. Sign out
try await client.signOut()`,
  },
  {
    heading: <Trans>Core API</Trans>,
    table: {
      headers: [<Trans>Method</Trans>, <Trans>Description</Trans>],
      rows: [
        [
          <code key="m">configure(_ options:)</code>,
          <Trans>
            Set issuer, clientId, redirectUri, and scopes. Call before all other methods.
          </Trans>,
        ],
        [
          <code key="m">signIn() async throws -{'>'} XidSession</code>,
          <Trans>
            Launch ASWebAuthenticationSession, complete PKCE S256 authorization code flow, persist
            tokens to Keychain, and return a session.
          </Trans>,
        ],
        [
          <code key="m">handleRedirect(_ url:) async throws -{'>'} XidSession</code>,
          <Trans>
            Process a redirect URL from an external source and exchange the code for tokens.
          </Trans>,
        ],
        [
          <code key="m">getSession() async throws -{'>'} XidSession?</code>,
          <Trans>
            Return the stored session with automatic refresh token rotation if near expiry.
          </Trans>,
        ],
        [
          <code key="m">getAccessToken() async throws -{'>'} String</code>,
          <Trans>Return a valid access token string, refreshing automatically if needed.</Trans>,
        ],
        [
          <code key="m">signOut() async throws</code>,
          <Trans>Clear Keychain tokens and revoke the local session.</Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Relationship to sdk/ios</Trans>,
    body: [
      <Trans>
        The macOS SDK shares the same Swift implementation pattern as sdk/ios —
        ASWebAuthenticationSession for browser-based authorization, CryptoKit for PKCE S256, and
        Keychain for token storage. The two packages target different Apple platform minima and are
        maintained separately to allow platform-specific entitlement configuration.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Security</Trans>,
    bullets: [
      <Trans>Public client — no client secret stored or transmitted.</Trans>,
      <Trans>PKCE S256 only. Server rejects plain challenge method.</Trans>,
      <Trans>OAuth state generated per request; validated on redirect to prevent CSRF.</Trans>,
      <Trans>
        Tokens stored in Keychain with device-only access; not synced to iCloud Keychain.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Known limitations</Trans>,
    bullets: [
      <Trans>
        JWKS-backed ES256/RS256 ID token verification and end_session logout are implemented and
        locally tested. Real macOS Keychain and IdP round-trip validation is still required before
        L4 support.
      </Trans>,
      <Trans>
        Shared Swift core extraction with sdk/ios is planned but not yet done — each package carries
        its own copy of the implementation.
      </Trans>,
    ],
  },
]

export const MACOS_DOC = defineSdkDoc({
  slug: 'sdks/macos',
  packageName: 'sdk/macos',
  summary: (
    <Trans>
      Swift SDK for macOS using ASWebAuthenticationSession, PKCE S256 authorization code flow, and
      Keychain token storage. Shares the implementation pattern with sdk/ios.
    </Trans>
  ),
  sections,
})
