/*
 * Copyright 2024 XID contributors
 * SPDX-License-Identifier: MIT
 */

package dev.xid.sdk

import dev.xid.sdk.pkce.PkceCore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class OidcNonceTest {

    @Test
    fun `nonce contains 32 bytes of entropy encoded as base64url`() {
        val nonce = PkceCore.generateNonce()
        val decoded = Base64.getUrlDecoder().decode(nonce)

        assertEquals(PkceCore.NONCE_BYTE_LENGTH, decoded.size)
        assertEquals(43, nonce.length)
        assertFalse(nonce.contains("="))
        assertTrue(nonce.all { it.isLetterOrDigit() || it == '-' || it == '_' })
    }

    @Test
    fun `each authorization gets a distinct nonce`() {
        val first = PkceCore.generateNonce()
        val second = PkceCore.generateNonce()

        assertNotEquals(first, second)
    }
}
