# iOS Swift SDK

**Status: implemented.** `sdk/ios` has a complete Swift package with source and tests; `swift test` passes (compiled on macOS targeting iOS). Real IdP round-trip (L4) and real iOS simulator/device testing are pending.

This SDK is distributed as source inside the repository. It is not published to CocoaPods or any other registry.

## What is implemented

- `Xid.shared.configure` / `signIn` / `handleRedirect` / `getSession` / `getAccessToken` / `signOut` / `setTokenStorage`
- `ASWebAuthenticationSession`-based Hosted Auth + OIDC Authorization Code + PKCE S256 flow
- Keychain token storage (`KeychainTokenStorage`) with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`
- `TokenStorageAdapter` protocol for custom storage backends
- OIDC discovery document fetch and cache (`OIDCDiscovery`)
- `/token` authorization code + PKCE exchange (`TokenEndpoint`)
- independent 32-byte state and OIDC nonce values stored in a one-time pending authorization record
- state CSRF validation and exact nonce validation against the JWKS-verified ID token before persistence
- JWKS-backed ES256/RS256/PS256 ID token verification and `/userinfo` fallback
- RP-initiated logout and multi-scene `ASWebAuthenticationSession` presentation anchor resolution
- Access-token reads while valid; expiry clears the local token session and requires authorization again

## Platform requirements

- iOS 16+
- macOS 13+ (Package also declares macOS support)
- Swift 5.9+
- Xcode 15+

## Install

Swift Package Manager: in Xcode, File -> Add Package Dependencies, add:

```
https://github.com/StringKe/xid
```

Select `sdk/ios/Package.swift` and add `Xid` to your target. You can also vendor `sdk/ios` into your own repository and reference it by local path. No third-party dependencies; uses Apple system frameworks only (`AuthenticationServices`, `CryptoKit`, `Security`).

## Quickstart

### Configure

```swift
import Xid

@main
struct MyApp: App {
    init() {
        Xid.shared.configure(options: XidConfiguration(
            issuer: URL(string: "https://xid.dev")!,
            clientId: "your_client_id",
            redirectUri: URL(string: "com.example.app://auth/callback")!,
            scopes: ["openid", "profile", "email"]
        ))
    }

    var body: some Scene {
        WindowGroup { ContentView() }
    }
}
```

### Sign in

```swift
Button("Sign In") {
    Task {
        do {
            try await Xid.shared.signIn()
        } catch XidError.authSessionCancelled {
            // user cancelled
        } catch {
            print("Sign in failed: \(error.localizedDescription)")
        }
    }
}
```

### Handle Universal Link callback (SceneDelegate)

```swift
func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
    guard let url = contexts.first?.url else { return }
    Task {
        do {
            let session = try await Xid.shared.handleRedirect(url: url)
            print("Signed in: \(session.user.email ?? session.user.sub)")
        } catch {
            print("Redirect handling failed: \(error)")
        }
    }
}
```

### Session access

```swift
// Get the current session while the access token is valid
if let session = try await Xid.shared.getSession() {
    let token = try await Xid.shared.getAccessToken()
}

// Sign out
try await Xid.shared.signOut(callEndSession: true)

// Custom storage
struct EnterpriseKeychain: TokenStorageAdapter {
    func save(key: String, value: String) throws { /* ... */ }
    func load(key: String) throws -> String? { /* ... */ }
    func delete(key: String) throws { /* ... */ }
}
try Xid.shared.setTokenStorage(EnterpriseKeychain())
```

## API reference

### `Xid.shared`

Singleton entry point.

| Method                                                 | Description                                     |
| ------------------------------------------------------ | ----------------------------------------------- |
| `configure(options:)`                                  | Initialize SDK; must be called first            |
| `signIn(options:) async throws`                        | Start authorization flow, opens system browser  |
| `handleRedirect(url:) async throws -> XidSession`      | Handle callback URL, complete code exchange     |
| `getSession() async throws -> XidSession?`             | Return an unexpired session; expiry requires authorization |
| `getAccessToken(forceRefresh:) async throws -> String` | Return an unexpired token; expiry or forceRefresh requires authorization |
| `signOut(callEndSession:) async throws`                | Sign out, clear local tokens                    |
| `setTokenStorage(_:) throws`                           | Replace token persistence adapter               |

### `XidConfiguration`

| Property       | Type                  | Description                                                |
| -------------- | --------------------- | ---------------------------------------------------------- |
| `issuer`       | `URL`                 | XID issuer, e.g. `https://xid.dev`                         |
| `clientId`     | `String`              | Public client ID; no client secret                         |
| `redirectUri`  | `URL`                 | Registered callback URI                                    |
| `scopes`       | `[String]`            | Default `["openid", "profile", "email"]`; `offline_access` is rejected |
| `tokenStorage` | `TokenStorageAdapter` | Default `KeychainTokenStorage`                             |

### `XidSession`

| Property       | Type      | Description                        |
| -------------- | --------- | ---------------------------------- |
| `accessToken`  | `String`  | JWT access token                   |
| `refreshToken` | `String?` | Reserved; always nil until the SDK implements DPoP |
| `idToken`      | `String`  | JWT ID token                       |
| `expiresAt`    | `Date`    | Access token expiry time           |
| `user`         | `XidUser` | Claims decoded from ID token       |
| `isExpired`    | `Bool`    | Whether the session has expired    |
| `isNearExpiry` | `Bool`    | Expires within 60 s                |

## Security

- Public client: no client secret stored; no implicit flow or password grant.
- PKCE S256: random code_verifier per `signIn`, SHA-256 code_challenge sent to server.
- state CSRF guard: random state per authorization request, validated in `handleRedirect`.
- OIDC nonce: an independent random nonce is sent to `/authorize`, restored with the state-keyed
  pending record, and matched exactly against the verified ID token before storage.
- Keychain: tokens stored with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`; not synced to iCloud.
- `ASWebAuthenticationSession`: `prefersEphemeralWebBrowserSession = true` by default; no shared browser cookies.
- code_verifier stored in Keychain only during the authorization flow; deleted after `handleRedirect`.

## Known limits (pending before production use)

- **Universal Link mode**: custom scheme path works via `ASWebAuthenticationSession` directly; universal link mode depends on `SceneDelegate.openURLContexts` and needs integration test coverage.
- **Network timeout**: `URLSession` requests have no timeout configured.
- **Swift strict concurrency**: some `@unchecked Sendable` annotations are temporary workarounds; need actor model.
- **`ASWebAuthenticationSession` / Keychain / real iOS behavior**: tests run on macOS; iOS simulator or device required to verify.

## Source layout

```
sdk/ios/
  Package.swift
  Sources/Xid/
    Xid.swift                 configure/signIn/handleRedirect/getSession/getAccessToken/signOut
    XidConfiguration.swift    Configuration struct
    XidSession.swift          Session and user data models
    XidError.swift            Error types
    PKCE.swift                PKCE S256 (CryptoKit SHA-256)
    TokenStorage.swift        TokenStorageAdapter protocol + KeychainTokenStorage
    OIDCDiscovery.swift       OIDC discovery document load and cache
    TokenEndpoint.swift       /token endpoint: authorization_code + PKCE grant
    IDTokenDecoder.swift      JWKS-backed ID token verification and verified-claim decoding
    AuthorizationSession.swift ASWebAuthenticationSession + authorization URL builder
  Tests/XidTests/
    PKCETests.swift
    IDTokenDecoderTests.swift
    KeychainTokenStorageTests.swift
```
