package dev.xid.sdk.browser

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import androidx.browser.customtabs.CustomTabsServiceConnection
import dev.xid.sdk.model.OidcDiscovery
import dev.xid.sdk.model.SignInOptions
import dev.xid.sdk.model.XidConfig
import dev.xid.sdk.model.XidException
import dev.xid.sdk.pkce.PkcePair
import dev.xid.sdk.pkce.PkceCore
import dev.xid.sdk.storage.StorageKeys
import dev.xid.sdk.storage.TokenStorageAdapter

/**
 * 管理 Chrome Custom Tabs 授权会话。
 *
 * 职责:
 * - 构建 /authorize URL(携带 PKCE S256 参数、state 防 CSRF)。
 * - 启动 Chrome Custom Tabs。
 * - 持久化 PKCE state + verifier(防进程被回收后丢失)。
 * - 解析回调 URI 并校验 state。
 *
 * 回调接收方式:
 * 在 AndroidManifest.xml 中为处理回调的 Activity 注册 intent-filter:
 *   - App Links(推荐): https scheme + android:autoVerify="true"
 *   - Custom Scheme(备选): 如 "xid.yourapp://callback"
 * 收到 Intent 后调用 [dev.xid.sdk.Xid.handleRedirect]。
 */
internal class AuthSession(
    private val storage: TokenStorageAdapter,
    private val discovery: OidcDiscovery,
) {

    /**
     * 构建授权 URL 并通过 Chrome Custom Tabs 启动。
     *
     * @param context   Android Context(用于启动 Activity)。
     * @param config    XID SDK 配置。
     * @param pkce      PKCE 参数对。
     * @param options   signIn 选项(login_hint、prompt 等)。
     * @return 生成的 state 字符串, 存储于 EncryptedSharedPreferences 供回调时校验。
     */
    suspend fun launch(
        context: Context,
        config: XidConfig,
        pkce: PkcePair,
        options: SignInOptions,
    ): String {
        val state = PkceCore.generateNonce()
        val nonce = PkceCore.generateNonce()

        // 持久化授权临时数据, 防止 Activity 被系统回收后丢失
        storage.set(StorageKeys.PKCE_STATE, state)
        storage.set(StorageKeys.PKCE_VERIFIER, pkce.verifier)
        storage.set(StorageKeys.OIDC_NONCE, nonce)

        val authUrl = buildAuthorizationUrl(config, pkce, state, nonce, options)

        warmupCustomTabs(context)

        val customTabsIntent = CustomTabsIntent.Builder()
            .setShowTitle(false)
            // 允许用户在 Custom Tabs 内后退到 app -- 安全考量: 不启用共享 cookie jar
            .setShareState(CustomTabsIntent.SHARE_STATE_OFF)
            .build()

        // CustomTabsIntent.launchUrl 在 API 33+ 推荐传 Context; 旧版也兼容
        customTabsIntent.intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        customTabsIntent.launchUrl(context, Uri.parse(authUrl))

        return state
    }

    /**
     * 解析回调 URI, 校验 state, 返回 authorization code。
     *
     * @param uri       来自 Activity.intent.data 的回调 URI。
     * @return 解析后的 [CallbackResult]。
     */
    suspend fun handleCallback(uri: Uri): CallbackResult {
        val error = uri.getQueryParameter("error")
        if (error != null) {
            val desc = uri.getQueryParameter("error_description")
            return CallbackResult.Error(XidException.AuthorizationError(error, desc))
        }

        val returnedState = uri.getQueryParameter("state")
        val storedState = storage.get(StorageKeys.PKCE_STATE)

        // state 校验: 防止 CSRF / open redirect; 委托给 PkceCore.isStateValid
        if (!dev.xid.sdk.pkce.PkceCore.isStateValid(returnedState, storedState)) {
            return CallbackResult.Error(XidException.StateMismatch())
        }

        val code = uri.getQueryParameter("code")
            ?: return CallbackResult.Error(
                XidException.AuthorizationError("missing_code", "回调 URI 缺少 code 参数")
            )

        val verifier = storage.get(StorageKeys.PKCE_VERIFIER)
            ?: return CallbackResult.Error(
                XidException.AuthorizationError("missing_verifier", "PKCE verifier 已丢失, 请重新登录")
            )
        val nonce = storage.get(StorageKeys.OIDC_NONCE)
            ?: return CallbackResult.Error(
                XidException.AuthorizationError("missing_nonce", "OIDC nonce 已丢失, 请重新登录")
            )

        return CallbackResult.Success(code = code, codeVerifier = verifier, nonce = nonce)
    }

    /**
     * 预热 Chrome Custom Tabs 服务连接,减少首次打开授权页的冷启动延迟。
     * best-effort:无可用浏览器时静默跳过。
     */
    private fun warmupCustomTabs(context: Context) {
        val packageName = CustomTabsClient.getPackageName(context, null) ?: return
        CustomTabsClient.bindCustomTabsService(
            context,
            packageName,
            object : CustomTabsServiceConnection() {
                override fun onCustomTabsServiceConnected(
                    name: ComponentName,
                    client: CustomTabsClient,
                ) {
                    client.warmup(0L)
                    context.unbindService(this)
                }

                override fun onServiceDisconnected(name: ComponentName?) = Unit
            },
        )
    }

    // ---------------------------------------------------------------------------
    // URL 构建
    // ---------------------------------------------------------------------------

    private fun buildAuthorizationUrl(
        config: XidConfig,
        pkce: PkcePair,
        state: String,
        nonce: String,
        options: SignInOptions,
    ): String {
        val builder = Uri.parse(discovery.authorizationEndpoint).buildUpon()

        val reservedParameters = setOf(
            "response_type",
            "client_id",
            "redirect_uri",
            "scope",
            "state",
            "nonce",
            "code_challenge",
            "code_challenge_method",
        )
        config.additionalParameters
            .filterKeys { it !in reservedParameters }
            .forEach { (k, v) ->
                builder.appendQueryParameter(k, v)
            }
        builder.appendQueryParameter("response_type", "code")
        builder.appendQueryParameter("client_id", config.clientId)
        builder.appendQueryParameter("redirect_uri", config.redirectUri)
        builder.appendQueryParameter("scope", config.scopes.joinToString(" "))
        builder.appendQueryParameter("state", state)
        builder.appendQueryParameter("nonce", nonce)
        builder.appendQueryParameter("code_challenge", pkce.challenge)
        builder.appendQueryParameter("code_challenge_method", "S256")

        options.loginHint?.let { builder.appendQueryParameter("login_hint", it) }
        options.prompt?.let { builder.appendQueryParameter("prompt", it) }
        options.organization?.let { builder.appendQueryParameter("organization", it) }

        return builder.build().toString()
    }
}

/**
 * 授权回调解析结果。
 */
internal sealed class CallbackResult {
    data class Success(
        val code: String,
        val codeVerifier: String,
        val nonce: String,
    ) : CallbackResult()
    data class Error(val exception: XidException) : CallbackResult()
}
