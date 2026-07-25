// sdk/flutter 参考页。API 真相源:sdk/flutter/lib/ + sdk/flutter/README.md + pubspec.yaml。
// 状态措辞按 docs/sdks/platform-matrix.md:Implemented · verified locally。

import { Trans } from '@lingui/react/macro'
import { defineSdkDoc } from './shared'
import type { SdkDocSection } from './shared'

const sections: readonly SdkDocSection[] = [
  {
    heading: <Trans>Status</Trans>,
    body: [
      <Trans>
        Package status is <strong>Implemented · verified locally</strong>. Pure-Dart unit tests (21
        passed) cover PKCE, token models, and in-memory storage. Platform-channel paths
        (flutter_secure_storage, flutter_web_auth_2) require a real device or simulator to verify.
        Real IdP round-trip is pending manual verification. This page documents implemented
        behavior; it is not a production-readiness claim.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Installation</Trans>,
    body: [<Trans>Add to pubspec.yaml and run flutter pub get:</Trans>],
    code: `# pubspec.yaml
dependencies:
  xid:
    git:
      url: https://github.com/StringKe/xid
      path: sdk/flutter
      ref: main`,
  },
  {
    heading: <Trans>Platform setup</Trans>,
    body: [<Trans>Register the callback URI scheme on each platform.</Trans>],
    code: `<!-- Android: AndroidManifest.xml (main Activity) -->
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="com.example.myapp" android:host="auth" />
</intent-filter>

<!-- iOS: Info.plist -->
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array><string>com.example.myapp</string></array>
  </dict>
</array>`,
  },
  {
    heading: <Trans>Quick start</Trans>,
    code: `import 'package:xid/xid.dart';

final client = XidClient();

// 1. Initialize (fetches OIDC discovery)
await client.configure(
  const XidOptions(
    issuer: 'https://xid.dev',
    clientId: 'YOUR_CLIENT_ID',
    redirectUri: 'com.example.myapp://auth/callback',
    scopes: ['openid', 'profile', 'email', 'offline_access'],
  ),
);

// 2. Sign in (opens system browser, PKCE S256)
final session = await client.signIn();
print(session.user.email);

// 3. Get valid access token (auto-refreshes)
final token = await client.getAccessToken();

// 4. Get current session
final current = await client.getSession();

// 5. Sign out (revokes refresh token + clears secure storage)
await client.signOut();`,
  },
  {
    heading: <Trans>Core API</Trans>,
    table: {
      headers: [<Trans>Method</Trans>, <Trans>Description</Trans>],
      rows: [
        [
          <code key="m">
            configure(XidOptions, {'{'}storageAdapter?{'}'})
          </code>,
          <Trans>
            Initialize SDK and fetch OIDC discovery. Must be called before all other methods.
          </Trans>,
        ],
        [
          <code key="m">
            signIn({'{}'}additionalParameters?, audience?{'}'})
          </code>,
          <Trans>
            Open system browser with PKCE S256 authorization URL; exchange code and return
            XidSession.
          </Trans>,
        ],
        [
          <code key="m">handleRedirect(String url)</code>,
          <Trans>
            Process App Link or custom scheme callback. Called internally by signIn; invoke manually
            for cross-process redirect recovery.
          </Trans>,
        ],
        [
          <code key="m">getSession()</code>,
          <Trans>
            Return XidSession? — triggers refresh token rotation if access token is near expiry
            (within 60 s).
          </Trans>,
        ],
        [
          <code key="m">
            getAccessToken({'{}'}bool forceRefresh{'}'})
          </code>,
          <Trans>
            Return a valid access token string. Pass forceRefresh: true to force renewal.
          </Trans>,
        ],
        [
          <code key="m">
            signOut({'{}'}bool openLogoutUrl{'}'})
          </code>,
          <Trans>
            Revoke refresh token (RFC 7009), clear secure storage, and optionally open
            end_session_endpoint in the browser.
          </Trans>,
        ],
        [
          <code key="m">setTokenStorage(TokenStorageAdapter)</code>,
          <Trans>
            Replace the default SecureStorageAdapter (flutter_secure_storage) with a custom
            implementation.
          </Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Dependencies</Trans>,
    table: {
      headers: [<Trans>Package</Trans>, <Trans>Version</Trans>, <Trans>Purpose</Trans>],
      rows: [
        [
          <code key="p">flutter_web_auth_2</code>,
          <Trans>^4.0.0</Trans>,
          <Trans>System browser authorization session and callback receipt</Trans>,
        ],
        [
          <code key="p">flutter_secure_storage</code>,
          <Trans>^9.2.4</Trans>,
          <Trans>Platform secure storage (Keychain / Keystore / DPAPI)</Trans>,
        ],
        [
          <code key="p">crypto</code>,
          <Trans>^3.0.3</Trans>,
          <Trans>SHA-256 for PKCE S256 challenge computation</Trans>,
        ],
        [
          <code key="p">http</code>,
          <Trans>^1.2.2</Trans>,
          <Trans>HTTP client for discovery and token endpoints</Trans>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Security</Trans>,
    bullets: [
      <Trans>Public client — no client secret stored or transmitted.</Trans>,
      <Trans>PKCE S256 only. No implicit flow or password grant.</Trans>,
      <Trans>
        OAuth state generated per request; validated in handleRedirect to prevent CSRF.
      </Trans>,
      <Trans>
        Refresh tokens are stored in platform secure storage (Keychain on iOS, Keystore on Android)
        and rotated on every use by the XID server.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Known limitations</Trans>,
    bullets: [
      <Trans>
        JWKS-backed ES256 ID token verification, persisted state-keyed PKCE, and refresh
        single-flight are implemented and locally tested. Real device and IdP validation are still
        required before L4 support.
      </Trans>,
      <Trans>offline_access must be included in scopes to receive a refresh token.</Trans>,
    ],
  },
]

export const FLUTTER_DOC = defineSdkDoc({
  slug: 'sdks/flutter',
  packageName: 'sdk/flutter',
  summary: (
    <Trans>
      Dart / Flutter SDK for iOS, Android, and desktop using flutter_web_auth_2, PKCE S256
      authorization code flow, and flutter_secure_storage token persistence.
    </Trans>
  ),
  sections,
})
