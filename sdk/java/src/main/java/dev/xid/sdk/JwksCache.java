/*
 * Copyright 2024-present XID Authors.
 * Licensed under the MIT License.
 */
package dev.xid.sdk;

import java.io.IOException;
import java.math.BigInteger;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.security.AlgorithmParameters;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.security.spec.RSAPublicKeySpec;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.locks.ReentrantReadWriteLock;

/**
 * 线程安全的 JWKS 内存缓存。
 *
 * 职责:
 *   1. 首次调用 {@link #getKeys()} 时从 jwksUri 拉取 JWKS。
 *   2. 缓存结果,TTL 到期后下次调用时刷新(lazy refresh)。
 *   3. 并发场景下写锁保护刷新,读锁保护缓存读取,避免缓存击穿。
 *
 * 使用 JDK 内置 {@code java.security} 解析 EC / RSA 公钥,
 * 不引入任何第三方密码学库。
 *
 * 支持算法:ES256(EC P-256)、RS256 / PS256(RSA 2048+)。
 */
final class JwksCache {

    /** 解析后的单条 JWK 记录 */
    static final class JwkEntry {
        final String    kid;
        final String    alg;   // "ES256" / "RS256" / "PS256"
        final String    kty;   // "EC" / "RSA"
        final PublicKey publicKey;

        JwkEntry(String kid, String alg, String kty, PublicKey publicKey) {
            this.kid       = kid;
            this.alg       = alg;
            this.kty       = kty;
            this.publicKey = publicKey;
        }
    }

    private final String     jwksUri;
    private final Duration   cacheDuration;
    private final HttpClient httpClient;

    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();
    private List<JwkEntry> cachedKeys   = null;
    private Instant        cacheExpiry  = Instant.EPOCH;

    JwksCache(String jwksUri, Duration cacheDuration, Duration connectTimeout, Duration readTimeout) {
        this.jwksUri       = jwksUri;
        this.cacheDuration = cacheDuration;
        this.httpClient    = HttpClient.newBuilder()
                .connectTimeout(connectTimeout)
                .build();
        this.keysAfterInvalidate = null;
    }

    /**
     * 测试用构造器,允许注入预置的 keys,跳过网络。
     */
    JwksCache(List<JwkEntry> staticKeys) {
        this(staticKeys, null);
    }

    /**
     * 测试用构造器:模拟密钥轮换。首次 {@link #getKeys()} 返回 initialKeys;
     * {@link #invalidate()} 后返回 keysAfterInvalidate。
     */
    JwksCache(List<JwkEntry> initialKeys, List<JwkEntry> keysAfterInvalidate) {
        this.jwksUri       = null;
        this.cacheDuration = Duration.ofHours(1);
        this.httpClient    = null;
        this.cachedKeys    = List.copyOf(initialKeys);
        this.cacheExpiry   = Instant.MAX;
        this.keysAfterInvalidate = keysAfterInvalidate != null
                ? List.copyOf(keysAfterInvalidate) : null;
    }

    private final List<JwkEntry> keysAfterInvalidate;

    /**
     * 返回当前有效的 {@link JwkEntry} 列表。
     * 若缓存未过期直接读缓存;否则从 JWKS 端点拉取后更新缓存。
     *
     * @throws XidJwksException 拉取或解析失败
     */
    List<JwkEntry> getKeys() throws XidJwksException {
        lock.readLock().lock();
        try {
            if (cachedKeys != null && Instant.now().isBefore(cacheExpiry)) {
                return cachedKeys;
            }
        } finally {
            lock.readLock().unlock();
        }

        lock.writeLock().lock();
        try {
            if (cachedKeys != null && Instant.now().isBefore(cacheExpiry)) {
                return cachedKeys;
            }
            cachedKeys  = fetchAndParse();
            cacheExpiry = Instant.now().plus(cacheDuration);
            return cachedKeys;
        } finally {
            lock.writeLock().unlock();
        }
    }

    /** 是否可在 kid 未命中时通过刷新 JWKS 重试(网络端点或测试轮换缓存)。 */
    boolean canRefreshOnKidMiss() {
        return jwksUri != null || keysAfterInvalidate != null;
    }

    /** 强制使缓存失效,下次 {@link #getKeys()} 将重新拉取。 */
    void invalidate() {
        lock.writeLock().lock();
        try {
            if (keysAfterInvalidate != null) {
                cachedKeys  = keysAfterInvalidate;
                cacheExpiry = Instant.MAX;
            } else {
                cacheExpiry = Instant.EPOCH;
            }
        } finally {
            lock.writeLock().unlock();
        }
    }

    // ------------------------------------------------------------------
    // Fetch + parse JWKS
    // ------------------------------------------------------------------

    private List<JwkEntry> fetchAndParse() throws XidJwksException {
        String body = fetchBody();
        return parseJwks(body);
    }

    private String fetchBody() throws XidJwksException {
        if (jwksUri == null || httpClient == null) {
            throw new XidJwksException("No jwksUri configured");
        }
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(jwksUri))
                .header("Accept", "application/json")
                .timeout(Duration.ofSeconds(10))
                .GET()
                .build();
        try {
            HttpResponse<String> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() != 200) {
                throw new XidJwksException(
                        "JWKS endpoint returned HTTP " + resp.statusCode() + " from " + jwksUri);
            }
            return resp.body();
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            throw new XidJwksException("Failed to fetch JWKS from " + jwksUri, e);
        }
    }

    // ------------------------------------------------------------------
    // Parse JWKS JSON -> List<JwkEntry>  (JDK built-ins only)
    // ------------------------------------------------------------------

    @SuppressWarnings("unchecked")
    static List<JwkEntry> parseJwks(String json) throws XidJwksException {
        Map<String, Object> root;
        try {
            root = JsonParser.parseObject(json);
        } catch (Exception e) {
            throw new XidJwksException("Failed to parse JWKS JSON: " + e.getMessage(), e);
        }

        Object keysObj = root.get("keys");
        if (!(keysObj instanceof List)) {
            throw new XidJwksException("JWKS 'keys' field missing or not an array");
        }
        List<Object> keysList = (List<Object>) keysObj;

        List<JwkEntry> result = new ArrayList<>();
        for (Object keyObj : keysList) {
            if (!(keyObj instanceof Map)) continue;
            Map<String, Object> jwk = (Map<String, Object>) keyObj;
            try {
                JwkEntry entry = parseJwkEntry(jwk);
                if (entry != null) result.add(entry);
            } catch (Exception e) {
                // skip individual malformed keys, not fatal
            }
        }
        return result;
    }

    private static JwkEntry parseJwkEntry(Map<String, Object> jwk) throws Exception {
        String kty = str(jwk, "kty");
        String kid = str(jwk, "kid");   // may be null
        String alg = str(jwk, "alg");   // may be null

        if ("EC".equals(kty)) {
            return parseEcKey(jwk, kid, alg);
        } else if ("RSA".equals(kty)) {
            return parseRsaKey(jwk, kid, alg);
        }
        // unsupported kty (oct etc.) - skip
        return null;
    }

    // ES256: kty=EC, crv=P-256, x,y = base64url-encoded coordinate bytes
    private static JwkEntry parseEcKey(Map<String, Object> jwk, String kid, String alg) throws Exception {
        String crv = str(jwk, "crv");
        String x   = str(jwk, "x");
        String y   = str(jwk, "y");
        if (x == null || y == null) throw new IllegalArgumentException("EC key missing x/y");

        // Map crv to JCA standard name
        String curveName = switch (crv != null ? crv : "") {
            case "P-256" -> "secp256r1";
            case "P-384" -> "secp384r1";
            case "P-521" -> "secp521r1";
            default      -> throw new IllegalArgumentException("Unsupported EC curve: " + crv);
        };

        byte[] xBytes = base64urlDecode(x);
        byte[] yBytes = base64urlDecode(y);
        ECPoint point = new ECPoint(
                new BigInteger(1, xBytes),
                new BigInteger(1, yBytes));

        AlgorithmParameters params = AlgorithmParameters.getInstance("EC");
        params.init(new ECGenParameterSpec(curveName));
        ECParameterSpec ecSpec = params.getParameterSpec(ECParameterSpec.class);

        KeyFactory kf = KeyFactory.getInstance("EC");
        PublicKey pk  = kf.generatePublic(new ECPublicKeySpec(point, ecSpec));

        // Default alg from crv if not in JWK
        String resolvedAlg = alg != null ? alg : switch (crv != null ? crv : "") {
            case "P-256" -> "ES256";
            case "P-384" -> "ES384";
            case "P-521" -> "ES512";
            default      -> "ES256";
        };
        return new JwkEntry(kid, resolvedAlg, "EC", pk);
    }

    // RS256 / PS256: kty=RSA, n,e = base64url-encoded big-endian integers
    private static JwkEntry parseRsaKey(Map<String, Object> jwk, String kid, String alg) throws Exception {
        String n = str(jwk, "n");
        String e = str(jwk, "e");
        if (n == null || e == null) throw new IllegalArgumentException("RSA key missing n/e");

        BigInteger modulus  = new BigInteger(1, base64urlDecode(n));
        BigInteger exponent = new BigInteger(1, base64urlDecode(e));

        KeyFactory kf = KeyFactory.getInstance("RSA");
        PublicKey pk  = kf.generatePublic(new RSAPublicKeySpec(modulus, exponent));

        String resolvedAlg = alg != null ? alg : "RS256";
        return new JwkEntry(kid, resolvedAlg, "RSA", pk);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private static String str(Map<String, Object> map, String key) {
        Object v = map.get(key);
        return v != null ? v.toString() : null;
    }

    static byte[] base64urlDecode(String input) {
        // Add padding if needed
        String padded = input;
        int mod = input.length() % 4;
        if (mod == 2) padded += "==";
        else if (mod == 3) padded += "=";
        return Base64.getUrlDecoder().decode(padded);
    }
}
