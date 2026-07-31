package dev.xid.sdk;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.InvalidKeyException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;

/**
 * Webhook 签名验证(svix 风格)。
 *
 * 验证逻辑与 XID 服务端 webhook 签名规范(api-sdk-conventions rule)对齐:
 *
 *   待签字符串 = svix-id + "." + svix-timestamp + "." + rawBody
 *   签名       = HMAC-SHA256(webhookSecret_raw_bytes, 待签字符串)
 *   svix-signature header = "v1," + base64(签名)
 *
 * 防重放:svix-timestamp 距当前时间不得超过 5 分钟(可配置)。
 *
 * 注:webhook secret 通常以 "whsec_" 前缀 + base64 形式分发,
 *     本类接受原始 base64 字符串,自动剥离 "whsec_" 前缀。
 */
final class WebhookVerifier {

    /** svix 规范的最大时间窗口 */
    private static final Duration DEFAULT_TOLERANCE = Duration.ofMinutes(5);

    private static final String HMAC_ALGORITHM = "HmacSHA256";

    private final byte[]   secretBytes;
    private final Duration tolerance;
    private final Clock    clock;

    WebhookVerifier(String webhookSecret) {
        this(webhookSecret, DEFAULT_TOLERANCE, Clock.systemUTC());
    }

    /** 测试用构造器,允许注入自定义 Clock 和容忍时间窗 */
    WebhookVerifier(String webhookSecret, Duration tolerance, Clock clock) {
        this.secretBytes = decodeSecret(webhookSecret);
        this.tolerance   = tolerance;
        this.clock       = clock;
    }

    /**
     * 验证 webhook 请求。
     *
     * @param headers 请求 headers Map(key 大小写不敏感由调用方保证或使用 canonical 形式)
     * @param rawBody 原始请求体字节(UTF-8)
     * @throws XidWebhookException 验证失败
     */
    void verify(Map<String, String> headers, byte[] rawBody) throws XidWebhookException {
        String msgId        = requireHeader(headers, "svix-id");
        String msgTimestamp = requireHeader(headers, "svix-timestamp");
        String msgSig       = requireHeader(headers, "svix-signature");

        // 1. 时间窗口检查
        checkTimestamp(msgTimestamp);

        // 2. 构造待签字符串:格式 id.timestamp.body(与 reference verify-webhook.ts 对齐)
        String toSign = msgId + "." + msgTimestamp + "." + new String(rawBody, StandardCharsets.UTF_8);

        // 3. 计算期望签名
        byte[] expectedSig = hmacSha256(secretBytes, toSign.getBytes(StandardCharsets.UTF_8));
        String expectedSigB64 = Base64.getEncoder().encodeToString(expectedSig);

        // 4. svix-signature 可能含多个签名(空格分隔的 "v1,<base64>" 列表)
        boolean matched = false;
        for (String candidate : msgSig.split(" ")) {
            // 格式:v1,<base64>  -- 只支持 v1 版本
            if (!candidate.startsWith("v1,")) continue;
            String candidateSig = candidate.substring(3);
            if (constantTimeEquals(candidateSig, expectedSigB64)) {
                matched = true;
                break;
            }
        }

        if (!matched) {
            throw new XidWebhookException(
                    XidWebhookException.Reason.INVALID_SIGNATURE,
                    "Webhook signature mismatch");
        }
    }

    // ------------------------------------------------------------------
    // private
    // ------------------------------------------------------------------

    private String requireHeader(Map<String, String> headers, String name) throws XidWebhookException {
        // 尝试 canonical 形式和全小写形式
        String v = headers.get(name);
        if (v == null) v = headers.get(name.toLowerCase());
        if (v == null || v.isBlank()) {
            throw new XidWebhookException(
                    XidWebhookException.Reason.MISSING_HEADERS,
                    "Missing required header: " + name);
        }
        return v.trim();
    }

    private void checkTimestamp(String timestampStr) throws XidWebhookException {
        long epochSeconds;
        try {
            epochSeconds = Long.parseLong(timestampStr);
        } catch (NumberFormatException e) {
            throw new XidWebhookException(
                    XidWebhookException.Reason.TIMESTAMP_EXPIRED,
                    "Invalid svix-timestamp format: " + timestampStr);
        }

        Instant msgTime = Instant.ofEpochSecond(epochSeconds);
        Instant now     = clock.instant();
        Duration diff   = Duration.between(msgTime, now).abs();

        if (diff.compareTo(tolerance) > 0) {
            throw new XidWebhookException(
                    XidWebhookException.Reason.TIMESTAMP_EXPIRED,
                    "Webhook timestamp out of tolerance window ("
                            + tolerance.toSeconds() + "s): diff=" + diff.toSeconds() + "s");
        }
    }

    private static byte[] hmacSha256(byte[] key, byte[] data) throws XidWebhookException {
        try {
            Mac mac = Mac.getInstance(HMAC_ALGORITHM);
            mac.init(new SecretKeySpec(key, HMAC_ALGORITHM));
            return mac.doFinal(data);
        } catch (NoSuchAlgorithmException | InvalidKeyException e) {
            // HmacSHA256 在所有标准 JVM 上都存在,这里不应抛出
            throw new XidWebhookException(
                    XidWebhookException.Reason.INVALID_SIGNATURE,
                    "HMAC computation failed: " + e.getMessage());
        }
    }

    /** constant-time 字符串比较,防止 timing attack */
    private static boolean constantTimeEquals(String a, String b) {
        return MessageDigest.isEqual(
                a.getBytes(StandardCharsets.UTF_8),
                b.getBytes(StandardCharsets.UTF_8));
    }

    /**
     * 解码 webhook secret。
     * 接受三种格式:
     *   - "whsec_<base64>" -- svix 分发格式
     *   - "<base64>"       -- 纯 base64
     *   - 旧版 64 位小写 hex -- 按 UTF-8 key material 使用
     */
    private static byte[] decodeSecret(String secret) {
        if (secret == null || secret.isBlank()) {
            throw new IllegalArgumentException("webhookSecret must not be null or blank");
        }
        if (!secret.startsWith("whsec_") && isLegacyHexSecret(secret)) {
            return secret.getBytes(StandardCharsets.UTF_8);
        }
        String base64Part = secret.startsWith("whsec_") ? secret.substring(6) : secret;
        return Base64.getDecoder().decode(base64Part);
    }

    private static boolean isLegacyHexSecret(String secret) {
        if (secret.length() != 64) return false;
        for (int i = 0; i < secret.length(); i++) {
            char value = secret.charAt(i);
            if (!((value >= '0' && value <= '9') || (value >= 'a' && value <= 'f'))) {
                return false;
            }
        }
        return true;
    }
}
