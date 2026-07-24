/*
 * Copyright 2024-present XID Authors.
 * Licensed under the MIT License.
 */
package dev.xid.sdk;

import java.util.List;
import java.util.Map;

/**
 * JsonParser 自包含测试。
 */
public final class JsonParserTest {

    static void test_parse_simple_object() {
        Map<String, Object> m = JsonParser.parseObject("{\"a\":\"b\",\"c\":42}");
        assertEquals("b", m.get("a"), "string value");
        assertEquals(42L, m.get("c"), "integer value");
        System.out.println("  PASS test_parse_simple_object");
    }

    @SuppressWarnings("unchecked")
    static void test_parse_nested_object() {
        Map<String, Object> m = JsonParser.parseObject("{\"x\":{\"y\":true}}");
        Map<String, Object> inner = (Map<String, Object>) m.get("x");
        assertEquals(true, inner.get("y"), "nested boolean");
        System.out.println("  PASS test_parse_nested_object");
    }

    @SuppressWarnings("unchecked")
    static void test_parse_array() {
        Object v = JsonParser.parse("[1,2,3]");
        assertTrue(v instanceof List, "should be List");
        List<Object> list = (List<Object>) v;
        assertEquals(3, list.size(), "list size");
        assertEquals(1L, list.get(0), "first element");
        System.out.println("  PASS test_parse_array");
    }

    static void test_parse_null_value() {
        Map<String, Object> m = JsonParser.parseObject("{\"k\":null}");
        assertTrue(m.containsKey("k"), "key should exist");
        assertEquals(null, m.get("k"), "value should be null");
        System.out.println("  PASS test_parse_null_value");
    }

    static void test_parse_escape_sequences() {
        Map<String, Object> m = JsonParser.parseObject("{\"s\":\"line1\\nline2\"}");
        assertEquals("line1\nline2", m.get("s"), "newline escape");
        System.out.println("  PASS test_parse_escape_sequences");
    }

    static void test_parse_jwt_payload() {
        String json = "{\"sub\":\"user-1\",\"iss\":\"https://xid.dev\","
                + "\"aud\":\"my-client\",\"exp\":9999999999,\"iat\":1700000000}";
        Map<String, Object> m = JsonParser.parseObject(json);
        assertEquals("user-1", m.get("sub"), "sub");
        assertEquals("https://xid.dev", m.get("iss"), "iss");
        assertEquals(9999999999L, m.get("exp"), "exp as long");
        System.out.println("  PASS test_parse_jwt_payload");
    }

    public static void main(String[] args) throws Exception {
        System.out.println("=== JsonParserTest ===");
        int passed = 0;
        int failed = 0;

        String[] tests = {
            "test_parse_simple_object",
            "test_parse_nested_object",
            "test_parse_array",
            "test_parse_null_value",
            "test_parse_escape_sequences",
            "test_parse_jwt_payload"
        };

        for (String test : tests) {
            try {
                JsonParserTest.class.getDeclaredMethod(test).invoke(null);
                passed++;
            } catch (java.lang.reflect.InvocationTargetException ite) {
                System.out.println("  FAIL " + test + ": " + ite.getCause());
                failed++;
            } catch (Exception e) {
                System.out.println("  FAIL " + test + ": " + e);
                failed++;
            }
        }
        System.out.println("JsonParserTest: " + passed + " passed, " + failed + " failed");
        if (failed > 0) System.exit(1);
    }

    private static void assertEquals(Object expected, Object actual, String msg) {
        if (expected == null && actual == null) return;
        if (expected != null && expected.equals(actual)) return;
        throw new AssertionError(msg + ": expected=" + expected + " actual=" + actual);
    }

    private static void assertTrue(boolean condition, String msg) {
        if (!condition) throw new AssertionError(msg);
    }
}
