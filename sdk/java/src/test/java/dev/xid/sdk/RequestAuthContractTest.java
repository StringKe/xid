package dev.xid.sdk;

import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

public final class RequestAuthContractTest {
    private static void assertTrue(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    private static void testNoImplicitOrCoreCookie() {
        XidClient client = XidClient.create(XidClientOptions.builder().build());
        AuthResult result = client.authenticateRequest(Map.of(
                "Cookie",
                "__session=not.a.jwt; __Host-xid.rt.abcdefgh=not.a.jwt"
        ));
        assertTrue(result.isUnauthenticated(), "implicit cookies must be ignored");
        assertTrue(
                client.authenticateRequest(null, "not.a.jwt").isUnauthenticated(),
                "raw cookie values require an explicitly configured application cookie name"
        );
    }

    private static void testExplicitApplicationJwtCookie() {
        XidClient client = XidClient.create(
                XidClientOptions.builder().sessionCookieName("__app_xid_jwt").build()
        );
        AuthResult result = client.authenticateRequest(
                Map.of("Cookie", "__app_xid_jwt=not.a.jwt")
        );
        assertTrue(
                result.getStatus() == AuthResult.Status.INVALID,
                "explicit app JWT cookie must be extracted"
        );
    }

    private static void testSessionExchangeContract() throws Exception {
        XidClient client = XidClient.createDefault();
        String token = client.exchangeSessionToken(
                "https://app.example/api",
                "__Host-xid.rt.abc=opaque; __Host-xid.active=sess_abc",
                "/v1/sessions/token",
                (uri, cookie) -> {
                    assertTrue(
                            uri.toString().equals("https://app.example/v1/sessions/token"),
                            "wrong endpoint"
                    );
                    assertTrue(
                            cookie.equals(
                                    "__Host-xid.rt.abc=opaque; __Host-xid.active=sess_abc"
                            ),
                            "complete Cookie header not forwarded"
                    );
                    return new SessionTokenHttpResponse(200, "{\"token\":\"jwt-value\"}");
                }
        );
        assertTrue(token.equals("jwt-value"), "wrong token");

        AtomicBoolean called = new AtomicBoolean(false);
        try {
            client.exchangeSessionToken(
                    "https://app.example/api",
                    "__Host-xid.rt.abc=opaque",
                    "https://xid.dev/v1/sessions/token",
                    (uri, cookie) -> {
                        called.set(true);
                        return new SessionTokenHttpResponse(200, "{\"token\":\"jwt\"}");
                    }
            );
            throw new AssertionError("cross-origin endpoint accepted");
        } catch (XidSessionTokenExchangeException expected) {
            assertTrue(expected.getMessage().contains("same-origin"), "wrong cross-origin error");
        }
        assertTrue(!called.get(), "cross-origin transport was called");

        for (SessionTokenHttpResponse response : new SessionTokenHttpResponse[] {
                new SessionTokenHttpResponse(302, "{\"token\":\"jwt\"}"),
                new SessionTokenHttpResponse(200, "{\"jwt\":\"wrong\"}"),
                new SessionTokenHttpResponse(200, "{\"token\":\"jwt\",\"extra\":true}")
        }) {
            try {
                client.exchangeSessionToken(
                        "https://app.example/api",
                        "__Host-xid.rt.abc=opaque",
                        null,
                        (uri, cookie) -> response
                );
                throw new AssertionError("invalid response accepted: " + response);
            } catch (XidSessionTokenExchangeException expected) {
                // expected
            }
        }
    }

    public static void main(String[] args) throws Exception {
        testNoImplicitOrCoreCookie();
        testExplicitApplicationJwtCookie();
        testSessionExchangeContract();
        System.out.println("RequestAuthContractTest: 3 passed, 0 failed");
    }
}
