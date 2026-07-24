# macOS Swift SDK

**Status: implemented.** `sdk/macos` has a complete Swift package with source and tests; `swift test` passes. Real IdP round-trip (L4) is pending.

This SDK is distributed as source inside the repository. It is not published to CocoaPods or any other registry.

Uses the same implementation pattern as `sdk/ios`: `ASWebAuthenticationSession`, Keychain storage, `CryptoKit` PKCE. Platform target is macOS only.

## What is implemented

- `Xid.shared.configure` / `signIn` / `handleRedirect` / `getSession` / `getAccessToken` / `signOut` / `setTokenStorage`
- `ASWebAuthenticationSession`-based Hosted Auth + OIDC Authorization Code + PKCE S256 flow
- Authorization URL builder (`AuthorizationURLBuilder`)
- `/token` authorization code exchange and refresh token rotation (`TokenEndpoint`)
- Keychain token storage (`KeychainTokenStorage`)
- `TokenStorageAdapter` protocol for custom storage backends
- OIDC discovery document fetch and cache (`OIDCDiscovery`)
- state CSRF guard in `handleRedirect`
- Automatic access token refresh in `getSession` / `getAccessToken`

## Install

Swift Package Manager:

```swift
// Package.swift
dependencies: [
    .package(url: "https://github.com/StringKe/xid", branch: "main"),
],
targets: [
    .target(name: "YourApp", dependencies: [.product(name: "Xid", package: "xid")]),
]
```

You can also vendor `sdk/macos` into your own repository and reference it by local path.

No third-party dependencies. Uses `AuthenticationServices`, `CryptoKit`, `Security`.

## Quickstart

```swift
import Xid

let client = Xid.shared
client.configure(options: XidConfiguration(
    issuer: URL(string: "https://xid.dev")!,
    clientId: "your_client_id",
    redirectUri: URL(string: "yourapp://callback")!
))

// In a SwiftUI or AppKit window
try await client.signIn()
let token = try await client.getAccessToken()
try await client.signOut()
```

Handle universal link callback from `NSApplicationDelegate`:

```swift
func application(_ app: NSApplication, open urls: [URL]) {
    if let url = urls.first {
        Task { try await Xid.shared.handleRedirect(url: url) }
    }
}
```

## API

- `configure(_ options:)` -- set issuer / clientId / redirectUri / scopes
- `signIn(options:)` -- OIDC + PKCE via `ASWebAuthenticationSession`
- `handleRedirect(_ url:)` -- handle authorization callback, exchange code for tokens
- `getSession()` -- read current session (auto-refreshes near expiry)
- `getAccessToken(forceRefresh:)` -- return valid access token
- `signOut(callEndSession:)` -- clear local session
- `setTokenStorage(_:)` -- replace token persistence adapter

## Security

- Public client: no client secret stored; no implicit flow or password grant.
- PKCE S256: random code_verifier per `signIn`; SHA-256 code_challenge.
- state CSRF guard per authorization request; validated in `handleRedirect`.
- Keychain: tokens stored with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.
- code_verifier stored in Keychain only for the duration of the authorization flow.

## Known limits (pending before production use)

- **ID token signature verification**: implemented via `JwksCache` + `IDTokenVerifier` on login path; `IDTokenDecoder` remains decode-only for session restore.
- **`/end_session` network call**: implemented via `EndSessionClient` when `signOut(callEndSession: true)`.
- **`/userinfo` fallback**: implemented via `UserInfoClient` when ID token claims are insufficient.
- **Concurrent refresh race**: multiple simultaneous `getAccessToken()` calls may each trigger a refresh; needs a lock.
- **Swift strict concurrency**: some `@unchecked Sendable` annotations are temporary; need actor model.
- **Real IdP round-trip**: L4 end-to-end test against a running XID server endpoint not yet done.
- **Shared Swift core with `sdk/ios`**: the two packages share the same implementation pattern but have not yet been refactored into a shared Swift package.

## Source layout

```
sdk/macos/
  Package.swift
  Sources/Xid/
    Xid.swift                  configure/signIn/handleRedirect/getSession/getAccessToken/signOut
    XidConfiguration.swift     Configuration struct
    XidSession.swift           Session and user data models
    XidError.swift             Error types
    PKCE.swift                 PKCE S256 (CryptoKit SHA-256)
    TokenStorage.swift         TokenStorageAdapter protocol + KeychainTokenStorage
    OIDCDiscovery.swift        OIDC discovery document load and cache
    TokenEndpoint.swift        /token endpoint: authorization_code + refresh_token grant
    IDTokenDecoder.swift       ID token payload decode (no signature verification -- see Known limits)
    AuthorizationSession.swift ASWebAuthenticationSession + authorization URL builder
  Tests/XidTests/
    AuthorizationURLBuilderTests.swift
    IDTokenDecoderTests.swift
    KeychainTokenStorageTests.swift
    PKCETests.swift
```
