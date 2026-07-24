// JWKS 拉取与内存缓存
//
// 支持 ES256(主)和 RS256/PS256(兼容),与 XID 协议约定的算法白名单对齐。
// 缓存策略:内存 TTL 默认 3600 秒,与服务端 KV 端 JWKS 缓存 TTL 对齐。
// 线程安全:SemaphoreSlim 保护刷新路径,避免并发请求同时击穿源站。
//
using Microsoft.Extensions.Logging;
using Microsoft.IdentityModel.Tokens;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Xid;

/// <summary>
/// 从 JWKS endpoint 拉取公钥并按 kid 缓存。
/// 实例可安全地跨请求共享(线程安全)。
/// </summary>
public sealed partial class JwksCache : IDisposable
{
    // 算法白名单 -- 对应 XID 协议约定的 ES256/RS256/PS256
    private static readonly HashSet<string> SupportedAlgorithms =
        new(StringComparer.Ordinal) { SecurityAlgorithms.EcdsaSha256, SecurityAlgorithms.RsaSha256, SecurityAlgorithms.RsaSsaPssSha256 };

    private readonly string _jwksUri;
    private readonly TimeSpan _ttl;
    private readonly HttpClient _httpClient;
    private readonly bool _ownsHttpClient;
    private readonly ILogger<JwksCache>? _logger;
    private readonly IJwksExternalCache? _externalCache;
    private readonly string _externalCacheKey;
    private readonly SemaphoreSlim _refreshLock = new(1, 1);

    // kid -> SecurityKey
    private volatile Dictionary<string, SecurityKey> _keys = new();
    private long _fetchedAtTicks; // Environment.TickCount64

    /// <param name="jwksUri">JWKS endpoint 完整 URI,例如 https://xid.dev/jwks</param>
    /// <param name="ttl">缓存有效期,默认 1 小时</param>
    /// <param name="httpClient">可选:外部托管的 HttpClient;传 null 时内部自建</param>
    public JwksCache(
        string jwksUri,
        TimeSpan? ttl = null,
        HttpClient? httpClient = null,
        ILogger<JwksCache>? logger = null,
        IJwksExternalCache? externalCache = null,
        string? externalCacheKey = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(jwksUri);
        _jwksUri = jwksUri;
        _ttl = ttl ?? TimeSpan.FromHours(1);
        _logger = logger;
        _externalCache = externalCache;
        _externalCacheKey = externalCacheKey ?? jwksUri;
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

    /// <summary>
    /// 按 kid 取公钥。命中缓存且未过期直接返回;否则先刷新 JWKS。
    /// 刷新后仍找不到 kid 时抛 <see cref="TokenVerificationException"/>。
    /// </summary>
    public async Task<SecurityKey> GetKeyAsync(string kid, CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(kid);

        // 快路径:缓存命中且未过期
        if (!IsStale() && _keys.TryGetValue(kid, out var cached))
            return cached;

        await _refreshLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            // 双重检查:另一个线程可能已刷新完毕
            if (!IsStale() && _keys.TryGetValue(kid, out cached))
                return cached;

            await RefreshAsync(ct).ConfigureAwait(false);

            if (!_keys.TryGetValue(kid, out var key))
                throw new TokenVerificationException(
                    $"Public key not found for kid='{kid}'. " +
                    "The token may use a rotated key not yet published, or the kid is invalid.");

            return key;
        }
        finally
        {
            _refreshLock.Release();
        }
    }

    /// <summary>
    /// 强制清空缓存,下次 GetKeyAsync 必定重新拉取 JWKS。
    /// 适用于主动感知密钥轮换的场景。
    /// </summary>
    public void Invalidate() => Interlocked.Exchange(ref _fetchedAtTicks, 0);

    private async Task RefreshAsync(CancellationToken ct)
    {
        JwksDocument doc;
        try
        {
            if (_externalCache is not null)
            {
                var cachedJson = await _externalCache.GetAsync(_externalCacheKey, ct).ConfigureAwait(false);
                if (!string.IsNullOrEmpty(cachedJson))
                {
                    doc = JsonSerializer.Deserialize(cachedJson, JwksDocumentContext.Default.JwksDocument)
                        ?? throw new JwksException("External JWKS cache deserialized to null.");
                    ApplyKeys(doc);
                    return;
                }
            }

            using var resp = await _httpClient.GetAsync(_jwksUri, ct).ConfigureAwait(false);
            resp.EnsureSuccessStatusCode();
            var rawJson = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            doc = JsonSerializer.Deserialize(rawJson, JwksDocumentContext.Default.JwksDocument)
                ?? throw new JwksException("JWKS response deserialized to null.");

            if (_externalCache is not null)
                await _externalCache.SetAsync(_externalCacheKey, rawJson, _ttl, ct).ConfigureAwait(false);
        }
        catch (JwksException)
        {
            throw;
        }
        catch (Exception ex)
        {
            throw new JwksException($"JWKS fetch failed: {ex.Message}", ex);
        }

        ApplyKeys(doc);
    }

    private void ApplyKeys(JwksDocument doc)
    {

        var newKeys = new Dictionary<string, SecurityKey>(StringComparer.Ordinal);
        foreach (var jwk in doc.Keys ?? Array.Empty<JsonWebKeyEntry>())
        {
            if (string.IsNullOrEmpty(jwk.Kid))
                continue; // kid 必须有

            try
            {
                var secKey = BuildSecurityKey(jwk);
                if (secKey is not null)
                    newKeys[jwk.Kid] = secKey;
            }
            catch (Exception ex)
            {
                // 单个公钥解析失败不应中断整批;记录并跳过
                _logger?.LogWarning(ex, "Skipping unusable JWK entry kid={Kid}", jwk.Kid);
            }
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
                // ES256 -- P-256 曲线
                if (string.IsNullOrEmpty(jwk.X) || string.IsNullOrEmpty(jwk.Y))
                    return null;

                var ecdsa = ECDsa.Create();
                ecdsa.ImportParameters(new ECParameters
                {
                    Curve = jwk.Crv switch
                    {
                        "P-384" => ECCurve.NamedCurves.nistP384,
                        "P-521" => ECCurve.NamedCurves.nistP521,
                        _ => ECCurve.NamedCurves.nistP256  // 默认 P-256 对应 ES256
                    },
                    Q = new ECPoint
                    {
                        X = Base64UrlDecode(jwk.X),
                        Y = Base64UrlDecode(jwk.Y),
                    }
                });
                return new ECDsaSecurityKey(ecdsa) { KeyId = jwk.Kid };
            }

            case "RSA":
            {
                // RS256 / PS256 兼容
                if (string.IsNullOrEmpty(jwk.N) || string.IsNullOrEmpty(jwk.E))
                    return null;

                var rsa = RSA.Create();
                rsa.ImportParameters(new RSAParameters
                {
                    Modulus = Base64UrlDecode(jwk.N),
                    Exponent = Base64UrlDecode(jwk.E),
                });
                return new RsaSecurityKey(rsa) { KeyId = jwk.Kid };
            }

            default:
                return null; // 不支持的 kty 忽略
        }
    }

    private static byte[] Base64UrlDecode(string base64Url) =>
        Base64UrlEncoder.DecodeBytes(base64Url);

    public void Dispose()
    {
        if (_ownsHttpClient)
            _httpClient.Dispose();
        _refreshLock.Dispose();
    }

    // ---- 内部 JSON 反序列化模型(source-generated,零反射) ----

    private sealed record JwksDocument
    {
        [JsonPropertyName("keys")]
        public JsonWebKeyEntry[]? Keys { get; init; }
    }

    private sealed record JsonWebKeyEntry
    {
        [JsonPropertyName("kid")] public string? Kid { get; init; }
        [JsonPropertyName("kty")] public string? Kty { get; init; }
        [JsonPropertyName("alg")] public string? Alg { get; init; }
        [JsonPropertyName("crv")] public string? Crv { get; init; }
        // EC 公钥坐标
        [JsonPropertyName("x")]   public string? X { get; init; }
        [JsonPropertyName("y")]   public string? Y { get; init; }
        // RSA 公钥参数
        [JsonPropertyName("n")]   public string? N { get; init; }
        [JsonPropertyName("e")]   public string? E { get; init; }
    }

    [JsonSerializable(typeof(JwksDocument))]
    [JsonSourceGenerationOptions(PropertyNameCaseInsensitive = false)]
    private sealed partial class JwksDocumentContext : JsonSerializerContext { }
}
