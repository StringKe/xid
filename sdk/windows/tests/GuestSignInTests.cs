// GuestSignInTests.cs
// XID Windows SDK 单元测试
//
// 覆盖:
//   - SignInAnonymouslyAsync 建号:POST /auth/guest 请求形状 / Set-Cookie 捕获 / /v1/me 带 Cookie 头
//   - 返回会话暴露 IsAnonymous,token 字段为 null
//   - 会话持久化到 ITokenStorage(StoredTokenSet.Guest)
//   - 惰性语义:已有 guest 会话(内存 / 持久存储)时不发请求直接复用
//   - 失败路径:429 rate_limited / /v1/me 401 / 响应缺少会话 cookie

using System.Net;
using System.Text;

namespace Xid.Windows.Tests;

public class GuestSignInTests
{
    private const string Issuer = "https://xid.dev";
    private const string SessionCookie = "__Host-xid.rt.abcdef12=opaque-token-value";

    // -- 辅助:构造已注入 mock 的 client --

    private static XidClient CreateClient(GuestMockHandler handler, InMemoryGuestStorage storage)
    {
        var ctor = typeof(XidClient).GetConstructor(
            System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance,
            null, Type.EmptyTypes, null);
        var client = (XidClient)ctor!.Invoke([]);

        client.Configure(new XidConfiguration
        {
            Issuer = new Uri(Issuer),
            ClientId = "test-client",
            RedirectUri = "myapp://auth/callback",
        });
        client.SetTokenStorage(storage);
        client.SetGuestAuthClient(new GuestAuthClient(new HttpClient(handler), new Uri(Issuer)));
        return client;
    }

    // -- 建号:请求形状 / cookie 捕获 / user 暴露 IsAnonymous / 持久化 --

    [Fact]
    public async Task SignInAnonymously_CreatesGuestSession()
    {
        var handler = new GuestMockHandler();
        var storage = new InMemoryGuestStorage();
        XidClient client = CreateClient(handler, storage);

        XidSession session = await client.SignInAnonymouslyAsync(
            new SignInAnonymouslyOptions { TurnstileToken = "ts-token-1" });

        // POST /auth/guest 请求形状
        Assert.Equal(2, handler.Requests.Count);
        RecordedRequest guestReq = handler.Requests[0];
        Assert.Equal(HttpMethod.Post, guestReq.Method);
        Assert.Equal("/auth/guest", guestReq.Path);
        Assert.Equal("{\"turnstileToken\":\"ts-token-1\"}", guestReq.Body);

        // /v1/me 必须带捕获到的会话 cookie
        RecordedRequest meReq = handler.Requests[1];
        Assert.Equal(HttpMethod.Get, meReq.Method);
        Assert.Equal("/v1/me", meReq.Path);
        Assert.Equal(SessionCookie, meReq.Cookie);

        // 会话暴露 guest 判定,token 字段为 null
        Assert.True(session.IsAnonymous);
        Assert.True(session.User.IsAnonymous);
        Assert.Equal("anonymous", session.User.ProvisionedBy);
        Assert.Equal("guest-user-1", session.User.Sub);
        Assert.Equal("sess-123", session.SessionId);
        Assert.Equal(SessionCookie, session.SessionCookie);
        Assert.Null(session.AccessToken);
        Assert.Null(session.IdToken);
        Assert.Null(session.ExpiresAt);

        // 会话凭证已持久化
        StoredTokenSet? stored = await storage.LoadAsync();
        Assert.NotNull(stored?.Guest);
        Assert.Equal("sess-123", stored!.Guest!.SessionId);
        Assert.Equal(SessionCookie, stored.Guest.SessionCookie);
        Assert.Equal("guest-user-1", stored.Guest.Sub);
        Assert.Equal("anonymous", stored.Guest.ProvisionedBy);
    }

    // -- 不传 TurnstileToken 时 body 为 {} --

    [Fact]
    public async Task SignInAnonymously_WithoutTurnstile_SendsEmptyObject()
    {
        var handler = new GuestMockHandler();
        XidClient client = CreateClient(handler, new InMemoryGuestStorage());

        await client.SignInAnonymouslyAsync();

        Assert.Equal("{}", handler.Requests[0].Body);
    }

    // -- 惰性:内存中已有 guest 会话时不发请求 --

    [Fact]
    public async Task SignInAnonymously_ExistingSession_ReusesWithoutRequest()
    {
        var handler = new GuestMockHandler();
        XidClient client = CreateClient(handler, new InMemoryGuestStorage());

        XidSession first = await client.SignInAnonymouslyAsync();
        int requestCount = handler.Requests.Count;

        XidSession second = await client.SignInAnonymouslyAsync();

        Assert.Equal(requestCount, handler.Requests.Count);
        Assert.Equal(first.User.Sub, second.User.Sub);
        Assert.True(second.IsAnonymous);
    }

    // -- 惰性:持久存储中的 guest 会话恢复后复用,不发请求 --

    [Fact]
    public async Task SignInAnonymously_PersistedGuestSession_RestoresWithoutRequest()
    {
        var storage = new InMemoryGuestStorage();
        var first = new GuestMockHandler();
        XidClient client1 = CreateClient(first, storage);
        XidSession created = await client1.SignInAnonymouslyAsync();

        // 新 client 实例(内存为空),同一份持久存储
        var second = new GuestMockHandler();
        XidClient client2 = CreateClient(second, storage);
        XidSession restored = await client2.SignInAnonymouslyAsync();

        Assert.Empty(second.Requests);
        Assert.Equal(created.User.Sub, restored.User.Sub);
        Assert.Equal(created.SessionId, restored.SessionId);
        Assert.True(restored.IsAnonymous);
    }

    // -- GetSession 也能恢复 guest 会话 --

    [Fact]
    public async Task GetSession_RestoresPersistedGuestSession()
    {
        var storage = new InMemoryGuestStorage();
        XidClient client1 = CreateClient(new GuestMockHandler(), storage);
        await client1.SignInAnonymouslyAsync();

        var handler = new GuestMockHandler();
        XidClient client2 = CreateClient(handler, storage);
        XidSession? session = await client2.GetSession();

        Assert.Empty(handler.Requests);
        Assert.NotNull(session);
        Assert.True(session!.IsAnonymous);
        Assert.Equal("guest-user-1", session.User.Sub);
        Assert.Null(await client2.GetAccessToken());
    }

    // -- 失败:/auth/guest 429 rate_limited --

    [Fact]
    public async Task SignInAnonymously_RateLimited_ThrowsWithCode()
    {
        var handler = new GuestMockHandler
        {
            GuestStatus = HttpStatusCode.TooManyRequests,
            GuestBody = "{\"error\":{\"code\":\"rate_limited\",\"message\":\"too many\"}}",
            GuestSetCookie = false,
        };
        XidClient client = CreateClient(handler, new InMemoryGuestStorage());

        var ex = await Assert.ThrowsAsync<GuestSignInException>(() => client.SignInAnonymouslyAsync());
        Assert.Equal("rate_limited", ex.Code);
    }

    // -- 失败:/v1/me 401 --

    [Fact]
    public async Task SignInAnonymously_MeUnauthorized_Throws()
    {
        var handler = new GuestMockHandler { MeStatus = HttpStatusCode.Unauthorized };
        XidClient client = CreateClient(handler, new InMemoryGuestStorage());

        await Assert.ThrowsAsync<GuestSignInException>(() => client.SignInAnonymouslyAsync());
    }

    // -- 失败:响应缺少会话 cookie --

    [Fact]
    public async Task SignInAnonymously_MissingSessionCookie_Throws()
    {
        var handler = new GuestMockHandler { GuestSetCookie = false };
        XidClient client = CreateClient(handler, new InMemoryGuestStorage());

        await Assert.ThrowsAsync<GuestSignInException>(() => client.SignInAnonymouslyAsync());
    }

    // -- SignOut 清除 guest 会话 --

    [Fact]
    public async Task SignOut_ClearsGuestSession()
    {
        var storage = new InMemoryGuestStorage();
        XidClient client = CreateClient(new GuestMockHandler(), storage);
        await client.SignInAnonymouslyAsync();

        await client.SignOut();

        Assert.Null(await storage.LoadAsync());
        Assert.Null(await client.GetSession());
    }
}

// ---- 测试辅助实现 ----

internal sealed record RecordedRequest(HttpMethod Method, string Path, string? Body, string? Cookie);

/// <summary>mock /auth/guest 与 /v1/me 的 HTTP handler。</summary>
internal sealed class GuestMockHandler : HttpMessageHandler
{
    public List<RecordedRequest> Requests { get; } = [];

    public HttpStatusCode GuestStatus { get; init; } = HttpStatusCode.Created;
    public string GuestBody { get; init; } = "{\"sessionId\":\"sess-123\"}";
    public bool GuestSetCookie { get; init; } = true;

    public HttpStatusCode MeStatus { get; init; } = HttpStatusCode.OK;
    public string MeBody { get; init; } =
        "{\"user\":{\"id\":\"guest-user-1\",\"email\":null,\"name\":null,\"imageUrl\":null,\"provisioned_by\":\"anonymous\"}}";

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken ct)
    {
        string? body = request.Content is null
            ? null
            : await request.Content.ReadAsStringAsync(ct);
        string? cookie = request.Headers.TryGetValues("Cookie", out IEnumerable<string>? values)
            ? string.Join("; ", values)
            : null;
        Requests.Add(new RecordedRequest(request.Method, request.RequestUri!.AbsolutePath, body, cookie));

        if (request.RequestUri.AbsolutePath == "/auth/guest")
        {
            var response = new HttpResponseMessage(GuestStatus)
            {
                Content = new StringContent(GuestBody, Encoding.UTF8, "application/json"),
            };
            if (GuestSetCookie)
            {
                response.Headers.TryAddWithoutValidation(
                    "Set-Cookie",
                    "__Host-xid.rt.abcdef12=opaque-token-value; Path=/; HttpOnly; Secure; SameSite=Lax");
            }
            return response;
        }

        if (request.RequestUri.AbsolutePath == "/v1/me")
        {
            return new HttpResponseMessage(MeStatus)
            {
                Content = new StringContent(MeBody, Encoding.UTF8, "application/json"),
            };
        }

        return new HttpResponseMessage(HttpStatusCode.NotFound);
    }
}

/// <summary>内存 token 存储,测试用。</summary>
internal sealed class InMemoryGuestStorage : ITokenStorage
{
    private StoredTokenSet? _stored;

    public Task SaveAsync(StoredTokenSet tokens, CancellationToken ct = default)
    {
        _stored = tokens;
        return Task.CompletedTask;
    }

    public Task<StoredTokenSet?> LoadAsync(CancellationToken ct = default) =>
        Task.FromResult(_stored);

    public Task ClearAsync(CancellationToken ct = default)
    {
        _stored = null;
        return Task.CompletedTask;
    }
}
