/*
 * Copyright 2024-present XID Authors.
 * Licensed under the MIT License.
 */
package dev.xid.sdk;

import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * 验证成功后从 access token 提取的标准 claims 包装。
 *
 * 原始 claims map 可通过 {@link #getRaw()} 访问,以获取自定义 claims。
 * 所有字段均直接从 JWT payload JSON 解析,不依赖第三方库。
 */
public final class XidClaims {

    private final Map<String, Object> raw;

    XidClaims(Map<String, Object> raw) {
        this.raw = Collections.unmodifiableMap(raw);
    }

    /** token 唯一标识(jti) */
    public String getJti() {
        return stringClaim("jti");
    }

    /** 用户 ID(sub) */
    public String getSub() {
        return stringClaim("sub");
    }

    /** issuer(iss) */
    public String getIss() {
        return stringClaim("iss");
    }

    /**
     * audience(aud)。
     * OIDC access token aud 可为单值或数组,统一返回 List。
     */
    @SuppressWarnings("unchecked")
    public List<String> getAud() {
        Object v = raw.get("aud");
        if (v == null) return Collections.emptyList();
        if (v instanceof List) return (List<String>) v;
        return Collections.singletonList(v.toString());
    }

    /**
     * 过期时间(exp),Unix epoch 秒。
     * 返回 null 表示 token 中无 exp 字段。
     */
    public Long getExp() {
        return longClaim("exp");
    }

    /**
     * 签发时间(iat),Unix epoch 秒。
     */
    public Long getIat() {
        return longClaim("iat");
    }

    /**
     * 生效时间(nbf),Unix epoch 秒。可为 null。
     */
    public Long getNbf() {
        return longClaim("nbf");
    }

    /**
     * scope 字符串(空格分隔)。
     * XID access token 将 scope 存为字符串 claim "scope"。
     */
    public String getScope() {
        return stringClaim("scope");
    }

    /** client_id claim */
    public String getClientId() {
        return stringClaim("client_id");
    }

    /**
     * amr(Authentication Methods Reference)列表。
     * token 无 amr 或 amr 为空数组时返回空 List。
     */
    @SuppressWarnings("unchecked")
    public List<String> getAmr() {
        Object v = raw.get("amr");
        if (v == null) return Collections.emptyList();
        if (v instanceof List) return (List<String>) v;
        return Collections.singletonList(v.toString());
    }

    /**
     * 匿名访客(guest)判定:amr 数组包含 "guest"。
     * RP 据此拦截匿名用户的敏感写操作;访客转正后签发的 token 不含该值,返回 false。
     */
    public boolean isGuest() {
        return getAmr().contains("guest");
    }

    /** 原始 claims map,用于访问自定义 claims */
    public Map<String, Object> getRaw() {
        return raw;
    }

    @Override
    public String toString() {
        return "XidClaims{sub=" + getSub() + ", iss=" + getIss() + "}";
    }

    // ------------------------------------------------------------------
    // private helpers
    // ------------------------------------------------------------------

    private String stringClaim(String key) {
        Object v = raw.get(key);
        return v != null ? v.toString() : null;
    }

    private Long longClaim(String key) {
        Object v = raw.get(key);
        if (v == null) return null;
        if (v instanceof Number) return ((Number) v).longValue();
        try {
            return Long.parseLong(v.toString());
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
