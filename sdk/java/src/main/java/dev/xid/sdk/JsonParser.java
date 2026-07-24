/*
 * Copyright 2024-present XID Authors.
 * Licensed under the MIT License.
 */
package dev.xid.sdk;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 极简 JSON 解析器,仅支持 JWT claims / JWKS 所需的子集:
 *   - 对象 ({})
 *   - 数组 ([])
 *   - 字符串 ("")
 *   - 数字(整数 / 浮点)
 *   - 布尔 (true/false)
 *   - null
 *
 * 不支持:Unicode 转义(4位十六进制)之外的场景(JWT claims 不需要)、
 * 超深嵌套(JWT payload 层级有限)。
 *
 * 设计原则:只满足 JWT/JWKS 解析需求,不做通用 JSON 库。
 */
final class JsonParser {

    private final String src;
    private int pos;

    private JsonParser(String src) {
        this.src = src;
        this.pos = 0;
    }

    /** 解析 JSON 字符串,返回 Map / List / String / Number / Boolean / null */
    static Object parse(String json) {
        if (json == null || json.isBlank()) {
            throw new IllegalArgumentException("JSON input is null or blank");
        }
        JsonParser parser = new JsonParser(json.trim());
        Object result = parser.parseValue();
        parser.skipWhitespace();
        if (parser.pos != parser.src.length()) {
            throw new IllegalArgumentException(
                    "Unexpected trailing content at pos=" + parser.pos);
        }
        return result;
    }

    /** 便捷方法:断言顶层是 Object 并返回 */
    @SuppressWarnings("unchecked")
    static Map<String, Object> parseObject(String json) {
        Object v = parse(json);
        if (!(v instanceof Map)) {
            throw new IllegalArgumentException("Expected JSON object, got " + v);
        }
        return (Map<String, Object>) v;
    }

    // ------------------------------------------------------------------
    // private parse methods
    // ------------------------------------------------------------------

    private Object parseValue() {
        skipWhitespace();
        if (pos >= src.length()) {
            throw new IllegalArgumentException("Unexpected end of JSON at pos=" + pos);
        }
        char c = src.charAt(pos);
        if (c == '{') return parseObject_();
        if (c == '[') return parseArray();
        if (c == '"') return parseString();
        if (c == 't') return parseLiteral("true",  Boolean.TRUE);
        if (c == 'f') return parseLiteral("false", Boolean.FALSE);
        if (c == 'n') return parseLiteral("null",  null);
        if (c == '-' || Character.isDigit(c)) return parseNumber();
        throw new IllegalArgumentException("Unexpected character '" + c + "' at pos=" + pos);
    }

    private Map<String, Object> parseObject_() {
        expect('{');
        Map<String, Object> map = new LinkedHashMap<>();
        skipWhitespace();
        if (peek() == '}') {
            pos++;
            return map;
        }
        while (true) {
            skipWhitespace();
            String key = parseString();
            skipWhitespace();
            expect(':');
            Object value = parseValue();
            map.put(key, value);
            skipWhitespace();
            char sep = src.charAt(pos);
            if (sep == '}') { pos++; break; }
            if (sep == ',') { pos++; continue; }
            throw new IllegalArgumentException("Expected ',' or '}' at pos=" + pos);
        }
        return map;
    }

    private List<Object> parseArray() {
        expect('[');
        List<Object> list = new ArrayList<>();
        skipWhitespace();
        if (peek() == ']') {
            pos++;
            return list;
        }
        while (true) {
            list.add(parseValue());
            skipWhitespace();
            char sep = src.charAt(pos);
            if (sep == ']') { pos++; break; }
            if (sep == ',') { pos++; continue; }
            throw new IllegalArgumentException("Expected ',' or ']' at pos=" + pos);
        }
        return list;
    }

    private String parseString() {
        expect('"');
        StringBuilder sb = new StringBuilder();
        while (pos < src.length()) {
            char c = src.charAt(pos++);
            if (c == '"') return sb.toString();
            if (c == '\\') {
                if (pos >= src.length()) break;
                char esc = src.charAt(pos++);
                switch (esc) {
                    case '"':  sb.append('"'); break;
                    case '\\': sb.append('\\'); break;
                    case '/':  sb.append('/'); break;
                    case 'b':  sb.append('\b'); break;
                    case 'f':  sb.append('\f'); break;
                    case 'n':  sb.append('\n'); break;
                    case 'r':  sb.append('\r'); break;
                    case 't':  sb.append('\t'); break;
                    case 'u': {
                        if (pos + 4 > src.length()) {
                            throw new IllegalArgumentException("Invalid \\u escape at pos=" + pos);
                        }
                        String hex = src.substring(pos, pos + 4);
                        sb.append((char) Integer.parseInt(hex, 16));
                        pos += 4;
                        break;
                    }
                    default:
                        sb.append(esc);
                }
            } else {
                sb.append(c);
            }
        }
        throw new IllegalArgumentException("Unterminated string starting before pos=" + pos);
    }

    private Number parseNumber() {
        int start = pos;
        if (peek() == '-') pos++;
        while (pos < src.length() && (Character.isDigit(src.charAt(pos)) || src.charAt(pos) == '.')) {
            pos++;
        }
        // exponent
        if (pos < src.length() && (src.charAt(pos) == 'e' || src.charAt(pos) == 'E')) {
            pos++;
            if (pos < src.length() && (src.charAt(pos) == '+' || src.charAt(pos) == '-')) pos++;
            while (pos < src.length() && Character.isDigit(src.charAt(pos))) pos++;
        }
        String numStr = src.substring(start, pos);
        if (numStr.contains(".") || numStr.contains("e") || numStr.contains("E")) {
            return Double.parseDouble(numStr);
        }
        try {
            return Long.parseLong(numStr);
        } catch (NumberFormatException e) {
            return Double.parseDouble(numStr);
        }
    }

    private Object parseLiteral(String expected, Object value) {
        if (src.startsWith(expected, pos)) {
            pos += expected.length();
            return value;
        }
        throw new IllegalArgumentException(
                "Expected '" + expected + "' at pos=" + pos);
    }

    private void skipWhitespace() {
        while (pos < src.length() && Character.isWhitespace(src.charAt(pos))) pos++;
    }

    private void expect(char c) {
        if (pos >= src.length() || src.charAt(pos) != c) {
            throw new IllegalArgumentException(
                    "Expected '" + c + "' at pos=" + pos
                    + " got='" + (pos < src.length() ? src.charAt(pos) : "EOF") + "'");
        }
        pos++;
    }

    private char peek() {
        return pos < src.length() ? src.charAt(pos) : 0;
    }
}
