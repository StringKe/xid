// GuestAuthClient.cs
// XID Windows SDK
//
// 匿名访客 (guest) 登录的 HTTP 交互:
//   GET {issuer}/auth/config?intent=sign-up -> 取一次性 capability
//   POST {issuer}/auth/guest -> 捕获 __Host-xid.rt.* Set-Cookie -> GET {issuer}/v1/me
//
// cookie 处理:底层 handler 关闭 UseCookies,Set-Cookie 不经 CookieContainer 吞掉,
// 由本类显式解析并拼成 Cookie 头回传。原因:
//   1. 会话凭证要交给 ITokenStorage 持久化,不能藏在进程内 cookie 容器里;
//   2. 测试可用纯 HttpMessageHandler mock,不依赖平台 cookie 设施。

using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Xid.Windows;

/// <summary>guest 会话 cookie 名前缀(__Host-xid.rt.{sessionId 前缀},见服务端 cookies.ts)。</summary>
internal static class GuestSessionCookie
{
    internal const string Prefix = "__Host-xid.rt.";
}

// -- 响应 DTO --

internal sealed class GuestSignInResponse
{
    [JsonPropertyName("sessionId")]
    public string? SessionId { get; init; }
}

internal sealed class GuestCapabilityResponse
{
    [JsonPropertyName("guest")]
    public GuestCapability? Guest { get; init; }
}

internal sealed class GuestCapability
{
    [JsonPropertyName("capabilityToken")]
    public string? CapabilityToken { get; init; }
}

internal sealed class MeResponse
{
    [JsonPropertyName("user")]
    public MeUser? User { get; init; }
}

internal sealed class MeUser
{
    [JsonPropertyName("id")]
    public string? Id { get; init; }

    [JsonPropertyName("email")]
    public string? Email { get; init; }

    [JsonPropertyName("emailVerified")]
    public bool? EmailVerified { get; init; }

    [JsonPropertyName("name")]
    public string? Name { get; init; }

    [JsonPropertyName("imageUrl")]
    public string? ImageUrl { get; init; }

    [JsonPropertyName("provisioned_by")]
    public string? ProvisionedBy { get; init; }
}

/// <summary>guest 登录结果:会话凭证 + 用户信息。</summary>
internal sealed record GuestAuthResult(
    string SessionId,
    string SessionCookie,
    MeUser User);

// -- 端点客户端 --

internal sealed class GuestAuthClient
{
    private readonly HttpClient _http;
    private readonly Uri _issuer;

    internal GuestAuthClient(HttpClient http, Uri issuer)
    {
        _http = http;
        _issuer = issuer;
    }

    /// <summary>
    /// 获取一次性 capability 后 POST /auth/guest 建立(或续签)guest 会话,
    /// 再用会话 cookie 调 /v1/me 取用户信息。capability 不缓存或复用。
    /// </summary>
    internal async Task<GuestAuthResult> SignInAnonymouslyAsync(
        string? turnstileToken,
        CancellationToken ct = default)
    {
        string capabilityToken = await FetchGuestCapabilityAsync(ct).ConfigureAwait(false);
        Uri guestUri = new($"{_issuer.ToString().TrimEnd('/')}/auth/guest");
        Uri meUri = new($"{_issuer.ToString().TrimEnd('/')}/v1/me");

        var payload = new Dictionary<string, string>
        {
            ["capabilityToken"] = capabilityToken,
        };
        if (turnstileToken is not null)
            payload["turnstileToken"] = turnstileToken;
        string json = JsonSerializer.Serialize(payload);

        HttpResponseMessage guestResponse;
        try
        {
            using var content = new StringContent(json, Encoding.UTF8, "application/json");
            using var request = new HttpRequestMessage(HttpMethod.Post, guestUri) { Content = content };
            request.Headers.CacheControl = new CacheControlHeaderValue { NoStore = true };
            guestResponse = await _http.SendAsync(request, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            throw new GuestSignInException("无法访问 /auth/guest 端点。", inner: ex);
        }

        using (guestResponse)
        {
            string body = await guestResponse.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            if (!guestResponse.IsSuccessStatusCode)
                throw GuestSignInException.FromResponse(guestResponse.StatusCode, body);

            GuestSignInResponse? parsed = TryDeserialize<GuestSignInResponse>(body);
            if (string.IsNullOrEmpty(parsed?.SessionId))
                throw new GuestSignInException("/auth/guest 响应缺少 sessionId。");

            string cookie = ExtractSessionCookie(guestResponse)
                ?? throw new GuestSignInException("/auth/guest 响应未携带会话 cookie。");

            MeUser user = await FetchMeAsync(meUri, cookie, ct).ConfigureAwait(false);
            return new GuestAuthResult(parsed.SessionId, cookie, user);
        }
    }

    private async Task<string> FetchGuestCapabilityAsync(CancellationToken ct)
    {
        Uri configUri = new($"{_issuer.ToString().TrimEnd('/')}/auth/config?intent=sign-up");
        HttpResponseMessage response;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, configUri);
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            request.Headers.CacheControl = new CacheControlHeaderValue { NoStore = true };
            response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            throw new GuestSignInException("无法访问 /auth/config 端点。", inner: ex);
        }

        using (response)
        {
            string body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
                throw GuestSignInException.FromResponse(response.StatusCode, body);

            GuestCapabilityResponse? parsed = TryDeserialize<GuestCapabilityResponse>(body);
            string? token = parsed?.Guest?.CapabilityToken;
            if (string.IsNullOrWhiteSpace(token))
                throw new GuestSignInException("/auth/config 未提供 guest capability。");
            return token;
        }
    }

    private async Task<MeUser> FetchMeAsync(Uri meUri, string sessionCookie, CancellationToken ct)
    {
        HttpResponseMessage response;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, meUri);
            request.Headers.TryAddWithoutValidation("Cookie", sessionCookie);
            response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            throw new GuestSignInException("无法访问 /v1/me 端点。", inner: ex);
        }

        using (response)
        {
            string body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
                throw GuestSignInException.FromResponse(response.StatusCode, body);

            MeResponse? me = TryDeserialize<MeResponse>(body);
            if (string.IsNullOrEmpty(me?.User?.Id))
                throw new GuestSignInException("/v1/me 响应缺少用户信息。");
            return me.User;
        }
    }

    // 从 Set-Cookie 头中提取 __Host-xid.rt.* 会话 cookie,返回 name=value。
    private static string? ExtractSessionCookie(HttpResponseMessage response)
    {
        if (!response.Headers.TryGetValues("Set-Cookie", out IEnumerable<string>? values))
            return null;

        foreach (string header in values)
        {
            // Set-Cookie 格式:name=value; Attr=...
            int semicolon = header.IndexOf(';');
            string pair = (semicolon >= 0 ? header[..semicolon] : header).Trim();
            if (pair.StartsWith(GuestSessionCookie.Prefix, StringComparison.Ordinal))
                return pair;
        }
        return null;
    }

    private static T? TryDeserialize<T>(string json)
    {
        try { return JsonSerializer.Deserialize<T>(json); }
        catch { return default; }
    }
}

/// <summary>guest 登录失败(/auth/guest 或 /v1/me 调用失败)。</summary>
public sealed class GuestSignInException : XidException
{
    public GuestSignInException(string message, string code = "guest_sign_in_failed", Exception? inner = null)
        : base(message, code, inner) { }

    // 服务端错误体为 XidAPIError JSON;解析不到 code 时回退 HTTP 状态码,避免泄露响应体细节。
    internal static GuestSignInException FromResponse(System.Net.HttpStatusCode status, string body)
    {
        string? code = TryReadErrorCode(body);
        return new GuestSignInException(
            $"guest 登录失败 (HTTP {(int)status})。",
            code ?? "guest_sign_in_failed");
    }

    private static string? TryReadErrorCode(string body)
    {
        try
        {
            using JsonDocument doc = JsonDocument.Parse(body);
            JsonElement root = doc.RootElement;
            // 兼容 { "error": { "code": ... } } 与 { "code": ... } 两种形状
            if (root.TryGetProperty("error", out JsonElement err) &&
                err.ValueKind == JsonValueKind.Object &&
                err.TryGetProperty("code", out JsonElement c) &&
                c.ValueKind == JsonValueKind.String)
                return c.GetString();
            if (root.TryGetProperty("code", out JsonElement code) &&
                code.ValueKind == JsonValueKind.String)
                return code.GetString();
        }
        catch (JsonException)
        {
            // 非 JSON 错误体:走默认 code
        }
        return null;
    }
}
