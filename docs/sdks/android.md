# Android Kotlin SDK

**Status: implemented.** `sdk/android` has a complete Gradle module with source, unit tests, and workspace config; `gradle testDebugUnitTest` passes (JVM unit tests). Real IdP round-trip (L4) and Android device/emulator testing are pending.

This SDK is distributed as source inside the repository. It is not published to Maven Central or any other registry.

## What is implemented

- Chrome Custom Tabs-based Hosted Auth + OIDC Authorization Code + PKCE S256 flow
- `Xid.configure` / `signIn` / `handleRedirect` / `getSession` / `getAccessToken` / `signOut` / `setTokenStorage`
- EncryptedSharedPreferences (Android Keystore AES-256-GCM) backed token storage
- `TokenStorageAdapter` interface for custom storage backends
- state parameter CSRF guard in `handleRedirect`
- Sealed `XidException` hierarchy covering all error paths

## Install

There is no Maven coordinate to depend on. Vendor `sdk/android` into your project (or check out this repository next to it) and include the build:

```kotlin
// settings.gradle.kts
includeBuild("../sdk/android")
```

Then depend on the included module from your app module's `build.gradle.kts`.

## AndroidManifest.xml

### App Links (HTTPS scheme, recommended)

```xml
<activity android:name=".AuthCallbackActivity" android:exported="true">
    <intent-filter android:autoVerify="true">
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data
            android:scheme="https"
            android:host="yourapp.example.com"
            android:pathPrefix="/auth/callback" />
    </intent-filter>
</activity>
```

### Custom Scheme (fallback)

```xml
<activity android:name=".AuthCallbackActivity" android:exported="true">
    <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="xid.yourapp" android:host="callback" />
    </intent-filter>
</activity>
```

## Quickstart

### 1. Configure

```kotlin
class MyApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Xid.configure(
            context = this,
            config = XidConfig(
                issuer = "https://xid.dev",
                clientId = "your_client_id",
                redirectUri = "https://yourapp.example.com/auth/callback",
                scopes = listOf("openid", "profile", "email", "offline_access"),
            )
        )
    }
}
```

### 2. Sign in

```kotlin
lifecycleScope.launch {
    try {
        Xid.signIn(requireContext())
    } catch (e: XidException.NotConfigured) {
        // SDK not configured
    }
}
```

### 3. Handle redirect

```kotlin
class AuthCallbackActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent) {
        val uri = intent.data ?: return
        lifecycleScope.launch {
            try {
                val session = Xid.handleRedirect(uri.toString())
                startActivity(Intent(this@AuthCallbackActivity, MainActivity::class.java))
                finish()
            } catch (e: XidException.UserCancelled) {
                finish()
            } catch (e: XidException.StateMismatch) {
                finish()
            } catch (e: XidException) {
                // handle error
            }
        }
    }
}
```

### 4. Get session / access token / sign out

```kotlin
val session = Xid.getSession()
val token = Xid.getAccessToken()
Xid.signOut()
Xid.signOut(context = this@MainActivity, openEndSession = true)
```

## API reference

| Method            | Signature                                                            | Description                                     |
| ----------------- | -------------------------------------------------------------------- | ----------------------------------------------- |
| `configure`       | `fun configure(context: Context, config: XidConfig)`                 | Initialize SDK in Application.onCreate          |
| `setTokenStorage` | `fun setTokenStorage(adapter: TokenStorageAdapter)`                  | Replace default secure storage                  |
| `signIn`          | `suspend fun signIn(context: Context, options: SignInOptions)`       | Launch Chrome Custom Tabs authorization         |
| `handleRedirect`  | `suspend fun handleRedirect(url: String): XidSession`                | Handle callback URI, complete code exchange     |
| `getSession`      | `suspend fun getSession(): XidSession?`                              | Get current session (auto-refresh)              |
| `getAccessToken`  | `suspend fun getAccessToken(options: GetAccessTokenOptions): String` | Get access token (auto-refresh)                 |
| `signOut`         | `suspend fun signOut(context, openEndSession)`                       | Clear local tokens, optionally open end_session |

### Error types (sealed class XidException)

| Subclass                | Trigger                                         |
| ----------------------- | ----------------------------------------------- |
| `NotConfigured`         | configure() not called                          |
| `DiscoveryFailed`       | OIDC discovery request failed                   |
| `UserCancelled`         | User closed Custom Tabs                         |
| `AuthorizationError`    | Authorization server returned error             |
| `StateMismatch`         | state mismatch (CSRF guard)                     |
| `TokenExchangeFailed`   | /token endpoint returned error                  |
| `TokenRefreshFailed`    | Refresh token invalid                           |
| `NoSession`             | Session-required method called while signed out |
| `StorageError`          | EncryptedSharedPreferences read/write failed    |
| `NetworkError`          | Network request failed                          |
| `TokenValidationFailed` | JWT validation failed                           |

## Security

- Public client: no client secret stored.
- PKCE S256: 64-byte random code_verifier; S256 only.
- State CSRF guard: random state per authorization request, validated in handleRedirect.
- Secure storage: EncryptedSharedPreferences backed by Android Keystore (AES-256-GCM).
- Refresh token rotation: server issues new refresh token on each use; old token is immediately invalidated.

## Known limits (pending before production use)

- **JWT signature verification**: `TokenManager.parseUserFromIdToken` decodes payload only; does not verify signature. JWKS fetch + ES256/RS256 verification must be added before production.
- **Chrome Custom Tabs warmup**: `CustomTabsClient.warmup` not yet called; increases cold-start latency.
- **Certificate pinning**: no `CertificatePinner` on OkHttpClient.
- **Biometric unlock**: `EncryptedPrefsStorage` does not set `setUserAuthenticationRequired(true)`.
- **UserCancelled detection**: no mechanism to detect user pressing back in Custom Tabs without completing authorization.
- **end_session URL bug**: `post_logout_redirect_uri` parameter construction in `Xid.signOut` has a bug.
- **end_session via CustomTabsIntent**: `signOut` uses a bare Intent instead of `CustomTabsIntent`.
- **nonce support**: nonce not generated on signIn or validated on token receipt.
- **Multi-account support**: storage uses fixed keys; multiple accounts on one device not supported.
- **`EncryptedSharedPreferences` / `CustomTabs` / `App Links`**: require Android device or emulator to verify; not covered by JVM unit tests.

## Minimum requirements

- Android API 26+ (Android 8.0)
- Kotlin 1.9+
- AndroidX

## Source layout

```
sdk/android/
  build.gradle.kts
  settings.gradle.kts
  consumer-rules.pro
  src/main/AndroidManifest.xml
  src/main/kotlin/dev/xid/sdk/
    Xid.kt                       SDK entry object -- all public API
    model/XidModels.kt           Data models + error types
    pkce/PkceGenerator.kt        PKCE S256 code_verifier/code_challenge
    storage/TokenStorage.kt      TokenStorageAdapter interface + StorageKeys
    storage/EncryptedPrefsStorage.kt  Default implementation (EncryptedSharedPreferences)
    token/TokenManager.kt        Code exchange + refresh + session reconstruction
    browser/AuthSession.kt       Chrome Custom Tabs + authorization URL + callback parsing
  src/test/kotlin/dev/xid/sdk/
    PkceGeneratorTest.kt
    StateValidationTest.kt
    TokenStorageInMemoryTest.kt
```
