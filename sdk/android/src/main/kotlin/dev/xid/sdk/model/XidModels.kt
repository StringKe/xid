package dev.xid.sdk.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * XID SDK 配置选项。
 * 通过 [dev.xid.sdk.Xid.configure] 传入。
 *
 * @param issuer        XID issuer URL, 例如 "https://xid.dev" 或自托管域名。
 * @param clientId      OAuth2 public client ID(不含 secret)。
 * @param redirectUri   授权回调 URI, 必须与控制台注册的值精确匹配。
 *                      推荐使用 App Links(https scheme)或自定义 scheme。
 * @param scopes        请求的 OAuth2 scope 列表, 必须包含 "openid"。
 * @param postLogoutRedirectUri  退出后回调 URI(可选)。
 * @param additionalParameters  附加到 /authorize 请求的额外参数(可选)。
 * @param requireBiometricUnlock  为 true 时 EncryptedSharedPreferences 要求生物识别解锁 Keystore key。
 */
data class XidConfig(
    val issuer: String,
    val clientId: String,
    val redirectUri: String,
    val scopes: List<String> = listOf("openid", "profile", "email", "offline_access"),
    val postLogoutRedirectUri: String? = null,
    val additionalParameters: Map<String, String> = emptyMap(),
    val requireBiometricUnlock: Boolean = false,
) {
    init {
        require(issuer.startsWith("https://")) { "issuer 必须以 https:// 开头" }
        require(clientId.isNotBlank()) { "clientId 不能为空" }
        require(redirectUri.isNotBlank()) { "redirectUri 不能为空" }
        require("openid" in scopes) { "scopes 必须包含 openid" }
    }
}

/**
 * signIn 调用选项。
 *
 * @param loginHint     预填邮箱/用户名(可选, 传给 /authorize 的 login_hint)。
 * @param prompt        OIDC prompt 参数(可选, 如 "consent" 或 "login")。
 * @param organization  org hint(可选, 传给 /authorize 的 organization 参数)。
 */
data class SignInOptions(
    val loginHint: String? = null,
    val prompt: String? = null,
    val organization: String? = null,
)

/**
 * getAccessToken 调用选项。
 *
 * @param forceRefresh  强制刷新 token, 即使当前 token 未过期。
 */
data class GetAccessTokenOptions(
    val forceRefresh: Boolean = false,
)

/**
 * 当前登录会话。
 *
 * @param user          已登录用户信息(来自 OIDC userinfo 或 ID token claims)。
 * @param accessToken   当前 access token(JWT)。
 * @param accessTokenExpiresAt  access token 过期时间(Unix epoch ms)。
 * @param refreshToken  refresh token(存储于 EncryptedSharedPreferences, 此字段内存临时持有)。
 * @param idToken       ID token 原始字符串。
 */
data class XidSession(
    val user: XidUser,
    val accessToken: String,
    val accessTokenExpiresAt: Long,
    val refreshToken: String?,
    val idToken: String,
)

/**
 * 用户基本信息, 从 ID token claims 提取。
 *
 * @param sub           subject identifier(唯一用户 ID)。
 * @param email         邮箱(可能为 null, 取决于 scope)。
 * @param emailVerified 邮箱是否已验证。
 * @param name          显示名称。
 * @param picture       头像 URL。
 * @param organization  当前 org ID(如果 token 包含 org 信息)。
 */
data class XidUser(
    val sub: String,
    val email: String? = null,
    val emailVerified: Boolean = false,
    val name: String? = null,
    val picture: String? = null,
    val organization: String? = null,
)

// ---------------------------------------------------------------------------
// OIDC Discovery 和 Token 端点响应的序列化模型
// ---------------------------------------------------------------------------

/** OIDC discovery 文档(/.well-known/openid-configuration 响应子集)。*/
@Serializable
internal data class OidcDiscovery(
    @SerialName("issuer") val issuer: String,
    @SerialName("authorization_endpoint") val authorizationEndpoint: String,
    @SerialName("token_endpoint") val tokenEndpoint: String,
    @SerialName("userinfo_endpoint") val userinfoEndpoint: String? = null,
    @SerialName("jwks_uri") val jwksUri: String,
    @SerialName("end_session_endpoint") val endSessionEndpoint: String? = null,
    @SerialName("scopes_supported") val scopesSupported: List<String>? = null,
    @SerialName("response_types_supported") val responseTypesSupported: List<String>? = null,
    @SerialName("code_challenge_methods_supported") val codeChallengeMethodsSupported: List<String>? = null,
)

/** /token 端点成功响应。*/
@Serializable
internal data class TokenResponse(
    @SerialName("access_token") val accessToken: String,
    @SerialName("token_type") val tokenType: String,
    @SerialName("expires_in") val expiresIn: Int,
    @SerialName("refresh_token") val refreshToken: String? = null,
    @SerialName("id_token") val idToken: String? = null,
    @SerialName("scope") val scope: String? = null,
)

/** /token 端点错误响应(RFC 6749 5.2)。*/
@Serializable
internal data class TokenErrorResponse(
    @SerialName("error") val error: String,
    @SerialName("error_description") val errorDescription: String? = null,
)

/** OIDC userinfo 响应(基础 claims, 实际字段取决于 scope)。*/
@Serializable
internal data class UserinfoResponse(
    @SerialName("sub") val sub: String,
    @SerialName("email") val email: String? = null,
    @SerialName("email_verified") val emailVerified: Boolean? = null,
    @SerialName("name") val name: String? = null,
    @SerialName("picture") val picture: String? = null,
    @SerialName("org_id") val orgId: String? = null,
)

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

/**
 * XID SDK 所有错误的基类。
 * 使用 sealed class 确保调用方显式处理每种错误。
 */
sealed class XidException(message: String, cause: Throwable? = null) : Exception(message, cause) {

    /** SDK 尚未通过 configure() 初始化。*/
    class NotConfigured : XidException("XID SDK 未初始化, 请先调用 Xid.configure(context, config)")

    /** OIDC discovery 请求失败。*/
    class DiscoveryFailed(message: String, cause: Throwable? = null) :
        XidException("OIDC discovery 失败: $message", cause)

    /** 用户取消了授权流程(Chrome Custom Tabs 被关闭)。*/
    class UserCancelled : XidException("用户取消了授权")

    /** 授权回调携带了错误参数。*/
    class AuthorizationError(val error: String, val description: String?) :
        XidException("授权错误 $error: ${description ?: "(无描述)"}")

    /** PKCE state 不匹配(可能遭受 CSRF 攻击)。*/
    class StateMismatch : XidException("state 参数不匹配, 可能遭受 CSRF 攻击")

    /** Token 端点请求失败。*/
    class TokenExchangeFailed(val errorCode: String, val description: String?) :
        XidException("Token 交换失败 $errorCode: ${description ?: "(无描述)"}")

    /** Token 刷新失败(refresh token 失效或过期)。*/
    class TokenRefreshFailed(message: String, cause: Throwable? = null) :
        XidException("Token 刷新失败: $message", cause)

    /** 没有活跃会话。*/
    class NoSession : XidException("没有活跃会话, 请先调用 signIn()")

    /** 安全存储读写失败。*/
    class StorageError(message: String, cause: Throwable? = null) :
        XidException("安全存储错误: $message", cause)

    /** 网络请求失败。*/
    class NetworkError(message: String, cause: Throwable? = null) :
        XidException("网络请求失败: $message", cause)

    /** JWT 验证失败(签名错误、过期或 claims 不符)。*/
    class TokenValidationFailed(message: String) :
        XidException("JWT 验证失败: $message")
}
