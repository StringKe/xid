package dev.xid.sdk;

import java.time.Duration;
import java.util.Objects;

/**
 * XidClient 构造选项。
 *
 * 使用 Builder 模式构建,所有字段均有合理默认值,
 * 只有 issuer 是必填项。
 *
 * <pre>{@code
 * XidClientOptions options = XidClientOptions.builder()
 *     .issuer("https://xid.dev")
 *     .audience("my-client-id")
 *     .webhookSecret("whsec_xxx")
 *     .build();
 * }</pre>
 */
public final class XidClientOptions {

    /** OIDC issuer,必须与 token 中 iss claim 完全匹配。默认 https://xid.dev */
    private final String issuer;

    /**
     * 期望的 audience(aud claim)。
     * null 表示跳过 aud 校验(不推荐用于生产)。
     */
    private final String audience;

    /**
     * Webhook 签名密钥(svix 风格,base64 编码的原始字节)。
     * 不使用 webhook 验证时可为 null。
     */
    private final String webhookSecret;

    /** JWKS 在内存中的缓存时长。默认 1 小时,与 XID 服务端 KV TTL 一致。 */
    private final Duration jwksCacheDuration;

    /**
     * 自定义 JWKS 端点 URL。
     * null 时自动推导为 issuer + "/jwks"。
     */
    private final String jwksUri;

    /**
     * HTTP 连接超时。默认 5 秒。
     */
    private final Duration connectTimeout;

    /**
     * HTTP 读超时。默认 10 秒。
     */
    private final Duration readTimeout;

    /**
     * 时钟偏差容忍量,用于 exp/nbf/iat 校验。默认 30 秒。
     */
    private final Duration clockSkewTolerance;

    /**
     * 应用自己持有的 short-lived JWT cookie 名称。
     * 默认 null,即只接受 Authorization: Bearer。
     */
    private final String sessionCookieName;

    private XidClientOptions(Builder b) {
        this.issuer              = Objects.requireNonNull(b.issuer, "issuer must not be null");
        this.audience            = b.audience;
        this.webhookSecret       = b.webhookSecret;
        this.jwksCacheDuration   = b.jwksCacheDuration;
        this.jwksUri             = b.jwksUri;
        this.connectTimeout      = b.connectTimeout;
        this.readTimeout         = b.readTimeout;
        this.clockSkewTolerance  = b.clockSkewTolerance;
        this.sessionCookieName   = b.sessionCookieName;
    }

    public String getIssuer()             { return issuer; }
    public String getAudience()           { return audience; }
    public String getWebhookSecret()      { return webhookSecret; }
    public Duration getJwksCacheDuration(){ return jwksCacheDuration; }
    public Duration getConnectTimeout()   { return connectTimeout; }
    public Duration getReadTimeout()      { return readTimeout; }
    public Duration getClockSkewTolerance(){ return clockSkewTolerance; }
    public String getSessionCookieName()  { return sessionCookieName; }

    /** 返回实际使用的 JWKS URI(若未显式指定则为 issuer + "/jwks") */
    public String resolveJwksUri() {
        if (jwksUri != null) return jwksUri;
        String base = issuer.endsWith("/") ? issuer.substring(0, issuer.length() - 1) : issuer;
        return base + "/jwks";
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String   issuer             = "https://xid.dev";
        private String   audience           = null;
        private String   webhookSecret      = null;
        private Duration jwksCacheDuration  = Duration.ofHours(1);
        private String   jwksUri            = null;
        private Duration connectTimeout     = Duration.ofSeconds(5);
        private Duration readTimeout        = Duration.ofSeconds(10);
        private Duration clockSkewTolerance = Duration.ofSeconds(30);
        private String   sessionCookieName  = null;

        public Builder issuer(String issuer) {
            this.issuer = issuer;
            return this;
        }

        public Builder audience(String audience) {
            this.audience = audience;
            return this;
        }

        public Builder webhookSecret(String webhookSecret) {
            this.webhookSecret = webhookSecret;
            return this;
        }

        public Builder jwksCacheDuration(Duration d) {
            this.jwksCacheDuration = d;
            return this;
        }

        public Builder jwksUri(String jwksUri) {
            this.jwksUri = jwksUri;
            return this;
        }

        public Builder connectTimeout(Duration d) {
            this.connectTimeout = d;
            return this;
        }

        public Builder readTimeout(Duration d) {
            this.readTimeout = d;
            return this;
        }

        public Builder clockSkewTolerance(Duration d) {
            this.clockSkewTolerance = d;
            return this;
        }

        public Builder sessionCookieName(String name) {
            this.sessionCookieName = name;
            return this;
        }

        public XidClientOptions build() {
            return new XidClientOptions(this);
        }
    }
}
