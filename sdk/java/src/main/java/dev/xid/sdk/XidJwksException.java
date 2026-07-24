package dev.xid.sdk;

/**
 * JWKS 端点拉取或解析失败时抛出。
 */
public class XidJwksException extends XidException {

    public XidJwksException(String message) {
        super(message);
    }

    public XidJwksException(String message, Throwable cause) {
        super(message, cause);
    }
}
