/*
 * Copyright 2024-present XID Authors.
 * Licensed under the MIT License.
 */
package dev.xid.sdk;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.interfaces.ECPrivateKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.MGF1ParameterSpec;
import java.security.spec.PSSParameterSpec;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/**
 * TokenVerifier 自包含测试。
 *
 * 不依赖 JUnit / Mockito:所有断言通过 assert 方法 + main() 驱动。
 * JVM 启动必须带 -ea(enableassertions)。
 */
public final class TokenVerifierTest {

    private static final String ISSUER   = "https://xid.dev";
    private static final String AUDIENCE = "test-client";
    private static final Instant NOW     = Instant.parse("2025-06-01T12:00:00Z");
    private static final Clock FIXED_CLOCK = Clock.fixed(NOW, ZoneOffset.UTC);

    private static KeyPair ecKeyPair;
    private static KeyPair rsaKeyPair;
    // keyPair kept for backward compat with existing mintToken calls
    private static KeyPair keyPair;
    private static JwksCache mockCache;
    private static TokenVerifier verifier;

    // RS256 / PS256 verifiers backed by RSA key
    private static TokenVerifier rs256Verifier;
    private static TokenVerifier ps256Verifier;

    static void setUp() throws Exception {
        // EC key for ES256
        KeyPairGenerator ecGen = KeyPairGenerator.getInstance("EC");
        ecGen.initialize(new ECGenParameterSpec("secp256r1"));
        ecKeyPair = ecGen.generateKeyPair();
        keyPair = ecKeyPair; // alias for existing tests

        // RSA key for RS256 / PS256
        KeyPairGenerator rsaGen = KeyPairGenerator.getInstance("RSA");
        rsaGen.initialize(2048);
        rsaKeyPair = rsaGen.generateKeyPair();

        java.security.interfaces.ECPublicKey ecPub =
                (java.security.interfaces.ECPublicKey) ecKeyPair.getPublic();
        JwksCache.JwkEntry ecEntry  = new JwksCache.JwkEntry("test-kid-1", "ES256", "EC",  ecPub);
        JwksCache.JwkEntry rsaEntry = new JwksCache.JwkEntry("test-kid-rsa", "RS256", "RSA", rsaKeyPair.getPublic());
        JwksCache.JwkEntry ps256Entry = new JwksCache.JwkEntry("test-kid-ps256", "PS256", "RSA", rsaKeyPair.getPublic());

        mockCache = new JwksCache(List.of(ecEntry));

        XidClientOptions opts = XidClientOptions.builder()
                .issuer(ISSUER)
                .audience(AUDIENCE)
                .clockSkewTolerance(Duration.ofSeconds(30))
                .build();
        verifier = new TokenVerifier(mockCache, opts, FIXED_CLOCK);

        // RS256 verifier
        JwksCache rs256Cache = new JwksCache(List.of(rsaEntry));
        rs256Verifier = new TokenVerifier(rs256Cache, opts, FIXED_CLOCK);

        // PS256 verifier
        JwksCache ps256Cache = new JwksCache(List.of(ps256Entry));
        ps256Verifier = new TokenVerifier(ps256Cache, opts, FIXED_CLOCK);
    }

    // ------------------------------------------------------------------
    // Test cases
    // ------------------------------------------------------------------

    static void test_verifies_valid_token() throws Exception {
        String token = mintToken(ISSUER, List.of(AUDIENCE),
                NOW.plusSeconds(3600).getEpochSecond(), null, "test-kid-1");

        XidClaims claims = verifier.verify(token);
        assertEquals(ISSUER, claims.getIss(), "iss should match");
        assertTrue(claims.getAud().contains(AUDIENCE), "aud should match");
        assertEquals("test-user-42", claims.getSub(), "sub should match");
        System.out.println("  PASS test_verifies_valid_token");
    }

    static void test_rejects_expired_token() {
        try {
            String token = mintToken(ISSUER, List.of(AUDIENCE),
                    NOW.minusSeconds(60).getEpochSecond(), null, "test-kid-1");
            verifier.verify(token);
            fail("Expected XidTokenException for expired token");
        } catch (XidTokenException e) {
            assertEquals(XidTokenException.Reason.EXPIRED, e.getReason(),
                    "reason should be EXPIRED");
            System.out.println("  PASS test_rejects_expired_token");
        } catch (Exception e) {
            fail("Unexpected exception: " + e);
        }
    }

    static void test_rejects_wrong_issuer() {
        try {
            String token = mintToken("https://evil.example", List.of(AUDIENCE),
                    NOW.plusSeconds(3600).getEpochSecond(), null, "test-kid-1");
            verifier.verify(token);
            fail("Expected XidTokenException for wrong issuer");
        } catch (XidTokenException e) {
            assertEquals(XidTokenException.Reason.INVALID_ISSUER, e.getReason(),
                    "reason should be INVALID_ISSUER");
            System.out.println("  PASS test_rejects_wrong_issuer");
        } catch (Exception e) {
            fail("Unexpected exception: " + e);
        }
    }

    static void test_rejects_wrong_audience() {
        try {
            String token = mintToken(ISSUER, List.of("other-client"),
                    NOW.plusSeconds(3600).getEpochSecond(), null, "test-kid-1");
            verifier.verify(token);
            fail("Expected XidTokenException for wrong audience");
        } catch (XidTokenException e) {
            assertEquals(XidTokenException.Reason.INVALID_AUDIENCE, e.getReason(),
                    "reason should be INVALID_AUDIENCE");
            System.out.println("  PASS test_rejects_wrong_audience");
        } catch (Exception e) {
            fail("Unexpected exception: " + e);
        }
    }

    static void test_rejects_not_yet_valid_token() {
        try {
            // nbf = 2 minutes in the future, beyond 30s tolerance
            String token = mintToken(ISSUER, List.of(AUDIENCE),
                    NOW.plusSeconds(3600).getEpochSecond(),
                    NOW.plusSeconds(120).getEpochSecond(),
                    "test-kid-1");
            verifier.verify(token);
            fail("Expected XidTokenException for nbf in future");
        } catch (XidTokenException e) {
            assertEquals(XidTokenException.Reason.NOT_YET_VALID, e.getReason(),
                    "reason should be NOT_YET_VALID");
            System.out.println("  PASS test_rejects_not_yet_valid_token");
        } catch (Exception e) {
            fail("Unexpected exception: " + e);
        }
    }

    static void test_rejects_blank_token() {
        try {
            verifier.verify("  ");
            fail("Expected XidTokenException for blank token");
        } catch (XidTokenException e) {
            assertEquals(XidTokenException.Reason.MALFORMED, e.getReason(),
                    "reason should be MALFORMED");
            System.out.println("  PASS test_rejects_blank_token");
        } catch (Exception e) {
            fail("Unexpected exception: " + e);
        }
    }

    static void test_rejects_malformed_token() {
        try {
            verifier.verify("not.a.jwt");
            fail("Expected XidTokenException for malformed token");
        } catch (XidTokenException e) {
            assertEquals(XidTokenException.Reason.MALFORMED, e.getReason(),
                    "reason should be MALFORMED");
            System.out.println("  PASS test_rejects_malformed_token");
        } catch (Exception e) {
            fail("Unexpected exception: " + e);
        }
    }

    static void test_rejects_unsupported_alg_none() {
        // Build a "none" alg token manually (no signature)
        String header  = base64url("{\"alg\":\"none\",\"typ\":\"JWT\"}");
        String payload = base64url("{\"sub\":\"x\",\"iss\":\"https://xid.dev\","
                + "\"aud\":\"test-client\",\"exp\":" + NOW.plusSeconds(3600).getEpochSecond() + "}");
        String token = header + "." + payload + ".";
        try {
            verifier.verify(token);
            fail("Expected XidTokenException for alg=none");
        } catch (XidTokenException e) {
            assertEquals(XidTokenException.Reason.INVALID_SIGNATURE, e.getReason(),
                    "reason should be INVALID_SIGNATURE for alg=none");
            System.out.println("  PASS test_rejects_unsupported_alg_none");
        } catch (Exception e) {
            fail("Unexpected exception: " + e);
        }
    }

    static void test_rawEcDsaToDer_roundtrip() throws Exception {
        // Generate a real ES256 signature and verify the DER conversion is accepted
        String token = mintToken(ISSUER, List.of(AUDIENCE),
                NOW.plusSeconds(3600).getEpochSecond(), null, "test-kid-1");
        // If verify passes, rawEcDsaToDer worked correctly
        XidClaims claims = verifier.verify(token);
        assertNotNull(claims, "claims should not be null after successful verify");
        System.out.println("  PASS test_rawEcDsaToDer_roundtrip");
    }

    // RS256 tests

    static void test_rs256_verifies_valid_token() throws Exception {
        String token = mintRsaToken("RS256", "test-kid-rsa", ISSUER, AUDIENCE,
                NOW.plusSeconds(3600).getEpochSecond());
        XidClaims claims = rs256Verifier.verify(token);
        assertEquals(ISSUER, claims.getIss(), "rs256: iss should match");
        System.out.println("  PASS test_rs256_verifies_valid_token");
    }

    static void test_rs256_rejects_bad_signature() {
        try {
            // Build token with RS256 header but sign with EC key -- signature will be wrong bytes
            String token = mintRsaToken("RS256", "test-kid-rsa", ISSUER, AUDIENCE,
                    NOW.plusSeconds(3600).getEpochSecond());
            // Tamper: flip one byte in the signature segment
            String[] parts = token.split("\\.", -1);
            byte[] sigBytes = Base64.getUrlDecoder().decode(parts[2]);
            sigBytes[0] ^= 0xFF;
            String tamperedSig = Base64.getUrlEncoder().withoutPadding().encodeToString(sigBytes);
            String tampered = parts[0] + "." + parts[1] + "." + tamperedSig;
            rs256Verifier.verify(tampered);
            fail("Expected XidTokenException for tampered RS256 token");
        } catch (XidTokenException e) {
            assertEquals(XidTokenException.Reason.INVALID_SIGNATURE, e.getReason(),
                    "rs256 tampered: reason should be INVALID_SIGNATURE");
            System.out.println("  PASS test_rs256_rejects_bad_signature");
        } catch (Exception e) {
            fail("Unexpected exception for RS256 bad sig: " + e);
        }
    }

    // PS256 tests

    static void test_ps256_verifies_valid_token() throws Exception {
        String token = mintRsaToken("PS256", "test-kid-ps256", ISSUER, AUDIENCE,
                NOW.plusSeconds(3600).getEpochSecond());
        XidClaims claims = ps256Verifier.verify(token);
        assertEquals(ISSUER, claims.getIss(), "ps256: iss should match");
        System.out.println("  PASS test_ps256_verifies_valid_token");
    }

    static void test_ps256_rejects_bad_signature() {
        try {
            String token = mintRsaToken("PS256", "test-kid-ps256", ISSUER, AUDIENCE,
                    NOW.plusSeconds(3600).getEpochSecond());
            String[] parts = token.split("\\.", -1);
            byte[] sigBytes = Base64.getUrlDecoder().decode(parts[2]);
            sigBytes[0] ^= 0xFF;
            String tamperedSig = Base64.getUrlEncoder().withoutPadding().encodeToString(sigBytes);
            String tampered = parts[0] + "." + parts[1] + "." + tamperedSig;
            ps256Verifier.verify(tampered);
            fail("Expected XidTokenException for tampered PS256 token");
        } catch (XidTokenException e) {
            assertEquals(XidTokenException.Reason.INVALID_SIGNATURE, e.getReason(),
                    "ps256 tampered: reason should be INVALID_SIGNATURE");
            System.out.println("  PASS test_ps256_rejects_bad_signature");
        } catch (Exception e) {
            fail("Unexpected exception for PS256 bad sig: " + e);
        }
    }

    static void test_ps256_not_accepted_by_es256_verifier() {
        try {
            // PS256 token presented to verifier that only has EC key -- kid mismatch
            String token = mintRsaToken("PS256", "test-kid-ps256", ISSUER, AUDIENCE,
                    NOW.plusSeconds(3600).getEpochSecond());
            verifier.verify(token); // verifier only has EC kid "test-kid-1"
            fail("Expected XidTokenException: PS256 kid not in ES256 verifier");
        } catch (XidTokenException e) {
            assertEquals(XidTokenException.Reason.INVALID_SIGNATURE, e.getReason(),
                    "ps256 vs es256 verifier: reason should be INVALID_SIGNATURE");
            System.out.println("  PASS test_ps256_not_accepted_by_es256_verifier");
        } catch (Exception e) {
            fail("Unexpected exception: " + e);
        }
    }

    // ------------------------------------------------------------------
    // main
    // ------------------------------------------------------------------

    static void test_kid_miss_refreshes_jwks_and_verifies() throws Exception {
        java.security.interfaces.ECPublicKey ecPub =
                (java.security.interfaces.ECPublicKey) ecKeyPair.getPublic();
        JwksCache.JwkEntry oldKid = new JwksCache.JwkEntry("old-kid", "ES256", "EC", ecPub);
        JwksCache.JwkEntry newKid = new JwksCache.JwkEntry("rotated-kid", "ES256", "EC", ecPub);

        JwksCache rotatingCache = new JwksCache(List.of(oldKid), List.of(newKid));
        XidClientOptions opts = XidClientOptions.builder()
                .issuer(ISSUER)
                .audience(AUDIENCE)
                .clockSkewTolerance(Duration.ofSeconds(30))
                .build();
        TokenVerifier rotationVerifier = new TokenVerifier(rotatingCache, opts, FIXED_CLOCK);

        String token = mintToken(ISSUER, List.of(AUDIENCE),
                NOW.plusSeconds(3600).getEpochSecond(), null, "rotated-kid");

        XidClaims claims = rotationVerifier.verify(token);
        assertEquals("test-user-42", claims.getSub(), "sub should match after kid-miss refresh");
        System.out.println("  PASS test_kid_miss_refreshes_jwks_and_verifies");
    }

    public static void main(String[] args) throws Exception {
        System.out.println("=== TokenVerifierTest ===");
        setUp();
        int passed = 0;
        int failed = 0;

        String[] tests = {
            "test_verifies_valid_token",
            "test_rejects_expired_token",
            "test_rejects_wrong_issuer",
            "test_rejects_wrong_audience",
            "test_rejects_not_yet_valid_token",
            "test_rejects_blank_token",
            "test_rejects_malformed_token",
            "test_rejects_unsupported_alg_none",
            "test_rawEcDsaToDer_roundtrip",
            "test_rs256_verifies_valid_token",
            "test_rs256_rejects_bad_signature",
            "test_ps256_verifies_valid_token",
            "test_ps256_rejects_bad_signature",
            "test_ps256_not_accepted_by_es256_verifier",
            "test_kid_miss_refreshes_jwks_and_verifies"
        };

        for (String test : tests) {
            try {
                TokenVerifierTest.class.getDeclaredMethod(test).invoke(null);
                passed++;
            } catch (java.lang.reflect.InvocationTargetException ite) {
                Throwable cause = ite.getCause();
                System.out.println("  FAIL " + test + ": " + cause);
                failed++;
            } catch (Exception e) {
                System.out.println("  FAIL " + test + ": " + e);
                failed++;
            }
        }
        System.out.println("TokenVerifierTest: " + passed + " passed, " + failed + " failed");
        if (failed > 0) System.exit(1);
    }

    // ------------------------------------------------------------------
    // JWT mint helper (JDK built-ins only)
    // ------------------------------------------------------------------

    private static String mintToken(String iss, List<String> aud,
                                    long expEpochSec, Long nbfEpochSec, String kid)
            throws Exception {
        // Build payload JSON
        StringBuilder payloadJson = new StringBuilder("{");
        payloadJson.append("\"sub\":\"test-user-42\",");
        payloadJson.append("\"iss\":\"").append(iss).append("\",");
        if (aud.size() == 1) {
            payloadJson.append("\"aud\":\"").append(aud.get(0)).append("\",");
        } else {
            payloadJson.append("\"aud\":[");
            for (int i = 0; i < aud.size(); i++) {
                if (i > 0) payloadJson.append(",");
                payloadJson.append("\"").append(aud.get(i)).append("\"");
            }
            payloadJson.append("],");
        }
        payloadJson.append("\"exp\":").append(expEpochSec).append(",");
        payloadJson.append("\"iat\":").append(NOW.getEpochSecond()).append(",");
        payloadJson.append("\"jti\":\"jti-test-001\"");
        if (nbfEpochSec != null) {
            payloadJson.append(",\"nbf\":").append(nbfEpochSec);
        }
        payloadJson.append("}");

        String headerJson = "{\"alg\":\"ES256\",\"typ\":\"JWT\",\"kid\":\"" + kid + "\"}";
        String h = base64url(headerJson);
        String p = base64url(payloadJson.toString());
        String signingInput = h + "." + p;

        // Sign with JDK ECDSA -- produces DER-encoded signature
        Signature ecdsaSig = Signature.getInstance("SHA256withECDSA");
        ecdsaSig.initSign(keyPair.getPrivate());
        ecdsaSig.update(signingInput.getBytes(StandardCharsets.UTF_8));
        byte[] derSig = ecdsaSig.sign();

        // Convert DER -> raw r||s (64 bytes) for JWT
        byte[] rawSig = derEcDsaToRaw(derSig);
        String s = Base64.getUrlEncoder().withoutPadding().encodeToString(rawSig);
        return signingInput + "." + s;
    }

    /** Convert DER ECDSA (SEQUENCE { INTEGER r, INTEGER s }) to raw 64-byte r||s. */
    static byte[] derEcDsaToRaw(byte[] der) {
        // DER structure: 0x30 [len] 0x02 [rLen] [r bytes] 0x02 [sLen] [s bytes]
        int idx = 0;
        if (der[idx++] != 0x30) throw new IllegalArgumentException("Expected SEQUENCE");
        int seqLen = der[idx++] & 0xFF;
        if ((seqLen & 0x80) != 0) {
            // long form length
            int numBytes = seqLen & 0x7F;
            seqLen = 0;
            for (int i = 0; i < numBytes; i++) seqLen = (seqLen << 8) | (der[idx++] & 0xFF);
        }
        if (der[idx++] != 0x02) throw new IllegalArgumentException("Expected INTEGER r");
        int rLen = der[idx++] & 0xFF;
        byte[] r = new byte[rLen];
        System.arraycopy(der, idx, r, 0, rLen);
        idx += rLen;
        if (der[idx++] != 0x02) throw new IllegalArgumentException("Expected INTEGER s");
        int sLen = der[idx++] & 0xFF;
        byte[] s = new byte[sLen];
        System.arraycopy(der, idx, s, 0, sLen);

        // Pad r and s to 32 bytes each (strip or prepend zeros)
        byte[] raw = new byte[64];
        copyPadded(r, raw, 0,  32);
        copyPadded(s, raw, 32, 64);
        return raw;
    }

    /** Copy src to dst[start..end], right-aligned with zero padding. */
    private static void copyPadded(byte[] src, byte[] dst, int start, int end) {
        int size = end - start;
        // strip leading zeros from src
        int srcStart = 0;
        while (srcStart < src.length - 1 && src[srcStart] == 0) srcStart++;
        int srcLen = src.length - srcStart;
        int dstOff = start + Math.max(0, size - srcLen);
        System.arraycopy(src, srcStart, dst, dstOff, Math.min(srcLen, size));
    }

    private static String base64url(String json) {
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(json.getBytes(StandardCharsets.UTF_8));
    }

    /**
     * Mint an RS256 or PS256 token signed with rsaKeyPair.
     * Both RS256 and PS256 produce raw-bytes signatures (no DER conversion needed for RSA).
     */
    private static String mintRsaToken(String algName, String kid, String iss, String aud,
                                       long expEpochSec) throws Exception {
        String headerJson  = "{\"alg\":\"" + algName + "\",\"typ\":\"JWT\",\"kid\":\"" + kid + "\"}";
        String payloadJson = "{\"sub\":\"test-user-rsa\",\"iss\":\"" + iss + "\",\"aud\":\"" + aud
                + "\",\"exp\":" + expEpochSec + ",\"iat\":" + NOW.getEpochSecond() + "}";
        String h = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(headerJson.getBytes(StandardCharsets.UTF_8));
        String p = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(payloadJson.getBytes(StandardCharsets.UTF_8));
        String signingInput = h + "." + p;

        Signature sig;
        if ("PS256".equals(algName)) {
            sig = Signature.getInstance("RSASSA-PSS");
            sig.setParameter(new PSSParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA256, 32, 1));
        } else {
            // RS256
            sig = Signature.getInstance("SHA256withRSA");
        }
        sig.initSign(rsaKeyPair.getPrivate());
        sig.update(signingInput.getBytes(StandardCharsets.UTF_8));
        byte[] rawSig = sig.sign();
        String s = Base64.getUrlEncoder().withoutPadding().encodeToString(rawSig);
        return signingInput + "." + s;
    }

    // ------------------------------------------------------------------
    // Simple assertion helpers
    // ------------------------------------------------------------------

    private static void assertEquals(Object expected, Object actual, String msg) {
        if (expected == null && actual == null) return;
        if (expected != null && expected.equals(actual)) return;
        throw new AssertionError(msg + ": expected=" + expected + " actual=" + actual);
    }

    private static void assertTrue(boolean condition, String msg) {
        if (!condition) throw new AssertionError(msg);
    }

    private static void assertNotNull(Object val, String msg) {
        if (val == null) throw new AssertionError(msg + ": expected non-null");
    }

    private static void fail(String msg) {
        throw new AssertionError(msg);
    }
}
