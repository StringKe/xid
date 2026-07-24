package dev.xid.sdk;

/**
 * JWT access token 验证失败时抛出。
 *
 * reason 字段携带机器可读的失败原因,便于日志分类:
 *   EXPIRED          -- token 已过期(exp check)
 *   NOT_YET_VALID    -- token 尚未生效(nbf check)
 *   INVALID_ISSUER   -- iss 不匹配
 *   INVALID_AUDIENCE -- aud 不匹配
 *   INVALID_SIGNATURE -- 签名验证失败或 kid 不存在
 *   MALFORMED        -- token 格式错误,无法解析
 *   JWKS_ERROR       -- JWKS 拉取 / 解析失败
 */
public class XidTokenException extends XidException {

    public enum Reason {
        EXPIRED,
        NOT_YET_VALID,
        INVALID_ISSUER,
        INVALID_AUDIENCE,
        INVALID_SIGNATURE,
        MALFORMED,
        JWKS_ERROR
    }

    private final Reason reason;

    public XidTokenException(Reason reason, String message) {
        super(message);
        this.reason = reason;
    }

    public XidTokenException(Reason reason, String message, Throwable cause) {
        super(message, cause);
        this.reason = reason;
    }

    public Reason getReason() {
        return reason;
    }
}
