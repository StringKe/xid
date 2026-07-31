# Flutter SDK

**Status: implemented.** The Dart source, tests and pubspec under `sdk/flutter` are complete.
`flutter test` covers PKCE, state-keyed pending authorization, exact nonce claim validation,
access-token expiry handling and in-memory storage. ES256 uses the `cryptography_flutter` native backend
on Android, iOS and macOS; that platform channel, secure storage, browser callback and a real-IdP
L4 round trip still require device evidence.

## What is implemented

- `XidClient.configure` / `signIn` / `handleRedirect` / `getSession` / `getAccessToken` / `signOut` / `setTokenStorage`
- OIDC Authorization Code + PKCE S256 flow via `flutter_web_auth_2` (system browser)
- `flutter_secure_storage` backed token storage (Keychain/Keystore/DPAPI)
- `InMemoryStorageAdapter` for testing
- state-keyed PKCE pending authorization persisted by `TokenStorageAdapter`, with one-time consume and cross-process restore
- independent state and nonce generation, persisted per pending authorization
- state CSRF validation and exact nonce validation against the ID token before session persistence
- OIDC discovery document fetch and in-process cache
- JWKS ES256 ID token signature, issuer, audience, expiry, not-before and nonce validation through
  the native `cryptography_flutter` backend
- Access-token reads while valid; expiry clears the local token session and requires authorization again

## Install

Add to `pubspec.yaml`:

```yaml
dependencies:
  xid:
    git:
      url: https://github.com/StringKe/xid
      path: sdk/flutter
      ref: main
```

This SDK is not published to pub.dev; use the git dependency above or vendor `sdk/flutter` into your own repository.

Run `flutter pub get`.

## Platform configuration

### Android

```xml
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="com.example.myapp" android:host="auth" />
</intent-filter>
```

### iOS

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array><string>com.example.myapp</string></array>
  </dict>
</array>
```

## Quickstart

```dart
import 'package:xid/xid.dart';

final xidClient = XidClient();

await xidClient.configure(
  const XidOptions(
    issuer: 'https://xid.dev',
    clientId: 'YOUR_CLIENT_ID',
    redirectUri: 'com.example.myapp://auth/callback',
    scopes: ['openid', 'profile', 'email'],
  ),
);

final session = await xidClient.signIn();
print(session.user.email);

final token = await xidClient.getAccessToken();
final current = await xidClient.getSession();
await xidClient.signOut();

// Testing only -- replaces secure storage adapter
xidClient.setTokenStorage(InMemoryStorageAdapter());
```

## API

### `configure(XidOptions options, {TokenStorageAdapter? storageAdapter})`

Initialize SDK. Must be called before all other methods. Fetches and caches OIDC discovery document.

`XidOptions` fields:

| Field                   | Type                  | Description                                 |
| ----------------------- | --------------------- | ------------------------------------------- |
| `issuer`                | `String`              | XID issuer URL; hosted: `https://xid.dev`   |
| `clientId`              | `String`              | OAuth2 public client ID                     |
| `redirectUri`           | `String`              | App Link or custom scheme callback URI      |
| `postLogoutRedirectUri` | `String?`             | Post-logout redirect URI                    |
| `scopes`                | `List<String>`        | Default `['openid', 'profile', 'email']`    |
| `additionalParameters`  | `Map<String, String>` | Extra authorize parameters                  |
| `discoveryUrl`          | `String?`             | Override discovery URL (usually not needed) |

### `signIn({Map<String, String> additionalParameters, String? audience})`

Opens system browser to Hosted Auth. Completes Authorization Code + PKCE S256 and returns `XidSession`.

### `handleRedirect(String url)`

Process App Link / custom scheme callback URL. Normally called internally by `signIn`. Can be called manually for cross-process resume scenarios.

### `getSession()`

Returns `XidSession?` while the access token is valid. Expiry clears the local token session and
returns `null`; call `signIn()` to authorize again.

### `getAccessToken({bool forceRefresh})`

Returns an unexpired access token string. The SDK does not implement DPoP refresh;
`forceRefresh: true` or token expiry clears the local token session and returns `null`.

### `signOut({bool openLogoutUrl})`

Signs out: clears local secure storage and opens `end_session_endpoint` (on by default) to clear
the server-side SSO session.

### `setTokenStorage(TokenStorageAdapter adapter)`

Replaces the token storage backend. Default: `SecureStorageAdapter` (flutter_secure_storage).

## Security

- PKCE S256 only; no implicit flow or password grant.
- No client secret stored in the app (public client).
- The default scopes are `openid profile email`.
- `offline_access` is rejected during `configure()` because this SDK does not implement DPoP yet.
- state parameter CSRF guard per signIn.
- An independent OIDC nonce is sent to `/authorize`; a missing ID token or mismatched nonce rejects
  the callback before a session is stored.
- No SAML, SCIM, or Management API business logic.

## Dependencies

| Package                  | Version | Purpose                                           |
| ------------------------ | ------- | ------------------------------------------------- |
| `flutter_web_auth_2`     | ^4.0.0  | System browser auth session + callback            |
| `flutter_secure_storage` | ^9.2.4  | Platform secure storage (Keychain/Keystore/DPAPI) |
| `crypto`                 | ^3.0.3  | SHA-256 for PKCE S256 challenge                   |
| `cryptography`           | ^2.7.0  | ID token ES256 verification API                   |
| `cryptography_flutter`   | ^2.3.4  | Android/iOS/macOS native ECDSA backend             |
| `http`                   | ^1.2.2  | HTTP client for discovery + token endpoints       |

## Known limits (pending before production use)

- **ID token algorithm coverage**: JWKS verifier accepts ES256 only. RS256 ID token support needs implementation and interoperability evidence before use.
- **Native ECDSA evidence**: `cryptography_flutter` supplies the Android/iOS/macOS implementation,
  but the platform channel is not exercised by the headless `flutter test` runner.
- **Discovery cache TTL**: discovery has no TTL in the in-process cache; long-running processes should re-fetch periodically.
- **Cross-platform App Links**: macOS / Linux callback receipt requires additional configuration per flutter_web_auth_2 docs.
- **`flutter_secure_storage` / `flutter_web_auth_2` platform channels**: not covered by pure-Dart unit tests; require real device or simulator.
- **Real IdP L4**: a real issuer, application registration, browser callback and token exchange have not been verified on a device or simulator.
- **pub.dev publishing**: the `xid` registry name is already occupied and no registry ownership or
  alternate package name has been approved.
