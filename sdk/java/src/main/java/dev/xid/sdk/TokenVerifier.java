/*
 * Copyright 2024-present XID Authors.
 * Licensed under the MIT License.
 */
package dev.xid.sdk;

import java.nio.charset.StandardCharsets;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.MGF1ParameterSpec;
import java.security.spec.PSSParameterSpec;
import java.time.Clock;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * JWT access token 验证核心(JDK built-ins only)。
 *
 * 支持算法:ES256(P-256 + SHA-256)、RS256(RSA-PKCS1 + SHA-256)、PS256(RSA-PSS + SHA-256)。
 * 拒绝 alg=none 及白名单外的所有算法。
 *
 * 验证顺序:
 *   1. 解析 JWT header -- 取 alg / kid
 *   2. alg 白名单检查(fail fast)
 *   3. 从 {@link JwksCache} 取公钥集,按 kid 匹配
 *   4. {@code java.security.Signature} 验签
 *   5. 检查 exp / nbf(带时钟偏差容忍)
 *   6. 检查 iss / aud
 *
 * 线程安全:所有实例变量不可变或线程安全。
 */
final class TokenVerifier {

    /** XID 支持的签名算法集合(白名单) */
    private static final Set<String> SUPPORTED_ALGORITHMS = Set.of("ES256", "RS256", "PS256");

    /**
     * 算法名 -> JCA Signature 算法名映射。
     * PS256 使用 "RSASSA-PSS"(标准 JCA 名),需额外设置 PSSParameterSpec;
     * "SHA256withRSA/PSS" 在 SunRsaSign provider 不存在。
     */
    private static final Map<String, String> JCA_ALGORITHM = Map.of(
            "ES256", "SHA256withECDSA",
            "RS256", "SHA256withRSA",
            "PS256", "RSASSA-PSS"
    );

    private final JwksCache        jwksCache;
    private final XidClientOptions options;
    private final Clock            clock;

    TokenVerifier(JwksCache jwksCache, XidClientOptions options) {
        this(jwksCache, options, Clock.systemUTC());
    }

    /** 测试用构造器,允许注入自定义 Clock */
    TokenVerifier(JwksCache jwksCache, XidClientOptions options, Clock clock) {
        this.jwksCache = jwksCache;
        this.options   = options;
        this.clock     = clock;
    }

    /**
     * 验证 JWT access token 字符串。
     *
     * @param token 原始 JWT 字符串(compact serialization)
     * @return 验证通过后的 {@link XidClaims}
     * @throws XidTokenException  验证失败(含原因)
     * @throws XidJwksException   JWKS 拉取失败
     */
    XidClaims verify(String token) throws XidTokenException, XidJwksException {
        if (token == null || token.isBlank()) {
            throw new XidTokenException(XidTokenException.Reason.MALFORMED, "Token is null or blank");
        }

        // 1. 拆分 JWT 三段
        String[] parts = token.split("\\.", -1);
        if (parts.length != 3) {
            throw new XidTokenException(XidTokenException.Reason.MALFORMED,
                    "JWT must have 3 parts, got " + parts.length);
        }

        // 2. 解析 header
        Map<String, Object> header = parseBase64UrlJson(parts[0], "header");
        String alg = stringField(header, "alg", "header.alg");
        String kid = (String) header.get("kid"); // may be null

        // 3. alg 白名单(fail fast)
        if (!SUPPORTED_ALGORITHMS.contains(alg)) {
            throw new XidTokenException(XidTokenException.Reason.INVALID_SIGNATURE,
                    "Unsupported or missing algorithm: " + alg);
        }

        // 4. 解析 payload
        Map<String, Object> payload = parseBase64UrlJson(parts[1], "payload");

        // 5. 取公钥集,按 kid 选键;kid 未命中时强制刷新一次(密钥轮换兜底)
        JwksCache.JwkEntry matchedKey = resolveKey(kid, alg);

        // 6. 验签(签名的输入是 header_b64url + "." + payload_b64url 的 UTF-8 bytes)
        byte[] signingInput = (parts[0] + "." + parts[1]).getBytes(StandardCharsets.UTF_8);
        byte[] signature    = decodeSignatureBytes(parts[2]);
        verifySignature(alg, matchedKey, signingInput, signature);

        // 7. 时序检查(exp / nbf)
        checkTimeClaims(payload);

        // 8. iss / aud 检查
        checkIss(payload);
        checkAud(payload);

        return new XidClaims(payload);
    }

    // ------------------------------------------------------------------
    // private: key selection
    // ------------------------------------------------------------------

    private JwksCache.JwkEntry resolveKey(String kid, String alg)
            throws XidTokenException, XidJwksException {
        List<JwksCache.JwkEntry> keys = jwksCache.getKeys();
        try {
            return selectKey(keys, kid, alg);
        } catch (XidTokenException e) {
            if (kid != null && isKidMiss(e) && jwksCache.canRefreshOnKidMiss()) {
                jwksCache.invalidate();
                keys = jwksCache.getKeys();
                return selectKey(keys, kid, alg);
            }
            throw e;
        }
    }

    private static boolean isKidMiss(XidTokenException e) {
        return e.getReason() == XidTokenException.Reason.INVALID_SIGNATURE
                && e.getMessage() != null
                && e.getMessage().startsWith("No JWKS key found for kid=");
    }

    private JwksCache.JwkEntry selectKey(List<JwksCache.JwkEntry> keys, String kid, String alg)
            throws XidTokenException {
        if (keys == null || keys.isEmpty()) {
            throw new XidTokenException(XidTokenException.Reason.INVALID_SIGNATURE,
                    "JWKS is empty -- no public keys available");
        }

        // Prefer exact kid match
        if (kid != null) {
            for (JwksCache.JwkEntry entry : keys) {
                if (kid.equals(entry.kid)) {
                    return entry;
                }
            }
            // kid specified but not found in JWKS
            throw new XidTokenException(XidTokenException.Reason.INVALID_SIGNATURE,
                    "No JWKS key found for kid=" + kid);
        }

        // No kid in token -- select first key compatible with the algorithm
        for (JwksCache.JwkEntry entry : keys) {
            if (entry.alg == null || entry.alg.equals(alg)) return entry;
            if (isAlgCompatible(alg, entry.kty)) return entry;
        }

        throw new XidTokenException(XidTokenException.Reason.INVALID_SIGNATURE,
                "No compatible JWKS key found for alg=" + alg);
    }

    private static boolean isAlgCompatible(String alg, String kty) {
        if ("EC".equals(kty)) return alg.startsWith("ES");
        if ("RSA".equals(kty)) return alg.equals("RS256") || alg.equals("PS256") || alg.startsWith("RS") || alg.startsWith("PS");
        return false;
    }

    // ------------------------------------------------------------------
    // private: signature verification
    // ------------------------------------------------------------------

    /**
     * PS256 requires "RSASSA-PSS" algorithm name plus explicit PSSParameterSpec.
     * SHA256withRSA/PSS is not a valid name in the standard SunRsaSign provider.
     */
    private static final PSSParameterSpec PSS_PARAMS_SHA256 = new PSSParameterSpec(
            "SHA-256", "MGF1", MGF1ParameterSpec.SHA256, 32, 1);

    private static void verifySignature(String alg, JwksCache.JwkEntry key,
                                        byte[] signingInput, byte[] signatureBytes)
            throws XidTokenException {
        try {
            String jcaAlg = JCA_ALGORITHM.get(alg);
            Signature sig = Signature.getInstance(jcaAlg);
            if ("PS256".equals(alg)) {
                sig.setParameter(PSS_PARAMS_SHA256);
            }
            sig.initVerify(key.publicKey);
            sig.update(signingInput);

            // ECDSA: JWT uses fixed-size r||s (raw), JCA expects DER.
            // RS256/PS256: JWT signature is raw bytes, matches JCA directly.
            byte[] verifyBytes;
            if ("ES256".equals(alg)) {
                verifyBytes = rawEcDsaToDer(signatureBytes);
            } else {
                verifyBytes = signatureBytes;
            }

            boolean ok = sig.verify(verifyBytes);
            if (!ok) {
                throw new XidTokenException(XidTokenException.Reason.INVALID_SIGNATURE,
                        "Signature verification failed");
            }
        } catch (XidTokenException e) {
            throw e;
        } catch (Exception e) {
            throw new XidTokenException(XidTokenException.Reason.INVALID_SIGNATURE,
                    "Signature verification error: " + e.getMessage(), e);
        }
    }

    /**
     * Convert raw ES256 ECDSA signature (r||s, 64 bytes) to DER format.
     * JWS Section 3.4: ECDSA signature is the base64url of r||s, each 32 bytes for P-256.
     * Java Signature.verify() expects DER (SEQUENCE { INTEGER r, INTEGER s }).
     */
    static byte[] rawEcDsaToDer(byte[] rawSig) throws XidTokenException {
        if (rawSig.length != 64) {
            throw new XidTokenException(XidTokenException.Reason.INVALID_SIGNATURE,
                    "ES256 raw signature must be 64 bytes, got " + rawSig.length);
        }
        byte[] r = trimLeadingZeros(rawSig, 0,  32);
        byte[] s = trimLeadingZeros(rawSig, 32, 64);

        // DER encode each integer: if high bit set, prepend 0x00
        byte[] rEnc = derEncodeInteger(r);
        byte[] sEnc = derEncodeInteger(s);

        int seqLen = rEnc.length + sEnc.length;
        byte[] der;
        if (seqLen < 128) {
            der = new byte[2 + seqLen];
            der[0] = 0x30;
            der[1] = (byte) seqLen;
            System.arraycopy(rEnc, 0, der, 2, rEnc.length);
            System.arraycopy(sEnc, 0, der, 2 + rEnc.length, sEnc.length);
        } else {
            // Lengths > 127 are uncommon for P-256 but handle anyway
            der = new byte[3 + seqLen];
            der[0] = 0x30;
            der[1] = (byte) 0x81;
            der[2] = (byte) seqLen;
            System.arraycopy(rEnc, 0, der, 3, rEnc.length);
            System.arraycopy(sEnc, 0, der, 3 + rEnc.length, sEnc.length);
        }
        return der;
    }

    /** Strip leading zeros from a big-endian byte slice. */
    private static byte[] trimLeadingZeros(byte[] src, int from, int to) {
        int start = from;
        while (start < to - 1 && src[start] == 0) start++;
        int len = to - start;
        byte[] out = new byte[len];
        System.arraycopy(src, start, out, 0, len);
        return out;
    }

    /** DER-encode a positive integer: prepend 0x02, length, (0x00 if high bit set), value. */
    private static byte[] derEncodeInteger(byte[] val) {
        boolean needPad = (val[0] & 0x80) != 0;
        int contentLen = val.length + (needPad ? 1 : 0);
        byte[] out = new byte[2 + contentLen];
        out[0] = 0x02;
        out[1] = (byte) contentLen;
        if (needPad) {
            out[2] = 0x00;
            System.arraycopy(val, 0, out, 3, val.length);
        } else {
            System.arraycopy(val, 0, out, 2, val.length);
        }
        return out;
    }

    // ------------------------------------------------------------------
    // private: claims checks
    // ------------------------------------------------------------------

    private void checkTimeClaims(Map<String, Object> payload) throws XidTokenException {
        long nowSec = clock.instant().getEpochSecond();
        long skewSec = options.getClockSkewTolerance().toSeconds();

        // exp check
        Long exp = longField(payload, "exp");
        if (exp != null) {
            if (nowSec > exp + skewSec) {
                throw new XidTokenException(XidTokenException.Reason.EXPIRED,
                        "Token expired at " + exp + " (now=" + nowSec + ")");
            }
        }

        // nbf check
        Long nbf = longField(payload, "nbf");
        if (nbf != null) {
            if (nowSec < nbf - skewSec) {
                throw new XidTokenException(XidTokenException.Reason.NOT_YET_VALID,
                        "Token not yet valid until " + nbf + " (now=" + nowSec + ")");
            }
        }
    }

    private void checkIss(Map<String, Object> payload) throws XidTokenException {
        Object iss = payload.get("iss");
        String expected = options.getIssuer();
        if (iss == null || !normalizeIssuer(iss.toString()).equals(normalizeIssuer(expected))) {
            throw new XidTokenException(XidTokenException.Reason.INVALID_ISSUER,
                    "Invalid issuer: expected=" + expected + " got=" + iss);
        }
    }

    @SuppressWarnings("unchecked")
    private void checkAud(Map<String, Object> payload) throws XidTokenException {
        String expectedAud = options.getAudience();
        if (expectedAud == null) return; // caller opted out of aud check

        Object audRaw = payload.get("aud");
        if (audRaw == null) {
            throw new XidTokenException(XidTokenException.Reason.INVALID_AUDIENCE,
                    "Token has no aud claim; expected=" + expectedAud);
        }
        boolean matched = false;
        if (audRaw instanceof List) {
            for (Object a : (List<Object>) audRaw) {
                if (expectedAud.equals(a)) { matched = true; break; }
            }
        } else {
            matched = expectedAud.equals(audRaw.toString());
        }
        if (!matched) {
            throw new XidTokenException(XidTokenException.Reason.INVALID_AUDIENCE,
                    "Invalid audience: expected=" + expectedAud + " got=" + audRaw);
        }
    }

    // ------------------------------------------------------------------
    // private: parsing helpers
    // ------------------------------------------------------------------

    private static Map<String, Object> parseBase64UrlJson(String b64url, String part)
            throws XidTokenException {
        byte[] bytes;
        try {
            bytes = JwksCache.base64urlDecode(b64url);
        } catch (Exception e) {
            throw new XidTokenException(XidTokenException.Reason.MALFORMED,
                    "Cannot base64url-decode JWT " + part + ": " + e.getMessage(), e);
        }
        String json = new String(bytes, StandardCharsets.UTF_8);
        try {
            return JsonParser.parseObject(json);
        } catch (Exception e) {
            throw new XidTokenException(XidTokenException.Reason.MALFORMED,
                    "Cannot parse JWT " + part + " as JSON: " + e.getMessage(), e);
        }
    }

    private static byte[] decodeSignatureBytes(String b64url) throws XidTokenException {
        try {
            return JwksCache.base64urlDecode(b64url);
        } catch (Exception e) {
            throw new XidTokenException(XidTokenException.Reason.MALFORMED,
                    "Cannot base64url-decode JWT signature: " + e.getMessage(), e);
        }
    }

    private static String stringField(Map<String, Object> map, String key, String desc)
            throws XidTokenException {
        Object v = map.get(key);
        if (v == null || v.toString().isBlank()) {
            throw new XidTokenException(XidTokenException.Reason.MALFORMED,
                    "Missing or blank JWT field: " + desc);
        }
        return v.toString();
    }

    private static Long longField(Map<String, Object> map, String key) {
        Object v = map.get(key);
        if (v == null) return null;
        if (v instanceof Number) return ((Number) v).longValue();
        try { return Long.parseLong(v.toString()); }
        catch (NumberFormatException e) { return null; }
    }

    private static String normalizeIssuer(String issuer) {
        return issuer.endsWith("/") ? issuer.substring(0, issuer.length() - 1) : issuer;
    }
}
