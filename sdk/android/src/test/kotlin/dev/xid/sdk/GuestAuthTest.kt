package dev.xid.sdk

import dev.xid.sdk.guest.GuestAuthManager
import dev.xid.sdk.model.XidException
import dev.xid.sdk.storage.TokenStorageAdapter
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

private class GuestInMemoryStorage : TokenStorageAdapter {
    private val map = mutableMapOf<String, String>()

    override suspend fun get(key: String): String? = map[key]
    override suspend fun set(key: String, value: String) { map[key] = value }
    override suspend fun clear(key: String) { map.remove(key) }
    override suspend fun clearAll() { map.clear() }
}

class GuestAuthTest {

    private lateinit var server: MockWebServer
    private lateinit var storage: GuestInMemoryStorage
    private lateinit var manager: GuestAuthManager

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        storage = GuestInMemoryStorage()
        manager = GuestAuthManager(storage = storage, issuer = server.url("/").toString())
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun enqueueGuestResponse(
        code: Int = 201,
        sessionId: String = "sess_1",
        withCookie: Boolean = true,
    ) {
        val response = MockResponse()
            .setResponseCode(code)
            .setHeader("Content-Type", "application/json")
            .setBody("""{"sessionId":"$sessionId"}""")
        if (withCookie) {
            response.addHeader(
                "Set-Cookie",
                "xid_rt_$sessionId=opaque-token; Path=/; HttpOnly; Secure; SameSite=Strict",
            )
        }
        server.enqueue(response)
    }

    private fun enqueueMeResponse(
        userId: String = "u_guest",
        provisionedBy: String? = "anonymous",
    ) {
        val provisionedField = provisionedBy?.let { ""","provisioned_by":"$it"""" } ?: ""
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "application/json")
                .setBody(
                    """{"user":{"id":"$userId","email":"","emailVerified":false,""" +
                        """"name":null,"imageUrl":null$provisionedField},""" +
                        """"activeOrg":null,"organizations":[],"session":null}""",
                ),
        )
    }

    // JUnit fail() 返回 Unit 无法用于 Elvis 收敛可空性, 直接用 !! (5s 超时未到请求才为 null)
    private fun takeRequest() = server.takeRequest(5, TimeUnit.SECONDS)!!

    @Test
    fun `signInAnonymously creates guest session and persists cookie`() = runBlocking {
        enqueueGuestResponse()
        enqueueMeResponse()

        val session = manager.signInAnonymously()

        assertEquals("sess_1", session.sessionId)
        assertEquals("u_guest", session.user.sub)
        assertTrue(session.user.isAnonymous)
        assertTrue(session.isAnonymous)

        val guestRequest = takeRequest()
        assertEquals("POST", guestRequest.method)
        assertEquals("/auth/guest", guestRequest.path)
        assertEquals("{}", guestRequest.body.readUtf8())

        val meRequest = takeRequest()
        assertEquals("GET", meRequest.method)
        assertEquals("/v1/me", meRequest.path)
        // 会话 cookie 重放: 只保留 name=value, 剥离 Path/HttpOnly 等属性
        assertEquals("xid_rt_sess_1=opaque-token", meRequest.getHeader("Cookie"))

        // 持久化后可无网络恢复
        val restored = manager.loadSession()
        assertNotNull(restored)
        assertEquals("sess_1", restored!!.sessionId)
        assertEquals("u_guest", restored.user.sub)
        assertTrue(restored.user.isAnonymous)
        assertEquals(2, server.requestCount)
    }

    @Test
    fun `signInAnonymously is lazy when a guest session already exists`() = runBlocking {
        enqueueGuestResponse()
        enqueueMeResponse()
        val first = manager.signInAnonymously()
        assertEquals(2, server.requestCount)

        val second = manager.signInAnonymously()

        assertEquals(first.sessionId, second.sessionId)
        assertEquals(first.user.sub, second.user.sub)
        // 惰性复用: 已有会话不发任何请求
        assertEquals(2, server.requestCount)
    }

    @Test
    fun `signInAnonymously sends turnstileToken when provided`() = runBlocking {
        enqueueGuestResponse()
        enqueueMeResponse()

        manager.signInAnonymously(turnstileToken = "ts-token-123")

        val guestRequest = takeRequest()
        assertEquals("""{"turnstileToken":"ts-token-123"}""", guestRequest.body.readUtf8())
    }

    @Test
    fun `signInAnonymously throws GuestSignInFailed on http error`() = runBlocking {
        enqueueGuestResponse(code = 500)

        try {
            manager.signInAnonymously()
            fail("expected GuestSignInFailed")
        } catch (e: XidException.GuestSignInFailed) {
            assertTrue(e.message!!.contains("500"))
        }
        // 失败后不落盘, 重试不会被误判为已有会话
        assertNull(manager.loadSession())
    }

    @Test
    fun `signInAnonymously throws when response carries no session cookie`() = runBlocking {
        enqueueGuestResponse(withCookie = false)

        try {
            manager.signInAnonymously()
            fail("expected GuestSignInFailed")
        } catch (e: XidException.GuestSignInFailed) {
            // expected
        }
        assertNull(manager.loadSession())
    }

    @Test
    fun `signInAnonymously throws when me returns no user`() = runBlocking {
        enqueueGuestResponse()
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"user":null,"activeOrg":null,"organizations":[],"session":null}"""),
        )

        try {
            manager.signInAnonymously()
            fail("expected GuestSignInFailed")
        } catch (e: XidException.GuestSignInFailed) {
            // expected
        }
        assertNull(manager.loadSession())
    }

    @Test
    fun `signInAnonymously throws when me request fails`() = runBlocking {
        enqueueGuestResponse()
        server.enqueue(MockResponse().setResponseCode(401))

        try {
            manager.signInAnonymously()
            fail("expected GuestSignInFailed")
        } catch (e: XidException.GuestSignInFailed) {
            // expected
        }
    }

    @Test
    fun `isAnonymous falls back to guest context when me omits provisioned_by`() = runBlocking {
        enqueueGuestResponse()
        enqueueMeResponse(provisionedBy = null)

        val session = manager.signInAnonymously()

        // /v1/me 未携带 provisioned_by 时, guest 登录上下文兜底为 anonymous
        assertTrue(session.user.isAnonymous)
        assertEquals("anonymous", session.user.provisionedBy)
    }

    @Test
    fun `clear removes persisted guest session`() = runBlocking {
        enqueueGuestResponse()
        enqueueMeResponse()
        manager.signInAnonymously()
        assertNotNull(manager.loadSession())

        GuestAuthManager.clear(storage)

        assertNull(manager.loadSession())
    }

    @Test
    fun `guest user exposes sub for continuity comparison`() = runBlocking {
        enqueueGuestResponse()
        enqueueMeResponse(userId = "u_continuity")

        val session = manager.signInAnonymously()

        // 调用方凭 user.sub 对比转正前后的用户连续性
        assertEquals("u_continuity", session.user.sub)
        assertFalse(session.user.emailVerified)
    }
}
