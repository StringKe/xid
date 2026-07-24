/*
 * Copyright 2024 XID contributors
 * SPDX-License-Identifier: MIT
 *
 * Tests for OAuth state (CSRF) validation.
 *
 * The production logic lives in AuthSession.handleCallback, which delegates to
 * PkceCore.isStateValid.  Tests call PkceCore.isStateValid directly -- the same
 * function AuthSession uses -- so there is no hand-rolled copy that could drift
 * from the real implementation.
 *
 * android.net.Uri is not available in the JVM unit test runner; the state
 * comparison itself is pure logic with no Android dependency, making it
 * straightforwardly testable here.
 */

package dev.xid.sdk

import dev.xid.sdk.pkce.PkceCore
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

class StateValidationTest {

    @Test
    fun `matching states are valid`() {
        val state = UUID.randomUUID().toString().replace("-", "")
        assertTrue("Matching state should be valid", PkceCore.isStateValid(state, state))
    }

    @Test
    fun `null returned state fails`() {
        val stored = "abc123"
        assertFalse("Null returned state must fail", PkceCore.isStateValid(null, stored))
    }

    @Test
    fun `null stored state fails`() {
        val returned = "abc123"
        assertFalse("Null stored state must fail", PkceCore.isStateValid(returned, null))
    }

    @Test
    fun `both null fails`() {
        assertFalse("Both null must fail", PkceCore.isStateValid(null, null))
    }

    @Test
    fun `mismatched states fail`() {
        val state1 = UUID.randomUUID().toString()
        val state2 = UUID.randomUUID().toString()
        assertFalse("Mismatched states must fail", PkceCore.isStateValid(state1, state2))
    }

    @Test
    fun `empty string does not match non-empty`() {
        assertFalse("Empty vs non-empty must fail", PkceCore.isStateValid("", "abc"))
    }

    @Test
    fun `state contains only hex chars when UUID is stripped of dashes`() {
        repeat(20) {
            val state = UUID.randomUUID().toString().replace("-", "")
            assertTrue(
                "State must contain only hex chars: $state",
                state.all { c -> c.isDigit() || c in 'a'..'f' },
            )
        }
    }
}
