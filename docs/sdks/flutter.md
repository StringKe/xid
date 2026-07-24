# Flutter SDK

**Status: implemented.** `sdk/flutter` 的 Dart 源码、测试和 pubspec 已闭合。`flutter test` 覆盖 PKCE、state-keyed pending authorization、refresh single-flight、JWKS ES256 验签和内存存储。真实 secure storage、平台回调与真实 IdP L4 尚未验证，不能声明 production SDK。

## What is implemented

- `XidClient.configure` / `signIn` / `handleRedirect` / `getSession` / `getAccessToken` / `signOut` / `setTokenStorage`
- OIDC Authorization Code + PKCE S256 flow via `flutter_web_auth_2` (system browser)
- `flutter_secure_storage` backed token storage (Keychain/Keystore/DPAPI)
- `InMemoryStorageAdapter` for testing
- state-keyed PKCE pending authorization persisted by `TokenStorageAdapter`, with one-time consume and cross-process restore
- state parameter CSRF guard in `handleRedirect`
- OIDC discovery document fetch and in-process cache
- JWKS ES256 ID token signature, issuer, audience, expiry and not-before validation
- Automatic access token refresh on `getSession` / `getAccessToken` with storage-namespace single-flight coordination

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
    scopes: ['openid', 'profile', 'email', 'offline_access'],
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

Returns `XidSession?`. Automatically triggers refresh token rotation when the access token is near expiry (default 60 s ahead). Returns `null` when not signed in.

### `getAccessToken({bool forceRefresh})`

Returns a valid access token string. `forceRefresh: true` forces a refresh.

### `signOut({bool openLogoutUrl})`

Signs out: revokes refresh token (RFC 7009), clears local secure storage, and opens `end_session_endpoint` (on by default) to clear server-side SSO session.

### `setTokenStorage(TokenStorageAdapter adapter)`

Replaces the token storage backend. Default: `SecureStorageAdapter` (flutter_secure_storage).

## Security

- PKCE S256 only; no implicit flow or password grant.
- No client secret stored in the app (public client).
- Refresh tokens stored in platform secure storage (Keychain/Keystore/DPAPI/Secret Service).
- Refresh token rotation on every use (XID server-side rotation + family policy).
- state parameter CSRF guard per signIn.
- No SAML, SCIM, or Management API business logic.

## Dependencies

| Package                  | Version | Purpose                                           |
| ------------------------ | ------- | ------------------------------------------------- |
| `flutter_web_auth_2`     | ^4.0.0  | System browser auth session + callback            |
| `flutter_secure_storage` | ^9.2.4  | Platform secure storage (Keychain/Keystore/DPAPI) |
| `crypto`                 | ^3.0.3  | SHA-256 for PKCE S256 challenge                   |
| `http`                   | ^1.2.2  | HTTP client for discovery + token endpoints       |

## Known limits (pending before production use)

- **Nonce anti-replay**: nonce is not generated on authorize or validated on token receipt.
- **ID token algorithm coverage**: JWKS verifier accepts ES256 only. RS256 ID token support needs implementation and interoperability evidence before use.
- **Discovery cache TTL**: discovery has no TTL in the in-process cache; long-running processes should re-fetch periodically.
- **Cross-platform App Links**: macOS / Linux callback receipt requires additional configuration per flutter_web_auth_2 docs.
- **`flutter_secure_storage` / `flutter_web_auth_2` platform channels**: not covered by pure-Dart unit tests; require real device or simulator.
- **Real IdP L4**: a real issuer, application registration, browser callback and token exchange have not been verified on a device or simulator.
- **pub.dev publishing**: needs LICENSE, CHANGELOG.md, full doc comments, and complete test coverage.
