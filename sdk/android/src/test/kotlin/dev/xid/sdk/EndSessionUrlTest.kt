package dev.xid.sdk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EndSessionUrlTest {

    @Test
    fun buildEndSessionUrl_includesIdTokenHintAndPostLogoutRedirect() {
        val url = Xid.buildEndSessionUrl(
            endSessionEndpoint = "https://xid.dev/end_session",
            idTokenHint = "eyJhbGciOiJIUzI1NiJ9.test.sig",
            postLogoutRedirectUri = "com.example.app://logout",
        )

        assertTrue(url.startsWith("https://xid.dev/end_session?"))
        assertTrue(url.contains("id_token_hint=eyJhbGciOiJIUzI1NiJ9.test.sig"))
        assertTrue(url.contains("post_logout_redirect_uri=com.example.app%3A%2F%2Flogout"))
    }

    @Test
    fun buildEndSessionUrl_omitsPostLogoutWhenNull() {
        val url = Xid.buildEndSessionUrl(
            endSessionEndpoint = "https://xid.dev/end_session",
            idTokenHint = "token-hint",
            postLogoutRedirectUri = null,
        )

        assertEquals("https://xid.dev/end_session?id_token_hint=token-hint", url)
        assertTrue(!url.contains("post_logout_redirect_uri"))
    }
}