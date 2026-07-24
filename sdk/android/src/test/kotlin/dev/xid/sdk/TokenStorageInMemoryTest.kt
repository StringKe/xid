/*
 * Copyright 2024 XID contributors
 * SPDX-License-Identifier: MIT
 *
 * In-memory TokenStorageAdapter used for JVM unit tests.
 * Verifies the storage contract without requiring Android Keystore.
 */

package dev.xid.sdk

import dev.xid.sdk.storage.TokenStorageAdapter
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Pure in-memory implementation of [TokenStorageAdapter] for testing.
 */
private class InMemoryStorage : TokenStorageAdapter {
    private val map = mutableMapOf<String, String>()

    override suspend fun get(key: String): String? = map[key]
    override suspend fun set(key: String, value: String) { map[key] = value }
    override suspend fun clear(key: String) { map.remove(key) }
    override suspend fun clearAll() { map.clear() }
}

class TokenStorageInMemoryTest {

    private val storage = InMemoryStorage()

    @Test
    fun `set and get returns stored value`() = runBlocking {
        storage.set("key1", "value1")
        assertEquals("value1", storage.get("key1"))
    }

    @Test
    fun `get on missing key returns null`() = runBlocking {
        assertNull(storage.get("nonexistent"))
    }

    @Test
    fun `clear removes key`() = runBlocking {
        storage.set("key1", "value1")
        storage.clear("key1")
        assertNull(storage.get("key1"))
    }

    @Test
    fun `clearAll removes all keys`() = runBlocking {
        storage.set("k1", "v1")
        storage.set("k2", "v2")
        storage.set("k3", "v3")
        storage.clearAll()
        assertNull(storage.get("k1"))
        assertNull(storage.get("k2"))
        assertNull(storage.get("k3"))
    }

    @Test
    fun `overwrite updates value`() = runBlocking {
        storage.set("key", "old")
        storage.set("key", "new")
        assertEquals("new", storage.get("key"))
    }

    @Test
    fun `different keys are independent`() = runBlocking {
        storage.set("a", "alpha")
        storage.set("b", "beta")
        assertEquals("alpha", storage.get("a"))
        assertEquals("beta", storage.get("b"))
        storage.clear("a")
        assertNull(storage.get("a"))
        assertEquals("beta", storage.get("b"))
    }
}
