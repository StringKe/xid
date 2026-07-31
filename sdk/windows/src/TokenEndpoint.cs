// TokenEndpoint.cs
// XID Windows SDK
// Status: implemented; compiled and unit-tested locally, real IdP round-trip pending
//
// /token 端点交互:
//   - authorization_code + PKCE 换 token

using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Xid.Windows;

// -- 响应 DTO --

internal sealed class TokenResponse
{
    [JsonPropertyName("access_token")]
    public required string AccessToken { get; init; }

    [JsonPropertyName("token_type")]
    public required string TokenType { get; init; }

    [JsonPropertyName("expires_in")]
    public int ExpiresIn { get; init; }

    [JsonPropertyName("id_token")]
    public string? IdToken { get; init; }

    [JsonPropertyName("scope")]
    public string? Scope { get; init; }
}

internal sealed class OAuthErrorResponse
{
    [JsonPropertyName("error")]
    public required string Error { get; init; }

    [JsonPropertyName("error_description")]
    public string? ErrorDescription { get; init; }
}

// -- 端点客户端 --

internal sealed class TokenEndpointClient
{
    private readonly HttpClient _http;
    private readonly string _clientId;

    internal TokenEndpointClient(HttpClient http, string clientId)
    {
        _http = http;
        _clientId = clientId;
    }

    /// <summary>
    /// authorization_code grant (PKCE S256)。
    /// </summary>
    internal async Task<TokenResponse> ExchangeCodeAsync(
        Uri tokenEndpoint,
        string code,
        string redirectUri,
        string codeVerifier,
        CancellationToken ct = default)
    {
        var form = new Dictionary<string, string>
        {
            ["grant_type"] = "authorization_code",
            ["client_id"] = _clientId,
            ["code"] = code,
            ["redirect_uri"] = redirectUri,
            ["code_verifier"] = codeVerifier,
        };
        return await PostFormAsync(tokenEndpoint, form, ct).ConfigureAwait(false);
    }

    private async Task<TokenResponse> PostFormAsync(
        Uri endpoint,
        Dictionary<string, string> form,
        CancellationToken ct)
    {
        using var content = new FormUrlEncodedContent(form);
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint) { Content = content };
        // RFC 6749 Section 5.1:token 端点响应不应被缓存
        request.Headers.CacheControl = new CacheControlHeaderValue { NoStore = true };

        HttpResponseMessage response;
        try
        {
            response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            throw new TokenExchangeException("无法访问 /token 端点。", inner: ex);
        }

        string body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
        {
            OAuthErrorResponse? err = TryDeserialize<OAuthErrorResponse>(body);
            throw new TokenExchangeException(
                err?.ErrorDescription ?? $"HTTP {(int)response.StatusCode}",
                err?.Error);
        }

        TokenResponse? token = TryDeserialize<TokenResponse>(body);
        if (token is null)
            throw new TokenExchangeException("token 响应 JSON 解析失败。");

        return token;
    }

    private static T? TryDeserialize<T>(string json)
    {
        try { return JsonSerializer.Deserialize<T>(json); }
        catch { return default; }
    }
}
