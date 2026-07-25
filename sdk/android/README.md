# XID Android SDK

> **Status: implemented (verified locally)**
> 本机 `gradle testDebugUnitTest` 全部 PASS(JVM 单测,见 `docs/sdks/platform-matrix.md`)。
> 真实 IdP round-trip(L4)尚未验证,生产集成前请完成下方"后续增强"项。

XID 身份平台的 Android 原生 SDK。基于 Chrome Custom Tabs 实现 OIDC Authorization Code + PKCE S256 授权流程, 使用 EncryptedSharedPreferences(Keystore 支撑)安全存储 token。

---

## 安装

在 app 模块的 `build.gradle.kts` 中添加依赖:

```kotlin
dependencies {
    implementation("dev.xid:xid-android:0.1.0-alpha")
}
```

目前尚未发布到 Maven Central, 本地调试方式:

```kotlin
// settings.gradle.kts
includeBuild("../sdk/android")  // 或通过 maven-publish 发布到本地仓库
```

---

## AndroidManifest.xml 配置

在 app 模块的 `AndroidManifest.xml` 中为处理回调的 Activity 添加 intent-filter。

### 推荐: App Links (HTTPS scheme)

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

同时在 `yourapp.example.com/.well-known/assetlinks.json` 中声明 app 的 SHA-256 指纹。

### 备选: Custom Scheme

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

---

## 最小用法示例

### 1. 初始化

在 `Application.onCreate` 中调用:

```kotlin
class MyApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Xid.configure(
            context = this,
            config = XidConfig(
                issuer = "https://xid.dev",           // 或自托管 issuer
                clientId = "your_client_id",
                redirectUri = "https://yourapp.example.com/auth/callback",
                scopes = listOf("openid", "profile", "email", "offline_access"),
            )
        )
    }
}
```

### 2. 登录

```kotlin
// Fragment 或 Activity 中
lifecycleScope.launch {
    try {
        Xid.signIn(requireContext())
        // signIn 启动浏览器后立即返回
        // 实际 session 在 handleRedirect 中获取
    } catch (e: XidException.NotConfigured) {
        // SDK 未初始化
    }
}
```

### 3. 处理回调

在回调 Activity 中:

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
                // 登录成功, 跳转主页
                startActivity(Intent(this@AuthCallbackActivity, MainActivity::class.java))
                finish()
            } catch (e: XidException.UserCancelled) {
                finish()
            } catch (e: XidException.StateMismatch) {
                // 可能遭受 CSRF 攻击, 记录日志并拒绝
                finish()
            } catch (e: XidException) {
                // 其他错误处理
            }
        }
    }
}
```

### 4. 获取当前会话

```kotlin
lifecycleScope.launch {
    val session = Xid.getSession()
    if (session != null) {
        val user = session.user
        println("已登录: ${user.email}")
    } else {
        // 未登录, 跳转登录页
    }
}
```

### 5. 获取 Access Token

```kotlin
lifecycleScope.launch {
    try {
        val token = Xid.getAccessToken()
        // 用于 API 请求的 Authorization: Bearer header
    } catch (e: XidException.NoSession) {
        // 未登录
    } catch (e: XidException.TokenRefreshFailed) {
        // refresh token 失效, 需重新登录
    }
}
```

### 6. 退出登录

```kotlin
lifecycleScope.launch {
    // 仅清除本地 token
    Xid.signOut()

    // 或同时通过浏览器清除 XID SSO session
    Xid.signOut(context = this@MainActivity, openEndSession = true)
}
```

### 7. 自定义存储适配器

```kotlin
// 在 configure 之后调用。替换为应用的加密持久化实现后再启用。
Xid.setTokenStorage(object : TokenStorageAdapter {
    override suspend fun get(key: String): String? =
        throw UnsupportedOperationException("Provide encrypted token storage")
    override suspend fun set(key: String, value: String) =
        throw UnsupportedOperationException("Provide encrypted token storage")
    override suspend fun clear(key: String) =
        throw UnsupportedOperationException("Provide encrypted token storage")
    override suspend fun clearAll() =
        throw UnsupportedOperationException("Provide encrypted token storage")
})
```

---

## API 参考

| 方法              | 签名                                                                 | 说明                                  |
| ----------------- | -------------------------------------------------------------------- | ------------------------------------- |
| `configure`       | `fun configure(context: Context, config: XidConfig)`                 | 初始化 SDK, Application.onCreate 调用 |
| `setTokenStorage` | `fun setTokenStorage(adapter: TokenStorageAdapter)`                  | 替换默认安全存储                      |
| `signIn`          | `suspend fun signIn(context: Context, options: SignInOptions)`       | 启动 Chrome Custom Tabs 授权          |
| `handleRedirect`  | `suspend fun handleRedirect(url: String): XidSession`                | 处理回调 URI, 完成 code 交换          |
| `getSession`      | `suspend fun getSession(): XidSession?`                              | 获取当前会话(自动刷新)                |
| `getAccessToken`  | `suspend fun getAccessToken(options: GetAccessTokenOptions): String` | 获取 access token(自动刷新)           |
| `signOut`         | `suspend fun signOut(context, openEndSession)`                       | 清除本地 token, 可选打开 end_session  |

### 错误类型(sealed class XidException)

| 子类                    | 触发场景                            |
| ----------------------- | ----------------------------------- |
| `NotConfigured`         | configure() 未调用                  |
| `DiscoveryFailed`       | OIDC discovery 请求失败             |
| `UserCancelled`         | 用户关闭 Custom Tabs                |
| `AuthorizationError`    | 授权服务端返回错误                  |
| `StateMismatch`         | state 不匹配(CSRF 防护)             |
| `TokenExchangeFailed`   | /token 端点返回错误                 |
| `TokenRefreshFailed`    | refresh token 失效                  |
| `NoSession`             | 未登录状态调用需要会话的方法        |
| `StorageError`          | EncryptedSharedPreferences 读写失败 |
| `NetworkError`          | 网络请求失败                        |
| `TokenValidationFailed` | JWT 验证失败                        |

---

## 安全说明

- public client: 不存储 client secret, 完全符合 OAuth 2.0 public client 规范。
- PKCE S256: 每次登录生成新的随机 code_verifier(64 字节), 仅支持 S256 方法。
- state 防 CSRF: 每次授权请求生成随机 state, 回调时严格校验。
- 安全存储: EncryptedSharedPreferences 底层使用 Android Keystore(AES-256-GCM)加密。
- refresh token rotation: 每次刷新服务端返回新 refresh token, 旧 token 立即废弃。

---

## 已实现的增强能力

1. **JWT 签名验证** -- `IdTokenVerifier`(nimbus-jose-jwt) + JWKS,校验 iss/aud/exp/iat
2. **Custom Tabs 预热** -- `AuthSession.warmupCustomTabs`
3. **Biometric 解锁** -- `XidConfig.requireBiometricUnlock` → `EncryptedPrefsStorage`
4. **RP-initiated logout** -- `signOut(openEndSession=true)` 携带 `id_token_hint` + `post_logout_redirect_uri`, 经 `CustomTabsIntent` 打开

---

## 后续增强(生产前建议)

1. **Certificate Pinning**: OkHttpClient 启用 `CertificatePinner`, 固定 SPKI 指纹。
2. **UserCancelled 检测**: Custom Tabs 用户主动返回未完成授权时的回调。
3. **单元测试扩充**: 添加 Robolectric 依赖, 完成 TokenManager mock 网络测试。
4. **nonce 支持**: 在 signIn 时生成 nonce 并在 JWT 验证时校验。
5. **多账户支持**: 当前存储层使用固定 key, 不支持同一设备多账户切换。
6. **L4 round-trip**: 真实 IdP 端到端验证。

---

## 最低要求

- Android API 26+(Android 8.0)
- Kotlin 1.9+
- AndroidX

---

## 目录结构

```
sdk/android/
  build.gradle.kts                          Gradle 模块配置 + 依赖声明
  settings.gradle.kts                       Gradle 设置
  consumer-rules.pro                        ProGuard/R8 规则(随 AAR 传递)
  src/main/AndroidManifest.xml              库 manifest
  src/main/kotlin/dev/xid/sdk/
    Xid.kt                                  SDK 入口 object -- 所有公开 API
    model/XidModels.kt                      数据模型 + 错误类型
    pkce/PkceGenerator.kt                   PKCE S256 code_verifier/code_challenge 生成
    storage/TokenStorage.kt                 TokenStorageAdapter 接口 + StorageKeys
    storage/EncryptedPrefsStorage.kt        默认实现(EncryptedSharedPreferences)
    token/TokenManager.kt                   code 交换 + refresh + 会话重建
    browser/AuthSession.kt                  Chrome Custom Tabs + 授权 URL 构建 + 回调解析
  src/test/kotlin/dev/xid/sdk/
    PkceGeneratorTest.kt                    PKCE 生成器单元测试(部分)
```
