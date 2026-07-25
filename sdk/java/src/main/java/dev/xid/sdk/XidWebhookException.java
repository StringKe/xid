package dev.xid.sdk;

/**
 * Webhook 签名验证失败时抛出。
 *
 * reason 字段便于日志分类:
 *   MISSING_HEADERS  -- svix-id / svix-timestamp / svix-signature 缺失
 *   TIMESTAMP_EXPIRED -- 时间戳超出 5 分钟窗口
 *   INVALID_SIGNATURE -- HMAC-SHA256 不匹配
 */
public class XidWebhookException extends XidException {

    public enum Reason {
        MISSING_HEADERS,
        TIMESTAMP_EXPIRED,
        INVALID_SIGNATURE
    }

    private final Reason reason;

    public XidWebhookException(Reason reason, String message) {
        super(message);
        this.reason = reason;
    }

    public Reason getReason() {
        return reason;
    }
}
