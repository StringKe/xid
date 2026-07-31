package dev.xid.sdk;

import java.net.URI;

/**
 * 可注入的 session-token HTTP adapter。origin/path/status/body 校验始终由 SDK 执行。
 */
@FunctionalInterface
public interface SessionTokenTransport {
    SessionTokenHttpResponse post(URI endpoint, String cookieHeader) throws Exception;
}
