/*
 * Copyright 2024 XID contributors
 * SPDX-License-Identifier: MIT
 *
 * Pure PKCE S256 algorithm implementation using only JDK standard APIs.
 * No dependency on android.util.Base64 -- allows direct JVM unit testing.
 *
 * PkceGenerator delegates here; tests call this object directly.
 */

package dev.xid.sdk.pkce

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * Pure-JDK implementation of the PKCE S256 algorithm (RFC 7636).
 *
 * Uses [java.util.Base64] (available since Java 8) instead of
 * [android.util.Base64], making it testable in the JVM unit test runner
 * without Robolectric.  Both encode to the same output for URL_SAFE +
 * NO_PADDING flags.
 */
internal object PkceCore {

    /** Byte length of the random verifier source material (64 bytes -> 86-char Base64URL). */
    const val VERIFIER_BYTE_LENGTH = 64

    /**
     * Generate a cryptographically random code_verifier.
     *
     * Result: Base64URL without padding, 86 characters, within the
     * RFC 7636 Section 4.1 range of 43-128 characters.
     */
    fun generateVerifier(): String {
        val bytes = ByteArray(VERIFIER_BYTE_LENGTH)
        SecureRandom().nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    /**
     * Derive the code_challenge from a verifier: BASE64URL(SHA-256(ASCII(verifier))).
     *
     * @param verifier code_verifier string (pure ASCII, RFC 7636 alphabet).
     */
    fun deriveChallenge(verifier: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val hash = digest.digest(verifier.toByteArray(Charsets.US_ASCII))
        return Base64.getUrlEncoder().withoutPadding().encodeToString(hash)
    }

    /**
     * Validate OAuth state parameter for CSRF protection.
     *
     * Returns true only when both values are non-null and equal.
     * This is the canonical state-check logic used by AuthSession.handleCallback.
     *
     * Extracted here so JVM unit tests can call the production logic directly
     * without depending on android.net.Uri.
     */
    fun isStateValid(returnedState: String?, storedState: String?): Boolean {
        if (returnedState == null || storedState == null) return false
        return returnedState == storedState
    }
}
