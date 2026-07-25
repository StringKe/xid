// sdk/android 参考页。API 真相源:sdk/android/src/main/kotlin/dev/xid/sdk/ + sdk/android/README.md。
// 状态措辞按 docs/sdks/platform-matrix.md:Implemented · verified locally。

import { Trans } from '@lingui/react/macro'
import { defineSdkDoc } from './shared'
import type { SdkDocSection } from './shared'

const sections: readonly SdkDocSection[] = [
  {
    heading: <Trans>Status</Trans>,
    body: [
      <Trans>
        Package status is <strong>Implemented · verified locally</strong>. JVM unit tests (24
        passed) cover PKCE generation, OAuth state, and in-memory storage.
        EncryptedSharedPreferences (Keystore AES-256-GCM), Chrome Custom Tabs, and App Links
        behavior require a real Android device or emulator. Real IdP round-trip is pending manual
        verification. This page documents implemented behavior; it is not a production-readiness
        claim.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Requirements</Trans>,
    bullets: [
      <Trans>Android API 26+ (Android 8.0)</Trans>,
      <Trans>Kotlin 1.9+ and AndroidX</Trans>,
    ],
  },
  {
    heading: <Trans>Installation</Trans>,
    body: [<Trans>Add the dependency to your app module's build.gradle.kts:</Trans>],
    code: `dependencies {
    implementation("dev.xid:xid-android:0.1.0-alpha")
}

// Local development: add to settings.gradle.kts
includeBuild("../sdk/android")`,
  },
  {
    heading: <Trans>Manifest setup</Trans>,
    body: [
      <Trans>
        Register a callback Activity with an intent-filter. App Links (HTTPS scheme with autoVerify)
        are recommended over custom schemes:
      </Trans>,
    ],
    code: `<!-- AndroidManifest.xml -->
<activity android:name=".AuthCallbackActivity" android:exported="true">
    <intent-filter android:autoVerify="true">
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="https"
              android:host="yourapp.example.com"
              android:pathPrefix="/auth/callback" />
    </intent-filter>
</activity>`,
  },
  {
    heading: <Trans>Quick start</Trans>,
    code: `import dev.xid.sdk.Xid
import dev.xid.sdk.model.XidConfig

// 1. Initialize in Application.onCreate
Xid.configure(
    context = this,
    config = XidConfig(
        issuer = "https://xid.dev",
        clientId = "your_client_id",
        redirectUri = "https://yourapp.example.com/auth/callback",
        scopes = listOf("openid", "profile", "email", "offline_access"),
    )
)

// 2. Sign in (opens Chrome Custom Tabs)
lifecycleScope.launch { Xid.signIn(requireContext()) }

// 3. Handle redirect in AuthCallbackActivity
val session = Xid.handleRedirect(intent.data.toString())

// 4. Get current session (auto-refreshes near expiry)
val session = Xid.getSession()

// 5. Get access token
val token = Xid.getAccessToken()

// 6. Sign out
Xid.signOut(context = this, openEndSession = true)`,
  },
  {
    heading: <Trans>Core API</Trans>,
    table: {
      headers: [<Trans>Method</Trans>, <Trans>Signature</Trans>],
      rows: [
        [
          <code key="m">configure</code>,
          <code key="s">fun configure(context: Context, config: XidConfig)</code>,
        ],
        [
          <code key="m">signIn</code>,
          <code key="s">
            {'suspend fun signIn(context: Context, options: SignInOptions? = null)'}
          </code>,
        ],
        [
          <code key="m">handleRedirect</code>,
          <code key="s">{'suspend fun handleRedirect(url: String): XidSession'}</code>,
        ],
        [
          <code key="m">getSession</code>,
          <code key="s">{'suspend fun getSession(): XidSession?'}</code>,
        ],
        [
          <code key="m">getAccessToken</code>,
          <code key="s">
            {'suspend fun getAccessToken(options: GetAccessTokenOptions? = null): String'}
          </code>,
        ],
        [
          <code key="m">signOut</code>,
          <code key="s">
            {'suspend fun signOut(context: Context? = null, openEndSession: Boolean = false)'}
          </code>,
        ],
        [
          <code key="m">setTokenStorage</code>,
          <code key="s">fun setTokenStorage(adapter: TokenStorageAdapter)</code>,
        ],
      ],
    },
  },
  {
    heading: <Trans>Error types</Trans>,
    body: [<Trans>All SDK errors are subtypes of the sealed class XidException:</Trans>],
    table: {
      headers: [<Trans>Subclass</Trans>, <Trans>Trigger</Trans>],
      rows: [
        [<code key="e">NotConfigured</code>, <Trans>configure() was not called</Trans>],
        [
          <code key="e">UserCancelled</code>,
          <Trans>User closed Custom Tabs without completing</Trans>,
        ],
        [<code key="e">StateMismatch</code>, <Trans>OAuth state mismatch — possible CSRF</Trans>],
        [<code key="e">TokenExchangeFailed</code>, <Trans>Token endpoint returned an error</Trans>],
        [<code key="e">TokenRefreshFailed</code>, <Trans>Refresh token expired or revoked</Trans>],
        [<code key="e">NoSession</code>, <Trans>Session method called while signed out</Trans>],
      ],
    },
  },
  {
    heading: <Trans>Security</Trans>,
    bullets: [
      <Trans>Public client — no client secret stored or transmitted.</Trans>,
      <Trans>PKCE S256 only. Server rejects plain challenge method.</Trans>,
      <Trans>
        EncryptedSharedPreferences backed by Android Keystore (AES-256-GCM) protects the token store
        at rest.
      </Trans>,
      <Trans>
        Random OAuth state generated per request; validated on redirect to prevent CSRF.
      </Trans>,
    ],
  },
  {
    heading: <Trans>Known limitations</Trans>,
    bullets: [
      <Trans>
        JWKS-backed ID token verification is implemented and locally unit-tested. Android device or
        emulator and real IdP validation are still required before L4 support.
      </Trans>,
      <Trans>
        No mechanism to detect when the user closes Custom Tabs without completing authorization.
      </Trans>,
      <Trans>Single-account only — the storage layer uses fixed keys.</Trans>,
    ],
  },
]

export const ANDROID_DOC = defineSdkDoc({
  slug: 'sdks/android',
  packageName: 'sdk/android',
  summary: (
    <Trans>
      Kotlin SDK for Android using Chrome Custom Tabs, PKCE S256 authorization code flow, and
      Keystore-backed EncryptedSharedPreferences token storage.
    </Trans>
  ),
  sections,
})
