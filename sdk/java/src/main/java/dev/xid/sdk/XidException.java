package dev.xid.sdk;

/**
 * XID SDK 顶层异常。
 *
 * 所有 SDK 抛出的受检异常都继承此类,调用方可统一 catch。
 * 子类见:
 *   - {@link XidTokenException}   -- JWT 验证失败
 *   - {@link XidWebhookException} -- webhook 签名验证失败
 *   - {@link XidJwksException}    -- JWKS 拉取 / 解析失败
 */
public class XidException extends Exception {

    public XidException(String message) {
        super(message);
    }

    public XidException(String message, Throwable cause) {
        super(message, cause);
    }
}
