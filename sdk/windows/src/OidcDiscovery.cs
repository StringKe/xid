// OidcDiscovery.cs
// XID Windows SDK
// Status: implemented; compiled and unit-tested locally, real IdP round-trip pending
//
// OIDC Discovery 文档拉取与缓存。
// GET {issuer}/.well-known/openid-configuration

using System.Text.Json;
using System.Text.Json.Serialization;

namespace Xid.Windows;

/// <summary>
/// OIDC Discovery 文档 (/.well-known/openid-configuration) 关键字段。
/// </summary>
internal sealed class OidcDiscoveryDocument
{
    [JsonPropertyName("issuer")]
    public required string Issuer { get; init; }

    [JsonPropertyName("authorization_endpoint")]
    public required string AuthorizationEndpoint { get; init; }

    [JsonPropertyName("token_endpoint")]
    public required string TokenEndpoint { get; init; }

    [JsonPropertyName("end_session_endpoint")]
    public string? EndSessionEndpoint { get; init; }

    [JsonPropertyName("jwks_uri")]
    public required string JwksUri { get; init; }
}

/// <summary>
/// OIDC Discovery 文档加载器,带简单内存缓存 (TTL 1 小时)。
/// </summary>
internal sealed class OidcDiscovery
{
    private static readonly TimeSpan CacheTtl = TimeSpan.FromHours(1);

    private readonly HttpClient _http;
    private readonly Uri _discoveryUrl;

    private OidcDiscoveryDocument? _cached;
    private DateTimeOffset _cachedAt = DateTimeOffset.MinValue;

    internal OidcDiscovery(HttpClient http, Uri issuer)
    {
        _http = http;
        // issuer 末尾不带斜线
        string baseUrl = issuer.ToString().TrimEnd('/');
        _discoveryUrl = new Uri(baseUrl + "/.well-known/openid-configuration");
    }

    /// <summary>
    /// 获取 Discovery 文档。命中缓存则直接返回,否则发起 HTTP GET。
    /// </summary>
    internal async Task<OidcDiscoveryDocument> GetAsync(CancellationToken ct = default)
    {
        if (_cached is not null && DateTimeOffset.UtcNow - _cachedAt < CacheTtl)
            return _cached;

        OidcDiscoveryDocument doc = await FetchAsync(ct).ConfigureAwait(false);
        _cached = doc;
        _cachedAt = DateTimeOffset.UtcNow;
        return doc;
    }

    private async Task<OidcDiscoveryDocument> FetchAsync(CancellationToken ct)
    {
        HttpResponseMessage response;
        try
        {
            response = await _http.GetAsync(_discoveryUrl, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            throw new DiscoveryException($"无法访问 OIDC Discovery 端点: {_discoveryUrl}", ex);
        }

        if (!response.IsSuccessStatusCode)
        {
            throw new DiscoveryException(
                $"OIDC Discovery 端点返回 HTTP {(int)response.StatusCode}。");
        }

        string json = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        OidcDiscoveryDocument? doc;
        try
        {
            doc = JsonSerializer.Deserialize<OidcDiscoveryDocument>(json);
        }
        catch (JsonException ex)
        {
            throw new DiscoveryException("OIDC Discovery 文档 JSON 解析失败。", ex);
        }

        if (doc is null)
            throw new DiscoveryException("OIDC Discovery 文档为空。");

        return doc;
    }
}
