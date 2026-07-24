/*
 * Copyright 2024 XID contributors
 * SPDX-License-Identifier: MIT
 *
 * JVM unit tests for PKCE S256 logic.
 *
 * Tests call production symbols directly:
 * - PkceCore.generateVerifier() / PkceCore.deriveChallenge() -- pure-JDK shared impl
 * - PkceGenerator.generate() -- the public factory that delegates to PkceCore
 *
 * No parallel re-implementation needed: PkceCore uses java.util.Base64 (JDK 8+)
 * which is available in the JVM unit test runner without Robolectric.
 */

package dev.xid.sdk

import dev.xid.sdk.pkce.PkceCore
import dev.xid.sdk.pkce.PkceGenerator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test

class PkceGeneratorTest {

    // -- PkceGenerator.generate() integration (exercises the production factory) --

    @Test
    fun `generate returns non-blank verifier`() {
        val pair = PkceGenerator.generate()
        assertTrue("verifier must not be blank", pair.verifier.isNotBlank())
    }

    @Test
    fun `generate returns non-blank challenge`() {
        val pair = PkceGenerator.generate()
        assertTrue("challenge must not be blank", pair.challenge.isNotBlank())
    }

    @Test
    fun `generate challenge matches S256 of verifier`() {
        val pair = PkceGenerator.generate()
        val expected = PkceCore.deriveChallenge(pair.verifier)
        assertEquals(
            "PkceGenerator.generate() challenge must equal PkceCore.deriveChallenge(verifier)",
            expected,
            pair.challenge,
        )
    }

    @Test
    fun `generate produces unique pairs on successive calls`() {
        val pairs = List(5) { PkceGenerator.generate() }
        assertEquals("all 5 verifiers should be distinct", 5, pairs.map { it.verifier }.toSet().size)
    }

    // -- PkceCore.generateVerifier() direct tests --

    @Test
    fun `verifier length is within RFC 7636 bounds`() {
        // RFC 7636 Section 4.1: code_verifier is 43-128 characters.
        repeat(10) {
            val verifier = PkceCore.generateVerifier()
            val len = verifier.length
            assertTrue("verifier length $len not in 43-128", len in 43..128)
        }
    }

    @Test
    fun `verifier contains only URL-safe characters`() {
        // RFC 7636 Section 4.1: [A-Z] / [a-z] / [0-9] / "-" / "." / "_" / "~"
        // Base64URL without padding uses [A-Za-z0-9-_].
        repeat(10) {
            val verifier = PkceCore.generateVerifier()
            assertTrue(
                "verifier contains illegal character: $verifier",
                verifier.all { c -> c.isLetterOrDigit() || c == '-' || c == '_' },
            )
        }
    }

    @Test
    fun `verifier contains no Base64 padding characters`() {
        repeat(10) {
            val verifier = PkceCore.generateVerifier()
            assertFalse("verifier must not contain '='", '=' in verifier)
            assertFalse("verifier must not contain '+'", '+' in verifier)
            assertFalse("verifier must not contain '/'", '/' in verifier)
        }
    }

    // -- PkceCore.deriveChallenge() direct tests --

    @Test
    fun `RFC 7636 Appendix B test vector`() {
        // Appendix B: dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk -> E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
        val verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        val expectedChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        val computed = PkceCore.deriveChallenge(verifier)
        assertEquals(
            "RFC 7636 Appendix B challenge mismatch",
            expectedChallenge,
            computed,
        )
    }

    @Test
    fun `challenge is deterministic for same verifier`() {
        val verifier = PkceCore.generateVerifier()
        val c1 = PkceCore.deriveChallenge(verifier)
        val c2 = PkceCore.deriveChallenge(verifier)
        assertEquals("deriveChallenge must be deterministic", c1, c2)
    }

    @Test
    fun `different verifiers produce different challenges`() {
        val v1 = PkceCore.generateVerifier()
        val v2 = PkceCore.generateVerifier()
        val c1 = PkceCore.deriveChallenge(v1)
        val c2 = PkceCore.deriveChallenge(v2)
        assertNotEquals("different verifiers must produce different challenges", c1, c2)
    }

    @Test
    fun `challenge length equals SHA-256 Base64URL output length`() {
        // SHA-256 produces 32 bytes -> Base64URL without padding = ceil(32 * 4 / 3) = 43 chars
        val verifier = PkceCore.generateVerifier()
        val challenge = PkceCore.deriveChallenge(verifier)
        assertEquals("challenge must be exactly 43 characters (SHA-256 Base64URL)", 43, challenge.length)
    }
}
