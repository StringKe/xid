package dev.xid.sdk.guest

import dev.xid.sdk.model.GuestCapabilityResponse
import dev.xid.sdk.model.GuestSessionResponse
import dev.xid.sdk.model.MeResponse
import dev.xid.sdk.model.MeUser
import dev.xid.sdk.model.PROVISIONED_BY_ANONYMOUS
import dev.xid.sdk.model.XidException
import dev.xid.sdk.model.XidGuestSession
import dev.xid.sdk.model.XidUser
import dev.xid.sdk.storage.StorageKeys
import dev.xid.sdk.storage.TokenStorageAdapter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.util.concurrent.TimeUnit

/**
 * 匿名访客(Firebase 式 guest)登录。
 *
 * 与 OIDC token 流程的差异:
 * - 每次真正建号先从 /auth/config?intent=sign-up 获取一次性 capability, 不缓存或复用。
 * - guest 不签发 access/refresh/id token, 会话凭证是 /auth/guest 通过 Set-Cookie 下发的
 *   服务端 session cookie。OkHttp 默认不持久化 cookie, 因此显式捕获 Set-Cookie 并存入
 *   [TokenStorageAdapter](底层加密存储), 后续 /v1/me 请求以 Cookie header 重放。
 * - 惰性语义: 本地已有 guest 会话时直接返回, 不发任何网络请求(Firebase signInAnonymously 语义)。
 */
internal class GuestAuthManager(
    private val storage: TokenStorageAdapter,
    issuer: String,
) {
    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    private val baseUrl = issuer.trimEnd('/')

    /**
     * 建立或复用 guest 会话。
     *
     * @param turnstileToken  Turnstile token(仅服务端启用 Turnstile 时需要)。
     * @throws [XidException.GuestSignInFailed] 建号失败、响应缺会话 cookie 或 /v1/me 未返回用户。
     */
    suspend fun signInAnonymously(turnstileToken: String? = null): XidGuestSession =
        withContext(Dispatchers.IO) {
            loadSession()?.let { return@withContext it }

            val capabilityToken = requestGuestCapability()
            val (sessionId, cookies) = requestGuestSession(capabilityToken, turnstileToken)
            val me = fetchMe(cookies)
            val user = me.toXidUser()

            persist(sessionId, cookies, me.copy(provisionedBy = user.provisionedBy))
            XidGuestSession(user = user, sessionId = sessionId)
        }

    /** 从持久化存储恢复 guest 会话, 不做网络校验(惰性语义只要求本地判定)。 */
    suspend fun loadSession(): XidGuestSession? {
        val sessionId = storage.get(StorageKeys.GUEST_SESSION_ID) ?: return null
        storage.get(StorageKeys.GUEST_SESSION_COOKIES) ?: return null
        val userJson = storage.get(StorageKeys.GUEST_USER) ?: return null
        val me = runCatching { json.decodeFromString<MeUser>(userJson) }.getOrNull() ?: return null
        return XidGuestSession(user = me.toXidUser(), sessionId = sessionId)
    }

    private suspend fun persist(sessionId: String, cookies: String, me: MeUser) {
        try {
            storage.set(StorageKeys.GUEST_SESSION_ID, sessionId)
            storage.set(StorageKeys.GUEST_SESSION_COOKIES, cookies)
            storage.set(StorageKeys.GUEST_USER, json.encodeToString(MeUser.serializer(), me))
        } catch (error: Exception) {
            try {
                clear(storage)
            } catch (cleanupError: Exception) {
                error.addSuppressed(cleanupError)
            }
            throw error
        }
    }

    private fun requestGuestCapability(): String {
        val request = Request.Builder()
            .url("$baseUrl/auth/config?intent=sign-up")
            .get()
            .header("Accept", "application/json")
            .build()

        return try {
            httpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw XidException.GuestSignInFailed("/auth/config 返回 HTTP ${response.code}")
                }
                val body = response.body?.string()
                    ?: throw XidException.GuestSignInFailed("/auth/config 响应体为空")
                val token = runCatching {
                    json.decodeFromString<GuestCapabilityResponse>(body).guest?.capabilityToken
                }.getOrElse { error ->
                    throw XidException.GuestSignInFailed("解析 guest capability 失败", error)
                }
                token?.takeIf { it.isNotBlank() }
                    ?: throw XidException.GuestSignInFailed("guest capability 不可用")
            }
        } catch (e: XidException) {
            throw e
        } catch (e: Exception) {
            throw XidException.NetworkError("guest capability 请求失败", e)
        }
    }

    private fun requestGuestSession(
        capabilityToken: String,
        turnstileToken: String?,
    ): Pair<String, String> {
        val bodyJson = buildJsonObject {
            put("capabilityToken", capabilityToken)
            turnstileToken?.let { put("turnstileToken", it) }
        }.toString()

        val request = Request.Builder()
            .url("$baseUrl/auth/guest")
            .post(bodyJson.toRequestBody("application/json".toMediaType()))
            .header("Accept", "application/json")
            .build()

        return try {
            httpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw XidException.GuestSignInFailed("HTTP ${response.code}")
                }
                val bodyStr = response.body?.string()
                    ?: throw XidException.GuestSignInFailed("响应体为空")
                val sessionId = runCatching {
                    json.decodeFromString<GuestSessionResponse>(bodyStr).sessionId
                }.getOrElse { e -> throw XidException.GuestSignInFailed("解析 sessionId 失败", e) }
                // 会话 cookie 是 native 端唯一的会话凭证, 缺失则后续 /v1/me 必然 401
                val cookies = captureCookies(response)
                    ?: throw XidException.GuestSignInFailed("响应未携带会话 cookie")
                sessionId to cookies
            }
        } catch (e: XidException) {
            throw e
        } catch (e: Exception) {
            throw XidException.NetworkError("guest 登录请求失败", e)
        }
    }

    private fun fetchMe(cookies: String): MeUser {
        val request = Request.Builder()
            .url("$baseUrl/v1/me")
            .get()
            .header("Accept", "application/json")
            .header("Cookie", cookies)
            .build()

        val bodyStr = try {
            httpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw XidException.GuestSignInFailed("/v1/me 返回 HTTP ${response.code}")
                }
                response.body?.string() ?: throw XidException.GuestSignInFailed("/v1/me 响应体为空")
            }
        } catch (e: XidException) {
            throw e
        } catch (e: Exception) {
            throw XidException.NetworkError("/v1/me 请求失败", e)
        }

        val me = runCatching { json.decodeFromString<MeResponse>(bodyStr) }
            .getOrElse { e -> throw XidException.GuestSignInFailed("解析 /v1/me 响应失败", e) }
        return me.user ?: throw XidException.GuestSignInFailed("/v1/me 未返回用户")
    }

    /** Set-Cookie 带属性(Path/HttpOnly 等), 重放时只保留 name=value 对。 */
    private fun captureCookies(response: Response): String? {
        val pairs = response.headers("Set-Cookie")
            .map { it.substringBefore(';').trim() }
            .filter { it.isNotEmpty() }
        return pairs.takeIf { it.isNotEmpty() }?.joinToString("; ")
    }

    private fun MeUser.toXidUser(): XidUser = XidUser(
        sub = id,
        email = email?.takeIf { it.isNotBlank() },
        emailVerified = emailVerified ?: false,
        name = name,
        picture = imageUrl,
        // guest 流程建立的会话必然是 anonymous 账号;/v1/me 返回的 provisioned_by 为 null 时以此兜底
        provisionedBy = provisionedBy ?: PROVISIONED_BY_ANONYMOUS,
    )

    companion object {
        /** 清除持久化的 guest 会话(signOut 与正式登录成功时调用)。 */
        suspend fun clear(storage: TokenStorageAdapter) {
            storage.clear(StorageKeys.GUEST_SESSION_ID)
            storage.clear(StorageKeys.GUEST_SESSION_COOKIES)
            storage.clear(StorageKeys.GUEST_USER)
        }
    }
}
