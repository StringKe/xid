package dev.xid.sdk

import android.content.Context
import android.net.Uri
import dev.xid.sdk.browser.AuthSession
import dev.xid.sdk.browser.CallbackResult
import dev.xid.sdk.guest.GuestAuthManager
import dev.xid.sdk.model.GetAccessTokenOptions
import dev.xid.sdk.model.OidcDiscovery
import dev.xid.sdk.model.SignInAnonymouslyOptions
import dev.xid.sdk.model.SignInOptions
import dev.xid.sdk.model.XidConfig
import dev.xid.sdk.model.XidException
import dev.xid.sdk.model.XidGuestSession
import dev.xid.sdk.model.XidSession
import dev.xid.sdk.pkce.PkceGenerator
import dev.xid.sdk.storage.EncryptedPrefsStorage
import dev.xid.sdk.storage.StorageKeys
import dev.xid.sdk.storage.TokenStorageAdapter
import dev.xid.sdk.token.TokenManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.TimeUnit

/**
 * XID Android SDK 入口。
 * 所有公开 API 均为挂起函数, 需在协程上下文中调用。
 *
 * 典型用法:
 * ```kotlin
 * // Application.onCreate 或 Activity/Fragment 中
 * Xid.configure(context, XidConfig(
 *     issuer = "https://xid.dev",
 *     clientId = "your_client_id",
 *     redirectUri = "https://yourapp.example.com/callback",
 * ))
 *
 * // 触发登录
 * lifecycleScope.launch {
 *     try {
 *         val session = Xid.signIn(activity)
 *         // 登录成功
 *     } catch (e: XidException.UserCancelled) {
 *         // 用户取消
 *     }
 * }
 *
 * // 在处理回调的 Activity 中(onNewIntent 或 onCreate)
 * lifecycleScope.launch {
 *     intent.data?.let { uri ->
 *         val session = Xid.handleRedirect(uri.toString())
 *     }
 * }
 * ```
 *
 * 注意:
 * - configure 必须在任何其他方法调用前完成。
 * - signIn 启动 Chrome Custom Tabs 后控制权转移给浏览器,
 *   回调通过 handleRedirect 在新 Intent 中处理。
 * - 本类是 object(单例), 不持有 Activity 引用, 避免内存泄漏。
 */
object Xid {

    private var config: XidConfig? = null
    private var storage: TokenStorageAdapter? = null
    private var discovery: OidcDiscovery? = null

    // 用于保护 discovery 缓存和 token 刷新的并发安全
    private val mutex = Mutex()

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    // ---------------------------------------------------------------------------
    // configure
    // ---------------------------------------------------------------------------

    /**
     * 初始化 SDK。必须在 Application.onCreate 或第一个 Activity.onCreate 调用。
     *
     * @param context  Android Application Context(不要传 Activity, 避免泄漏)。
     * @param config   SDK 配置选项([XidConfig])。
     */
    fun configure(context: Context, config: XidConfig) {
        this.config = config
        // 使用 Application Context 避免 Activity 内存泄漏
        this.storage = EncryptedPrefsStorage(
            context.applicationContext,
            requireBiometricUnlock = config.requireBiometricUnlock,
        )
        // discovery 延迟加载(第一次 signIn 或 getSession 时拉取)
        this.discovery = null
    }

    // ---------------------------------------------------------------------------
    // setTokenStorage
    // ---------------------------------------------------------------------------

    /**
     * 替换默认的 [EncryptedPrefsStorage] 为自定义存储适配器。
     * 必须在 [configure] 之后、[signIn] 之前调用。
     *
     * 典型用途: 单元测试中注入内存 mock、或集成第三方 Keystore 方案。
     *
     * @param adapter  自定义存储适配器, 实现 [TokenStorageAdapter]。
     */
    fun setTokenStorage(adapter: TokenStorageAdapter) {
        requireConfigured()
        this.storage = adapter
    }

    // ---------------------------------------------------------------------------
    // signIn
    // ---------------------------------------------------------------------------

    /**
     * 启动 OIDC Authorization Code + PKCE S256 登录流程。
     * 通过 Chrome Custom Tabs 打开 XID Hosted Auth 页面。
     *
     * 流程:
     * 1. 加载 OIDC discovery。
     * 2. 生成 PKCE code_verifier + code_challenge(S256)。
     * 3. 生成随机 state 防 CSRF。
     * 4. 启动 Chrome Custom Tabs 打开 /authorize。
     * 5. (异步)等待 App Links 或 custom scheme 回调。
     * 6. Activity 收到回调后调用 [handleRedirect]。
     *
     * 注意: 本方法在 Chrome Custom Tabs 启动后立即返回(协程挂起让给浏览器),
     * 实际 session 在 [handleRedirect] 中获取。
     *
     * @param context  当前 Activity Context(用于启动 Custom Tabs)。
     * @param options  可选 signIn 参数([SignInOptions])。
     */
    suspend fun signIn(context: Context, options: SignInOptions = SignInOptions()) {
        val cfg = requireConfigured()
        val disc = ensureDiscovery(cfg)
        val stor = storage!!

        val pkce = PkceGenerator.generate()
        val authSession = AuthSession(storage = stor, discovery = disc)
        authSession.launch(context = context, config = cfg, pkce = pkce, options = options)
        // 控制权转移到浏览器, 挂起函数此处返回
        // 实际 session 在 handleRedirect 回调中处理
    }

    // ---------------------------------------------------------------------------
    // signInAnonymously
    // ---------------------------------------------------------------------------

    /**
     * 匿名访客登录(Firebase 式 guest 模式)。
     *
     * 调用 POST {issuer}/auth/guest 建立服务端会话, 捕获 Set-Cookie 中的会话 cookie
     * 并持久化到安全存储, 再调 GET /v1/me 取回用户信息。
     *
     * 惰性语义: 本地已存在 guest 会话时直接返回, 不发任何网络请求。
     * guest 不签发 OAuth token, 返回 [XidGuestSession](cookie 会话), 与 OIDC 登录的
     * [XidSession] 分离; getSession/getAccessToken 不感知 guest 会话。
     *
     * 转正语义: guest 完成任一正式登录后 sub 不变, RP 数据自然延续; 若改登另一个
     * 既有账号, sub 会变, 调用方可对比前后 user.sub 判定。
     *
     * @param options  [SignInAnonymouslyOptions], 可携带 turnstileToken。
     * @return [XidGuestSession], user.isAnonymous 为 true。
     * @throws [XidException.GuestSignInFailed] 建号失败或 /v1/me 未返回用户。
     */
    suspend fun signInAnonymously(
        options: SignInAnonymouslyOptions = SignInAnonymouslyOptions(),
    ): XidGuestSession {
        val cfg = requireConfigured()
        val stor = storage!!

        // 串行化, 避免并发调用在本地无会话时重复建号
        return mutex.withLock {
            GuestAuthManager(storage = stor, issuer = cfg.issuer)
                .signInAnonymously(options.turnstileToken)
        }
    }

    // ---------------------------------------------------------------------------
    // handleRedirect
    // ---------------------------------------------------------------------------

    /**
     * 处理 App Links 或 custom scheme 的回调 URI。
     * 在 Activity.onNewIntent 或 onCreate 中调用(当 Intent.data 非空时)。
     *
     * @param url  回调 URI 字符串(来自 Intent.data.toString())。
     * @return 成功登录后的 [XidSession]。
     * @throws [XidException.StateMismatch]         state 不匹配(CSRF 防护)。
     * @throws [XidException.AuthorizationError]    授权失败(用户拒绝或参数错误)。
     * @throws [XidException.TokenExchangeFailed]   code 换 token 失败。
     */
    suspend fun handleRedirect(url: String): XidSession {
        val cfg = requireConfigured()
        val disc = ensureDiscovery(cfg)
        val stor = storage!!

        val uri = Uri.parse(url)
        val authSession = AuthSession(storage = stor, discovery = disc)
        val callbackResult = authSession.handleCallback(uri)

        return when (callbackResult) {
            is CallbackResult.Error -> throw callbackResult.exception
            is CallbackResult.Success -> {
                val tokenManager = TokenManager(storage = stor, discovery = disc)
                val session = tokenManager.exchangeCode(
                    code = callbackResult.code,
                    codeVerifier = callbackResult.codeVerifier,
                    clientId = cfg.clientId,
                    redirectUri = cfg.redirectUri,
                )
                // 正式登录成功后丢弃本地 guest 会话, 避免后续 signInAnonymously 复用旧身份
                GuestAuthManager.clear(stor)
                session
            }
        }
    }

    // ---------------------------------------------------------------------------
    // getSession
    // ---------------------------------------------------------------------------

    /**
     * 获取当前会话。如果 access token 过期且有 refresh token, 自动刷新。
     *
     * @return 当前 [XidSession], 或 null 表示未登录。
     */
    suspend fun getSession(): XidSession? {
        val cfg = config ?: return null
        val stor = storage ?: return null

        val disc = runCatching { ensureDiscovery(cfg) }.getOrNull() ?: return null
        val tokenManager = TokenManager(storage = stor, discovery = disc)

        val session = tokenManager.loadSession() ?: return null

        // access token 提前 30 秒视为过期, 避免边界情况
        val isExpired = session.accessTokenExpiresAt - System.currentTimeMillis() < 30_000L
        if (!isExpired) return session

        // 尝试刷新
        if (session.refreshToken == null) return null

        return runCatching {
            mutex.withLock { tokenManager.refresh(cfg.clientId) }
        }.getOrNull()
    }

    // ---------------------------------------------------------------------------
    // getAccessToken
    // ---------------------------------------------------------------------------

    /**
     * 获取当前有效的 access token(JWT 字符串)。
     * 如果 token 过期, 自动使用 refresh token 刷新。
     *
     * @param options  [GetAccessTokenOptions], 可强制刷新。
     * @return access token 字符串。
     * @throws [XidException.NoSession]          未登录。
     * @throws [XidException.TokenRefreshFailed] 刷新失败(refresh token 失效)。
     */
    suspend fun getAccessToken(options: GetAccessTokenOptions = GetAccessTokenOptions()): String {
        val cfg = requireConfigured()
        val stor = storage!!
        val disc = ensureDiscovery(cfg)
        val tokenManager = TokenManager(storage = stor, discovery = disc)

        val session = tokenManager.loadSession() ?: throw XidException.NoSession()

        val isExpired = session.accessTokenExpiresAt - System.currentTimeMillis() < 30_000L
        if (!options.forceRefresh && !isExpired) {
            return session.accessToken
        }

        if (session.refreshToken == null) throw XidException.NoSession()

        return mutex.withLock { tokenManager.refresh(cfg.clientId) }.accessToken
    }

    // ---------------------------------------------------------------------------
    // signOut
    // ---------------------------------------------------------------------------

    /**
     * 退出登录。清除本地所有持久化 token。
     *
     * 如果 OIDC discovery 包含 end_session_endpoint, 可选择打开浏览器完成
     * RP-initiated logout(清除 XID 侧的 SSO session)。
     *
     * @param context           Android Context(如需打开 end_session URL)。
     * @param openEndSession    是否通过 Chrome Custom Tabs 打开 end_session URL。
     *                          默认 false, 仅清除本地 token。
     */
    suspend fun signOut(context: Context? = null, openEndSession: Boolean = false) {
        val stor = storage ?: return
        val cfg = config

        // id_token_hint 必须在清除本地 token 之前读取
        val idTokenHint = stor.get(StorageKeys.ID_TOKEN)

        val tokenManager = cfg?.let {
            val disc = runCatching { ensureDiscovery(it) }.getOrNull()
            disc?.let { d -> TokenManager(storage = stor, discovery = d, clientId = it.clientId) }
        }

        tokenManager?.clearAll() ?: stor.clearAll()
        GuestAuthManager.clear(stor)

        // RP-initiated logout(可选): GET end_session + Custom Tabs
        if (openEndSession && context != null && cfg != null && idTokenHint != null) {
            val disc = runCatching { ensureDiscovery(cfg) }.getOrNull()
            disc?.endSessionEndpoint?.let { endSessionUrl ->
                val finalUri = Uri.parse(
                    buildEndSessionUrl(
                        endSessionEndpoint = endSessionUrl,
                        idTokenHint = idTokenHint,
                        postLogoutRedirectUri = cfg.postLogoutRedirectUri,
                    ),
                )
                val customTabsIntent = androidx.browser.customtabs.CustomTabsIntent.Builder()
                    .setShareState(androidx.browser.customtabs.CustomTabsIntent.SHARE_STATE_OFF)
                    .build()
                customTabsIntent.launchUrl(context, finalUri)
            }
        }
    }

    internal fun buildEndSessionUrl(
        endSessionEndpoint: String,
        idTokenHint: String,
        postLogoutRedirectUri: String?,
    ): String {
        val params = buildList {
            add("id_token_hint=${encodeQueryValue(idTokenHint)}")
            if (postLogoutRedirectUri != null) {
                add("post_logout_redirect_uri=${encodeQueryValue(postLogoutRedirectUri)}")
            }
        }
        val separator = if ('?' in endSessionEndpoint) '&' else '?'
        return endSessionEndpoint + separator + params.joinToString("&")
    }

    private fun encodeQueryValue(value: String): String =
        URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20")

    // ---------------------------------------------------------------------------
    // 内部辅助
    // ---------------------------------------------------------------------------

    private fun requireConfigured(): XidConfig {
        return config ?: throw XidException.NotConfigured()
    }

    /**
     * 懒加载并缓存 OIDC discovery 文档。
     * 线程安全: 通过 mutex 确保只发起一次 discovery 请求。
     */
    private suspend fun ensureDiscovery(cfg: XidConfig): OidcDiscovery {
        discovery?.let { return it }

        return mutex.withLock {
            // 双重检查, 避免 mutex 等待期间其他协程已完成 discovery
            discovery?.let { return@withLock it }

            val fetched = fetchDiscovery(cfg.issuer)
            discovery = fetched
            fetched
        }
    }

    private suspend fun fetchDiscovery(issuer: String): OidcDiscovery = withContext(Dispatchers.IO) {
        // issuer 不带末尾斜杠, 拼接标准 discovery URL
        val url = "${issuer.trimEnd('/')}/.well-known/openid-configuration"

        val request = Request.Builder()
            .url(url)
            .get()
            .header("Accept", "application/json")
            .build()

        val body = runCatching {
            httpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw XidException.DiscoveryFailed("HTTP ${response.code}")
                }
                response.body?.string() ?: throw XidException.DiscoveryFailed("响应体为空")
            }
        }.getOrElse { e ->
            throw XidException.DiscoveryFailed(e.message ?: "未知错误", e)
        }

        runCatching {
            json.decodeFromString<OidcDiscovery>(body)
        }.getOrElse { e ->
            throw XidException.DiscoveryFailed("解析 discovery 文档失败", e)
        }
    }
}
