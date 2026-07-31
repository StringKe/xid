/*
 * Copyright 2024-present XID Authors.
 * Licensed under the MIT License.
 */
package dev.xid.sdk;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;

/**
 * WebhookVerifier 自包含测试。
 *
 * 不依赖 JUnit / Mockito。
 */
public final class WebhookVerifierTest {

    private static final Instant FIXED_NOW = Instant.parse("2025-01-01T00:00:00Z");
    private static final byte[] RAW_SECRET =
            "xid-test-secret-32-bytes-xxxxxxx".getBytes(StandardCharsets.UTF_8);
    private static final String SECRET_B64 =
            "whsec_" + Base64.getEncoder().encodeToString(RAW_SECRET);

    private static Clock           fixedClock;
    private static WebhookVerifier verifier;

    static void setUp() {
        fixedClock = Clock.fixed(FIXED_NOW, ZoneOffset.UTC);
        verifier   = new WebhookVerifier(SECRET_B64, Duration.ofMinutes(5), fixedClock);
    }

    // ------------------------------------------------------------------
    // Test cases
    // ------------------------------------------------------------------

    static void test_passes_valid_signature() throws Exception {
        String msgId        = "msg_01HVXXX";
        String msgTimestamp = String.valueOf(FIXED_NOW.getEpochSecond());
        byte[] body         = "{\"type\":\"user.created\"}".getBytes(StandardCharsets.UTF_8);
        String sig = computeExpectedSig(RAW_SECRET, msgId, msgTimestamp, body);

        Map<String, String> headers = new HashMap<>();
        headers.put("svix-id",        msgId);
        headers.put("svix-timestamp", msgTimestamp);
        headers.put("svix-signature", "v1," + sig);

        verifier.verify(headers, body);  // must not throw
        System.out.println("  PASS test_passes_valid_signature");
    }

    static void test_accepts_legacy_hex_secret_as_utf8_key_material() throws Exception {
        String legacySecret = "ab".repeat(32);
        WebhookVerifier legacyVerifier =
                new WebhookVerifier(legacySecret, Duration.ofMinutes(5), fixedClock);
        String msgId        = "msg_legacy";
        String msgTimestamp = String.valueOf(FIXED_NOW.getEpochSecond());
        byte[] body         = "{\"type\":\"user.updated\"}".getBytes(StandardCharsets.UTF_8);
        String sig = computeExpectedSig(
                legacySecret.getBytes(StandardCharsets.UTF_8),
                msgId,
                msgTimestamp,
                body);

        Map<String, String> headers = new HashMap<>();
        headers.put("svix-id",        msgId);
        headers.put("svix-timestamp", msgTimestamp);
        headers.put("svix-signature", "v1," + sig);

        legacyVerifier.verify(headers, body);
        System.out.println("  PASS test_accepts_legacy_hex_secret_as_utf8_key_material");
    }

    static void test_rejects_wrong_signature() {
        Map<String, String> headers = new HashMap<>();
        headers.put("svix-id",        "msg_01HVXXX");
        headers.put("svix-timestamp", String.valueOf(FIXED_NOW.getEpochSecond()));
        headers.put("svix-signature", "v1,aGVsbG8=");   // wrong

        try {
            verifier.verify(headers, "{}".getBytes(StandardCharsets.UTF_8));
            fail("Expected XidWebhookException for wrong signature");
        } catch (XidWebhookException e) {
            assertEquals(XidWebhookException.Reason.INVALID_SIGNATURE, e.getReason(),
                    "reason should be INVALID_SIGNATURE");
            System.out.println("  PASS test_rejects_wrong_signature");
        } catch (Exception e) {
            fail("Unexpected exception: " + e);
        }
    }

    static void test_rejects_expired_timestamp() {
        long oldTs = FIXED_NOW.minus(Duration.ofMinutes(6)).getEpochSecond();
        Map<String, String> headers = new HashMap<>();
        headers.put("svix-id",        "msg_01HVXXX");
        headers.put("svix-timestamp", String.valueOf(oldTs));
        headers.put("svix-signature", "v1,dummysig");

        try {
            verifier.verify(headers, "{}".getBytes(StandardCharsets.UTF_8));
            fail("Expected XidWebhookException for expired timestamp");
        } catch (XidWebhookException e) {
            assertEquals(XidWebhookException.Reason.TIMESTAMP_EXPIRED, e.getReason(),
                    "reason should be TIMESTAMP_EXPIRED");
            System.out.println("  PASS test_rejects_expired_timestamp");
        } catch (Exception e) {
            fail("Unexpected exception: " + e);
        }
    }

    static void test_rejects_missing_headers() {
        Map<String, String> headers = new HashMap<>();
        // svix-id missing

        try {
            verifier.verify(headers, "{}".getBytes(StandardCharsets.UTF_8));
            fail("Expected XidWebhookException for missing headers");
        } catch (XidWebhookException e) {
            assertEquals(XidWebhookException.Reason.MISSING_HEADERS, e.getReason(),
                    "reason should be MISSING_HEADERS");
            System.out.println("  PASS test_rejects_missing_headers");
        } catch (Exception e) {
            fail("Unexpected exception: " + e);
        }
    }

    static void test_accepts_multiple_signatures_if_one_matches() throws Exception {
        String msgId        = "msg_01HVXXX";
        String msgTimestamp = String.valueOf(FIXED_NOW.getEpochSecond());
        byte[] body         = "{}".getBytes(StandardCharsets.UTF_8);
        String goodSig = computeExpectedSig(RAW_SECRET, msgId, msgTimestamp, body);

        Map<String, String> headers = new HashMap<>();
        headers.put("svix-id",        msgId);
        headers.put("svix-timestamp", msgTimestamp);
        // multiple sigs: invalid first, valid second
        headers.put("svix-signature", "v1,invalid== v1," + goodSig);

        verifier.verify(headers, body);  // must not throw
        System.out.println("  PASS test_accepts_multiple_signatures_if_one_matches");
    }

    static void test_rejects_future_timestamp_outside_window() {
        long futureTs = FIXED_NOW.plus(Duration.ofMinutes(6)).getEpochSecond();
        Map<String, String> headers = new HashMap<>();
        headers.put("svix-id",        "msg_future");
        headers.put("svix-timestamp", String.valueOf(futureTs));
        headers.put("svix-signature", "v1,dummysig");

        try {
            verifier.verify(headers, "{}".getBytes(StandardCharsets.UTF_8));
            fail("Expected XidWebhookException for future timestamp outside window");
        } catch (XidWebhookException e) {
            assertEquals(XidWebhookException.Reason.TIMESTAMP_EXPIRED, e.getReason(),
                    "reason should be TIMESTAMP_EXPIRED for future timestamp");
            System.out.println("  PASS test_rejects_future_timestamp_outside_window");
        } catch (Exception e) {
            fail("Unexpected exception: " + e);
        }
    }

    // ------------------------------------------------------------------
    // main
    // ------------------------------------------------------------------

    public static void main(String[] args) throws Exception {
        System.out.println("=== WebhookVerifierTest ===");
        setUp();
        int passed = 0;
        int failed = 0;

        String[] tests = {
            "test_passes_valid_signature",
            "test_accepts_legacy_hex_secret_as_utf8_key_material",
            "test_rejects_wrong_signature",
            "test_rejects_expired_timestamp",
            "test_rejects_missing_headers",
            "test_accepts_multiple_signatures_if_one_matches",
            "test_rejects_future_timestamp_outside_window"
        };

        for (String test : tests) {
            try {
                WebhookVerifierTest.class.getDeclaredMethod(test).invoke(null);
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
        System.out.println("WebhookVerifierTest: " + passed + " passed, " + failed + " failed");
        if (failed > 0) System.exit(1);
    }

    // ------------------------------------------------------------------
    // helper
    // ------------------------------------------------------------------

    private static String computeExpectedSig(byte[] secret, String msgId, String ts, byte[] body)
            throws Exception {
        String toSign = msgId + "." + ts + "." + new String(body, StandardCharsets.UTF_8);
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret, "HmacSHA256"));
        byte[] sig = mac.doFinal(toSign.getBytes(StandardCharsets.UTF_8));
        return Base64.getEncoder().encodeToString(sig);
    }

    // ------------------------------------------------------------------
    // Assertion helpers
    // ------------------------------------------------------------------

    private static void assertEquals(Object expected, Object actual, String msg) {
        if (expected == null && actual == null) return;
        if (expected != null && expected.equals(actual)) return;
        throw new AssertionError(msg + ": expected=" + expected + " actual=" + actual);
    }

    private static void fail(String msg) {
        throw new AssertionError(msg);
    }
}
