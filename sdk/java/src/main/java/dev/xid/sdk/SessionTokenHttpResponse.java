package dev.xid.sdk;

/**
 * SessionTokenTransport 返回的最小 HTTP response。
 */
public record SessionTokenHttpResponse(int statusCode, String body) {}
