package dev.xid.sdk;

import java.util.Optional;

/**
 * 请求认证结果,由 {@link XidClient#authenticateRequest} 返回。
 *
 * 模式:
 *   AUTHENTICATED   -- token 有效,claims 已填充
 *   UNAUTHENTICATED -- 无 token(Authorization header 缺失 / cookie 不存在)
 *   INVALID         -- token 存在但验证失败,reason 描述原因
 *
 * 典型用法:
 * <pre>{@code
 * AuthResult result = client.authenticateRequest(request);
 * if (result.isAuthenticated()) {
 *     String userId = result.getClaims().getSub();
 *     // ...
 * } else {
 *     // 返回 401
 * }
 * }</pre>
 */
public final class AuthResult {

    public enum Status {
        AUTHENTICATED,
        UNAUTHENTICATED,
        INVALID
    }

    private final Status     status;
    private final XidClaims  claims;
    private final String     reason;

    private AuthResult(Status status, XidClaims claims, String reason) {
        this.status = status;
        this.claims = claims;
        this.reason = reason;
    }

    /** 认证成功 */
    static AuthResult authenticated(XidClaims claims) {
        return new AuthResult(Status.AUTHENTICATED, claims, null);
    }

    /** 无 token */
    static AuthResult unauthenticated() {
        return new AuthResult(Status.UNAUTHENTICATED, null, null);
    }

    /** token 存在但验证失败 */
    static AuthResult invalid(String reason) {
        return new AuthResult(Status.INVALID, null, reason);
    }

    public Status getStatus() {
        return status;
    }

    public boolean isAuthenticated() {
        return status == Status.AUTHENTICATED;
    }

    public boolean isUnauthenticated() {
        return status == Status.UNAUTHENTICATED;
    }

    /**
     * 验证成功时的 claims。
     * status != AUTHENTICATED 时返回 {@link Optional#empty()}。
     */
    public Optional<XidClaims> getClaims() {
        return Optional.ofNullable(claims);
    }

    /**
     * INVALID 时的失败原因描述,其余情况返回 null。
     */
    public String getReason() {
        return reason;
    }

    @Override
    public String toString() {
        return "AuthResult{status=" + status + ", reason=" + reason + "}";
    }
}
