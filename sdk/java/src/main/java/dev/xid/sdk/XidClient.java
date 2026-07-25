package dev.xid.sdk;

import java.util.Map;
import java.util.Optional;

/**
 * XID 服务端 SDK 主入口。
 *
 * 线程安全,应用内单例使用。构造一次,在整个应用生命周期内复用:
 *
 * <pre>{@code
 * // 初始化(应用启动时)
 * XidClient xid = XidClient.create(
 *     XidClientOptions.builder()
 *         .issuer("https://xid.dev")
 *         .audience("my-client-id")
 *         .webhookSecret("whsec_xxx")
 *         .build()
 * );
 *
 * // 验证 access token
 * XidClaims claims = xid.verifyToken(accessToken);
 * String userId = claims.getSub();
 *
 * // 从 HTTP 请求认证
 * AuthResult result = xid.authenticateRequest(bearerToken, null);
 * if (result.isAuthenticated()) { ... }
 *
 * // 验证 webhook
 * xid.verifyWebhook(headers, rawBody);
 * }</pre>
 *
 * 职责边界:
 *   - 本 SDK 只做服务端验证(JWT 验证 / 请求认证 / webhook 验证)。
 *   - 不实现 OAuth 授权流程(那是浏览器 / 客户端 SDK 的职责)。
 */
public final class XidClient {

    private final XidClientOptions options;
    private final JwksCache         jwksCache;
    private final TokenVerifier     tokenVerifier;
    private final WebhookVerifier   webhookVerifier;

    private XidClient(XidClientOptions options) {
        this.options = options;
        this.jwksCache = new JwksCache(
                options.resolveJwksUri(),
                options.getJwksCacheDuration(),
                options.getConnectTimeout(),
                options.getReadTimeout()
        );
        this.tokenVerifier  = new TokenVerifier(jwksCache, options);
        this.webhookVerifier = options.getWebhookSecret() != null
                ? new WebhookVerifier(options.getWebhookSecret())
                : null;
    }

    /**
     * 工厂方法。
     *
     * @param options 配置项,必须提供 issuer
     * @return 线程安全的 XidClient 实例
     */
    public static XidClient create(XidClientOptions options) {
        return new XidClient(options);
    }

    /**
     * 使用默认配置创建(issuer = https://xid.dev,不校验 aud,无 webhook secret)。
     * 适合快速起步,生产环境请显式传 audience 和 webhookSecret。
     */
    public static XidClient createDefault() {
        return new XidClient(XidClientOptions.builder().build());
    }

    // ------------------------------------------------------------------
    // JWT 验证
    // ------------------------------------------------------------------

    /**
     * 验证 access token 字符串。
     *
     * 会从 XID JWKS 端点拉取公钥(带 1h 内存缓存),验证:
     *   - 签名(ES256 主,RS256/PS256 兼容)
     *   - iss / aud / exp / nbf / iat(带时钟偏差容忍)
     *
     * @param token JWT compact serialization 字符串
     * @return 验证通过后的 {@link XidClaims}
     * @throws XidTokenException token 验证失败(含 reason 字段)
     * @throws XidJwksException  JWKS 拉取失败
     */
    public XidClaims verifyToken(String token) throws XidTokenException, XidJwksException {
        return tokenVerifier.verify(token);
    }

    // ------------------------------------------------------------------
    // 请求认证
    // ------------------------------------------------------------------

    /**
     * 从 HTTP 请求中提取并验证 token。
     *
     * 优先级:
     *   1. Authorization: Bearer <token> header
     *   2. cookieValue 参数(调用方从 Cookie header 解析后传入)
     *
     * 返回结构化 {@link AuthResult},不抛异常,调用方根据 status 判断:
     *   - AUTHENTICATED:token 有效,通过 {@link AuthResult#getClaims()} 取 claims
     *   - UNAUTHENTICATED:未提供 token,应返回 401
     *   - INVALID:token 存在但验证失败,应返回 401
     *
     * @param authorizationHeader HTTP Authorization header 值(可为 null)
     * @param cookieValue         cookie 中的 token 值(可为 null)
     * @return 认证结果
     */
    public AuthResult authenticateRequest(String authorizationHeader, String cookieValue) {
        String token = extractToken(authorizationHeader, cookieValue);

        if (token == null) {
            return AuthResult.unauthenticated();
        }

        try {
            XidClaims claims = tokenVerifier.verify(token);
            return AuthResult.authenticated(claims);
        } catch (XidTokenException e) {
            return AuthResult.invalid(e.getReason().name() + ": " + e.getMessage());
        } catch (XidJwksException e) {
            // JWKS 拉取失败时视为 INVALID(服务不可用),保守处理不暴露内部细节
            return AuthResult.invalid("JWKS_ERROR: " + e.getMessage());
        }
    }

    /**
     * 便捷方法:从 headers Map 中自动提取 Authorization 和 Cookie。
     *
     * Cookie 解析:查找名为 {@link XidClientOptions#getSessionCookieName()} 的 cookie。
     *
     * @param headers HTTP request headers(key 不区分大小写需由调用方保证)
     * @return 认证结果
     */
    public AuthResult authenticateRequest(Map<String, String> headers) {
        String authHeader   = headers.get("Authorization");
        if (authHeader == null) authHeader = headers.get("authorization");

        String cookieHeader = headers.get("Cookie");
        if (cookieHeader == null) cookieHeader = headers.get("cookie");

        String cookieValue = extractSessionCookie(cookieHeader, options.getSessionCookieName());

        return authenticateRequest(authHeader, cookieValue);
    }

    // ------------------------------------------------------------------
    // webhook 验证
    // ------------------------------------------------------------------

    /**
     * 验证 webhook 请求签名(svix 风格)。
     *
     * 必须在构造 {@link XidClientOptions} 时提供 webhookSecret,否则抛 {@link IllegalStateException}。
     *
     * 验证步骤:
     *   1. 检查 svix-id / svix-timestamp / svix-signature header 存在
     *   2. 检查 svix-timestamp 在 5 分钟时间窗口内
     *   3. HMAC-SHA256 签名校验(constant-time 比较,防 timing attack)
     *
     * @param headers 包含 svix-* 头的 headers Map
     * @param rawBody 原始请求体字节数组
     * @throws XidWebhookException  验证失败(含 reason)
     * @throws IllegalStateException 未配置 webhookSecret
     */
    public void verifyWebhook(Map<String, String> headers, byte[] rawBody)
            throws XidWebhookException {
        if (webhookVerifier == null) {
            throw new IllegalStateException(
                    "webhookSecret not configured. Set it via XidClientOptions.builder().webhookSecret(...)");
        }
        webhookVerifier.verify(headers, rawBody);
    }

    // ------------------------------------------------------------------
    // 辅助信息
    // ------------------------------------------------------------------

    /** 返回当前配置的 issuer */
    public String getIssuer() {
        return options.getIssuer();
    }

    /** 强制使 JWKS 缓存失效,下次验证时将重新拉取。一般无需手动调用。 */
    public void invalidateJwksCache() {
        jwksCache.invalidate();
    }

    // ------------------------------------------------------------------
    // private
    // ------------------------------------------------------------------

    /**
     * 从 Authorization header 或 cookie 提取 token 字符串。
     * Authorization header 格式:Bearer <token>
     */
    private static String extractToken(String authorizationHeader, String cookieValue) {
        if (authorizationHeader != null && !authorizationHeader.isBlank()) {
            String header = authorizationHeader.trim();
            if (header.startsWith("Bearer ") || header.startsWith("bearer ")) {
                String token = header.substring(7).trim();
                if (!token.isEmpty()) return token;
            }
        }

        if (cookieValue != null && !cookieValue.isBlank()) {
            return cookieValue.trim();
        }

        return null;
    }

    /**
     * 从 Cookie header 字符串中提取指定名称的 session cookie 值。
     * 格式:name1=value1; name2=value2
     */
    private static String extractSessionCookie(String cookieHeader, String cookieName) {
        if (cookieHeader == null || cookieHeader.isBlank()) return null;
        if (cookieName == null || cookieName.isBlank()) return null;

        for (String part : cookieHeader.split(";")) {
            String trimmed = part.trim();
            int eq = trimmed.indexOf('=');
            if (eq < 0) continue;
            String name  = trimmed.substring(0, eq).trim();
            String value = trimmed.substring(eq + 1).trim();
            if (cookieName.equals(name) && !value.isEmpty()) {
                return value;
            }
        }
        return null;
    }
}
