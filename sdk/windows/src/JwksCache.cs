// JWKS 拉取与内存缓存(Windows 客户端 SDK)
//
// 支持 ES256(主)和 RS256/PS256(兼容),与 XID 协议约定的算法白名单对齐。

using Microsoft.IdentityModel.Tokens;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Xid.Windows;

internal sealed partial class JwksCache : IDisposable
{
    private readonly string _jwksUri;
    private readonly TimeSpan _ttl;
    private readonly HttpClient _httpClient;
    private readonly bool _ownsHttpClient;
    private readonly SemaphoreSlim _refreshLock = new(1, 1);

    private volatile Dictionary<string, SecurityKey> _keys = new(StringComparer.Ordinal);
    private long _fetchedAtTicks;

    internal JwksCache(string jwksUri, TimeSpan? ttl = null, HttpClient? httpClient = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(jwksUri);
        _jwksUri = jwksUri;
        _ttl = ttl ?? TimeSpan.FromHours(1);
        if (httpClient is not null)
        {
            _httpClient = httpClient;
            _ownsHttpClient = false;
        }
        else
        {
            _httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
            _ownsHttpClient = true;
        }
    }

    private bool IsStale() =>
        Environment.TickCount64 - Interlocked.Read(ref _fetchedAtTicks) >= (long)_ttl.TotalMilliseconds;

    internal async Task<SecurityKey> GetKeyAsync(string kid, CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(kid);

        if (!IsStale() && _keys.TryGetValue(kid, out var cached))
            return cached;

        await _refreshLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (!IsStale() && _keys.TryGetValue(kid, out cached))
                return cached;

            await RefreshAsync(ct).ConfigureAwait(false);

            if (!_keys.TryGetValue(kid, out var key))
                throw new TokenVerificationException(
                    $"Public key not found for kid='{kid}'.");

            return key;
        }
        finally
        {
            _refreshLock.Release();
        }
    }

    internal void Invalidate() => Interlocked.Exchange(ref _fetchedAtTicks, 0);

    private async Task RefreshAsync(CancellationToken ct)
    {
        try
        {
            using var resp = await _httpClient.GetAsync(_jwksUri, ct).ConfigureAwait(false);
            resp.EnsureSuccessStatusCode();
            var rawJson = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            var doc = JsonSerializer.Deserialize(rawJson, JwksDocumentContext.Default.JwksDocument)
                ?? throw new JwksException("JWKS response deserialized to null.");
            ApplyKeys(doc);
        }
        catch (JwksException)
        {
            throw;
        }
        catch (Exception ex)
        {
            throw new JwksException($"JWKS fetch failed: {ex.Message}", ex);
        }
    }

    private void ApplyKeys(JwksDocument doc)
    {
        var newKeys = new Dictionary<string, SecurityKey>(StringComparer.Ordinal);
        foreach (var jwk in doc.Keys ?? Array.Empty<JsonWebKeyEntry>())
        {
            if (string.IsNullOrEmpty(jwk.Kid))
                continue;

            var secKey = BuildSecurityKey(jwk);
            if (secKey is not null)
                newKeys[jwk.Kid] = secKey;
        }

        _keys = newKeys;
        Interlocked.Exchange(ref _fetchedAtTicks, Environment.TickCount64);
    }

    private static SecurityKey? BuildSecurityKey(JsonWebKeyEntry jwk)
    {
        switch (jwk.Kty)
        {
            case "EC":
            {
                if (string.IsNullOrEmpty(jwk.X) || string.IsNullOrEmpty(jwk.Y))
                    return null;

                var ecdsa = ECDsa.Create();
                ecdsa.ImportParameters(new ECParameters
                {
                    Curve = jwk.Crv switch
                    {
                        "P-384" => ECCurve.NamedCurves.nistP384,
                        "P-521" => ECCurve.NamedCurves.nistP521,
                        _ => ECCurve.NamedCurves.nistP256,
                    },
                    Q = new ECPoint
                    {
                        X = Base64UrlEncoder.DecodeBytes(jwk.X),
                        Y = Base64UrlEncoder.DecodeBytes(jwk.Y),
                    },
                });
                return new ECDsaSecurityKey(ecdsa) { KeyId = jwk.Kid };
            }

            case "RSA":
            {
                if (string.IsNullOrEmpty(jwk.N) || string.IsNullOrEmpty(jwk.E))
                    return null;

                var rsa = RSA.Create();
                rsa.ImportParameters(new RSAParameters
                {
                    Modulus = Base64UrlEncoder.DecodeBytes(jwk.N),
                    Exponent = Base64UrlEncoder.DecodeBytes(jwk.E),
                });
                return new RsaSecurityKey(rsa) { KeyId = jwk.Kid };
            }

            default:
                return null;
        }
    }

    public void Dispose()
    {
        if (_ownsHttpClient)
            _httpClient.Dispose();
        _refreshLock.Dispose();
    }

    private sealed record JwksDocument
    {
        [JsonPropertyName("keys")]
        public JsonWebKeyEntry[]? Keys { get; init; }
    }

    private sealed record JsonWebKeyEntry
    {
        [JsonPropertyName("kid")] public string? Kid { get; init; }
        [JsonPropertyName("kty")] public string? Kty { get; init; }
        [JsonPropertyName("crv")] public string? Crv { get; init; }
        [JsonPropertyName("x")] public string? X { get; init; }
        [JsonPropertyName("y")] public string? Y { get; init; }
        [JsonPropertyName("n")] public string? N { get; init; }
        [JsonPropertyName("e")] public string? E { get; init; }
    }

    [JsonSerializable(typeof(JwksDocument))]
    [JsonSourceGenerationOptions(PropertyNameCaseInsensitive = false)]
    private sealed partial class JwksDocumentContext : JsonSerializerContext;
}