// XidClient -- XID .NET 服务端 SDK 主入口
//
// 职责:
//   1. networkless JWT 验证(带 JWKS 缓存,ES256 主 / RS256 / PS256 兼容)
//   2. 请求认证(Authorization: Bearer 或 Cookie)
//   3. webhook 验证(svix 风格签名 + 5 分钟时间窗防重放)
//
// 不负责 OAuth 授权流程,那是客户端 SDK 的职责。
//
// 线程安全:实例可安全地在 DI 容器中注册为 Singleton 跨请求共享。

using Microsoft.IdentityModel.Tokens;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Xid;

/// <summary>
/// XID 服务端 SDK 配置项。
/// </summary>
public sealed record XidOptions
{
    /// <summary>
    /// XID issuer URL。自托管时填自定义域名,例如 https://auth.example.com。
    /// 托管版固定为 https://xid.dev。
    /// </summary>
    public required string Issuer { get; init; }

    /// <summary>
    /// 期望的 audience(aud claim)。
    /// 不传时跳过 audience 校验(仅在明确不需要校验时使用)。
    /// </summary>
    public string? Audience { get; init; }

    /// <summary>
    /// JWKS endpoint URI。留 null 时自动构造为 {Issuer}/jwks。
    /// </summary>
    public string? JwksUri { get; init; }

    /// <summary>JWKS 缓存有效期,默认 1 小时。</summary>
    public TimeSpan JwksTtl { get; init; } = TimeSpan.FromHours(1);

    /// <summary>
    /// 应用自己持有的 short-lived JWT cookie 名称。
    /// 默认为 null,即只接受 Authorization: Bearer。
    /// </summary>
    public string? SessionCookieName { get; init; }

    /// <summary>时钟偏差容忍窗口,默认 5 分钟。</summary>
    public TimeSpan ClockSkew { get; init; } = TimeSpan.FromMinutes(5);

    /// <summary>Webhook 防重放时间窗口,默认 5 分钟。</summary>
    public TimeSpan WebhookToleranceWindow { get; init; } = TimeSpan.FromMinutes(5);
}

/// <summary>
/// XID 服务端 SDK 主入口。
/// 推荐通过依赖注入以 Singleton 生命周期注册。
/// </summary>
public sealed class XidClient : IDisposable
{
    private readonly XidOptions _options;
    private readonly JwksCache _jwksCache;
    private readonly HttpClient _sessionHttpClient;
    private readonly JwtSecurityTokenHandler _jwtHandler = new();

    // ES256 / RS256 / PS256 白名单 -- 对应 XID 协议约定
    private static readonly IEnumerable<string> ValidAlgorithms = new[]
    {
        SecurityAlgorithms.EcdsaSha256,
        SecurityAlgorithms.RsaSha256,
        SecurityAlgorithms.RsaSsaPssSha256,
    };

    /// <param name="options">SDK 配置</param>
    /// <param name="httpClient">可选:外部托管的 HttpClient,用于拉取 JWKS</param>
    public XidClient(XidOptions options, HttpClient? httpClient = null)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentException.ThrowIfNullOrWhiteSpace(options.Issuer);

        _options = options;
        var jwksUri = options.JwksUri ?? $"{options.Issuer.TrimEnd('/')}/jwks";
        _jwksCache = new JwksCache(jwksUri, options.JwksTtl, httpClient);
        _sessionHttpClient = new HttpClient(new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false,
        })
        {
            Timeout = TimeSpan.FromSeconds(10),
        };

        // 禁用 inbound claim type mapping -- 保留 JWT 原始 claim 名
        _jwtHandler.InboundClaimTypeMap.Clear();
    }

    // -------------------------------------------------------------------------
    // JWT 验证
    // -------------------------------------------------------------------------

    /// <summary>
    /// 验证 access token。
    /// 拉取 JWKS(带缓存),验证签名与 iss/aud/exp/iat/nbf claims。
    /// </summary>
    /// <param name="token">JWT 字符串</param>
    /// <param name="ct">取消令牌</param>
    /// <returns>验证通过的 claims 快照</returns>
    /// <exception cref="TokenVerificationException">任何验证失败</exception>
    public async Task<TokenClaims> VerifyTokenAsync(string token, CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(token);

        // 先解析 header 取 kid,再按 kid 拉对应公钥 -- 避免盲目拉全部公钥
        JwtSecurityToken unvalidated;
        try
        {
            unvalidated = _jwtHandler.ReadJwtToken(token);
        }
        catch (Exception ex)
        {
            throw new TokenVerificationException($"JWT parse failed: {ex.Message}", ex);
        }

        var kid = unvalidated.Header.Kid;
        if (string.IsNullOrEmpty(kid))
            throw new TokenVerificationException("JWT header missing 'kid'. XID tokens must include kid for key selection.");

        var signingKey = await _jwksCache.GetKeyAsync(kid, ct).ConfigureAwait(false);

        var validationParams = BuildValidationParameters(signingKey);

        ClaimsPrincipal principal;
        try
        {
            principal = _jwtHandler.ValidateToken(token, validationParams, out _);
        }
        catch (SecurityTokenExpiredException ex)
        {
            throw new TokenVerificationException($"Token expired at {ex.Expires:O}.", ex);
        }
        catch (SecurityTokenNotYetValidException ex)
        {
            throw new TokenVerificationException($"Token not yet valid until {ex.NotBefore:O}.", ex);
        }
        catch (SecurityTokenInvalidSignatureException ex)
        {
            throw new TokenVerificationException("Token signature invalid.", ex);
        }
        catch (SecurityTokenInvalidIssuerException ex)
        {
            throw new TokenVerificationException($"Token issuer invalid: {ex.Message}", ex);
        }
        catch (SecurityTokenInvalidAudienceException ex)
        {
            throw new TokenVerificationException($"Token audience invalid: {ex.Message}", ex);
        }
        catch (Exception ex)
        {
            throw new TokenVerificationException($"Token validation failed: {ex.Message}", ex);
        }

        return BuildTokenClaims(principal);
    }

    // -------------------------------------------------------------------------
    // 请求认证
    // -------------------------------------------------------------------------

    /// <summary>
    /// 从 HTTP 请求中提取并验证 access token,返回结构化认证状态。
    /// 提取顺序:Authorization: Bearer -> Cookie (SessionCookieName)。
    /// 无论是否认证成功都不抛异常,失败时 AuthStatus.Authenticated=false。
    /// </summary>
    /// <param name="authorizationHeader">Authorization 头的值,可为 null。</param>
    /// <param name="cookies">请求 Cookie 集合,可为 null。</param>
    /// <param name="ct">取消令牌</param>
    public async Task<AuthStatus> AuthenticateRequestAsync(
        string? authorizationHeader,
        IReadOnlyDictionary<string, string>? cookies = null,
        CancellationToken ct = default)
    {
        var token = ExtractToken(authorizationHeader, cookies);
        if (token is null)
            return AuthStatus.Fail("No bearer token or session cookie found.");

        try
        {
            var claims = await VerifyTokenAsync(token, ct).ConfigureAwait(false);
            return AuthStatus.Ok(claims);
        }
        catch (XidException ex)
        {
            return AuthStatus.Fail(ex.Message);
        }
    }

    /// <summary>
    /// 将 Core opaque browser session cookie 显式交换为 short-lived JWT。
    /// </summary>
    public async Task<string> ExchangeSessionTokenAsync(
        string incomingRequestUrl,
        string cookieHeader,
        string? endpoint = null,
        SessionTokenTransport? transport = null,
        CancellationToken ct = default)
    {
        Uri resolved = ResolveSessionTokenEndpoint(incomingRequestUrl, endpoint);
        SessionTokenHttpResponse response;
        try
        {
            if (transport is not null)
            {
                response = await transport(resolved, cookieHeader, ct).ConfigureAwait(false);
            }
            else
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, resolved);
                request.Headers.Accept.ParseAdd("application/json");
                request.Headers.TryAddWithoutValidation("Cookie", cookieHeader);
                using var httpResponse = await _sessionHttpClient
                    .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct)
                    .ConfigureAwait(false);
                response = new SessionTokenHttpResponse(
                    (int)httpResponse.StatusCode,
                    await httpResponse.Content.ReadAsStringAsync(ct).ConfigureAwait(false));
            }
        }
        catch (SessionTokenExchangeException)
        {
            throw;
        }
        catch (Exception ex)
        {
            throw new SessionTokenExchangeException(
                "Session token exchange request failed.",
                ex);
        }

        if (response.StatusCode != 200)
            throw new SessionTokenExchangeException(
                $"Session token exchange returned HTTP {response.StatusCode}.");

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(response.Body);
        }
        catch (JsonException ex)
        {
            throw new SessionTokenExchangeException(
                "Session token exchange returned invalid JSON.",
                ex);
        }
        using (document)
        {
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                throw new SessionTokenExchangeException(
                    "Session token exchange returned an invalid response.");
            JsonProperty[] properties = root.EnumerateObject().ToArray();
            if (properties.Length != 1 ||
                properties[0].Name != "token" ||
                properties[0].Value.ValueKind != JsonValueKind.String)
                throw new SessionTokenExchangeException(
                    "Session token exchange returned an invalid response.");
            string? token = properties[0].Value.GetString();
            if (string.IsNullOrWhiteSpace(token))
                throw new SessionTokenExchangeException(
                    "Session token exchange returned an invalid response.");
            return token;
        }
    }

    // -------------------------------------------------------------------------
    // Webhook 验证
    // -------------------------------------------------------------------------

    /// <summary>
    /// 验证 svix 风格 webhook 签名 + 5 分钟时间窗防重放。
    ///
    /// 头要求:
    ///   svix-id        -- 事件唯一标识
    ///   svix-timestamp -- Unix 秒时间戳
    ///   svix-signature -- 一个或多个 "v1,{base64}" 签名,逗号分隔
    ///
    /// 签名算法:HMAC-SHA256,消息 = "{svix-id}.{svix-timestamp}.{body}"。
    /// secret 格式:原始字节或 base64url 编码字节均可(不含 "whsec_" 前缀时直接 UTF-8 解码)。
    /// </summary>
    /// <param name="payload">原始请求体字节</param>
    /// <param name="headers">HTTP 请求头集合</param>
    /// <param name="secret">webhook 签名密钥(whsec_ 前缀会被自动去除)</param>
    /// <returns>验证通过的 <see cref="WebhookPayload"/></returns>
    /// <exception cref="WebhookVerificationException">签名不合法或时间窗超限</exception>
    public WebhookPayload VerifyWebhook(
        ReadOnlySpan<byte> payload,
        IReadOnlyDictionary<string, string> headers,
        string secret)
    {
        ArgumentNullException.ThrowIfNull(headers);
        ArgumentException.ThrowIfNullOrWhiteSpace(secret);

        if (!headers.TryGetValue("svix-id", out var svixId) || string.IsNullOrEmpty(svixId))
            throw new WebhookVerificationException("Missing required header 'svix-id'.");

        if (!headers.TryGetValue("svix-timestamp", out var tsStr) || !long.TryParse(tsStr, out var timestamp))
            throw new WebhookVerificationException("Missing or invalid header 'svix-timestamp'.");

        if (!headers.TryGetValue("svix-signature", out var sigHeader) || string.IsNullOrEmpty(sigHeader))
            throw new WebhookVerificationException("Missing required header 'svix-signature'.");

        // 时间窗校验 -- 防重放
        var nowSec = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var delta = Math.Abs(nowSec - timestamp);
        if (delta > (long)_options.WebhookToleranceWindow.TotalSeconds)
            throw new WebhookVerificationException(
                $"Webhook timestamp is outside the tolerance window ({_options.WebhookToleranceWindow.TotalMinutes:0} min). " +
                "Possible replay attack or extreme clock skew.");

        // 计算期望签名
        var keyBytes = ParseWebhookSecret(secret);
        var expectedSig = ComputeWebhookSignature(svixId, tsStr, payload, keyBytes);

        // svix-signature 格式:"v1,<base64> v1,<base64>" (多个签名以空格分隔)
        // 逗号是 "v1," 前缀的一部分,不是分隔符
        var signatures = sigHeader
            .Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .Where(s => s.StartsWith("v1,", StringComparison.Ordinal))
            .Select(s => s["v1,".Length..]);

        var matched = signatures.Any(sig =>
        {
            try
            {
                var sigBytes = Convert.FromBase64String(sig);
                return CryptographicOperations.FixedTimeEquals(sigBytes, expectedSig);
            }
            catch
            {
                return false;
            }
        });

        if (!matched)
            throw new WebhookVerificationException("Webhook signature does not match. Check your signing secret.");

        return new WebhookPayload
        {
            SvixId = svixId,
            Timestamp = timestamp,
            RawBody = payload.ToArray(),
        };
    }

    // -------------------------------------------------------------------------
    // 私有辅助方法
    // -------------------------------------------------------------------------

    private TokenValidationParameters BuildValidationParameters(SecurityKey signingKey)
    {
        var tvp = new TokenValidationParameters
        {
            ValidIssuer = _options.Issuer,
            ValidateIssuer = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = signingKey,
            ClockSkew = _options.ClockSkew,
            ValidAlgorithms = ValidAlgorithms,
            // 禁止 none 算法
            RequireSignedTokens = true,
            RequireExpirationTime = true,
        };

        if (_options.Audience is not null)
        {
            tvp.ValidateAudience = true;
            tvp.ValidAudience = _options.Audience;
        }
        else
        {
            tvp.ValidateAudience = false;
        }

        return tvp;
    }

    private static TokenClaims BuildTokenClaims(ClaimsPrincipal principal)
    {
        // 将 ClaimsPrincipal 展平为字典再调用 FromPayload。
        // amr / aud 这类多值 claim 会展开为多条同类型 Claim,直接 ToDictionary 会抛重复键异常,
        // 因此按类型分组:单值保持 string,多值归并为 string[]
        var payload = principal.Claims
            .GroupBy(c => c.Type)
            .ToDictionary(
                g => g.Key,
                g => (object?)(g.Skip(1).Any() ? g.Select(c => c.Value).ToArray() : g.First().Value));

        // aud 在 ClaimsPrincipal 中可能展开为多条 Claim
        var audClaims = principal.Claims
            .Where(c => c.Type == "aud")
            .Select(c => c.Value)
            .ToArray();
        if (audClaims.Length > 0)
            payload["aud"] = audClaims;

        return TokenClaims.FromPayload(payload);
    }

    private string? ExtractToken(string? authorizationHeader, IReadOnlyDictionary<string, string>? cookies)
    {
        // 优先 Authorization: Bearer
        if (!string.IsNullOrWhiteSpace(authorizationHeader))
        {
            const string bearerPrefix = "Bearer ";
            if (authorizationHeader.StartsWith(bearerPrefix, StringComparison.OrdinalIgnoreCase))
                return authorizationHeader[bearerPrefix.Length..].Trim();
        }

        // 回落 Cookie
        if (cookies is not null &&
            !string.IsNullOrWhiteSpace(_options.SessionCookieName) &&
            cookies.TryGetValue(_options.SessionCookieName, out var cookieToken) &&
            !string.IsNullOrWhiteSpace(cookieToken))
        {
            return cookieToken;
        }

        return null;
    }

    private static Uri ResolveSessionTokenEndpoint(
        string incomingRequestUrl,
        string? endpoint)
    {
        if (!Uri.TryCreate(incomingRequestUrl, UriKind.Absolute, out Uri? incoming) ||
            !IsHttpUri(incoming) ||
            !string.IsNullOrEmpty(incoming.UserInfo))
            throw new SessionTokenExchangeException(
                "Incoming request URL must be an absolute HTTP(S) URL.");

        string target = string.IsNullOrWhiteSpace(endpoint)
            ? "/v1/sessions/token"
            : endpoint;
        if (!Uri.TryCreate(incoming, target, out Uri? resolved) ||
            !IsHttpUri(resolved) ||
            !string.IsNullOrEmpty(resolved.UserInfo) ||
            !SameOrigin(incoming, resolved) ||
            resolved.AbsolutePath != "/v1/sessions/token" ||
            !string.IsNullOrEmpty(resolved.Query) ||
            !string.IsNullOrEmpty(resolved.Fragment))
            throw new SessionTokenExchangeException(
                "Session token endpoint must be exact same-origin /v1/sessions/token.");
        return resolved;
    }

    private static bool IsHttpUri(Uri uri) =>
        uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps;

    private static bool SameOrigin(Uri left, Uri right) =>
        string.Equals(left.Scheme, right.Scheme, StringComparison.OrdinalIgnoreCase) &&
        string.Equals(left.IdnHost, right.IdnHost, StringComparison.OrdinalIgnoreCase) &&
        left.Port == right.Port;

    private static byte[] ParseWebhookSecret(string secret)
    {
        // 去除 whsec_ 前缀(svix 风格)
        const string prefix = "whsec_";
        if (!secret.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) &&
            IsLegacyWebhookHexSecret(secret))
            return Encoding.UTF8.GetBytes(secret);

        var raw = secret.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            ? secret[prefix.Length..]
            : secret;

        try
        {
            return Convert.FromBase64String(raw);
        }
        catch
        {
            // 非 base64 时回落 UTF-8 解码
            return Encoding.UTF8.GetBytes(raw);
        }
    }

    private static bool IsLegacyWebhookHexSecret(string secret) =>
        secret.Length == 64 &&
        secret.All(value =>
            value is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static byte[] ComputeWebhookSignature(
        string svixId,
        string timestampStr,
        ReadOnlySpan<byte> body,
        byte[] keyBytes)
    {
        // 消息格式:{svix-id}.{svix-timestamp}.{body}
        var prefixStr = $"{svixId}.{timestampStr}.";
        var prefixBytes = Encoding.UTF8.GetBytes(prefixStr);

        // 合并 prefix + body -- 避免两次分配;小请求直接 stackalloc
        var msgLen = prefixBytes.Length + body.Length;
        byte[] msgBuf = new byte[msgLen];
        prefixBytes.CopyTo(msgBuf, 0);
        body.CopyTo(msgBuf.AsSpan(prefixBytes.Length));

        using var hmac = new HMACSHA256(keyBytes);
        return hmac.ComputeHash(msgBuf);
    }

    public void Dispose()
    {
        _jwksCache.Dispose();
        _sessionHttpClient.Dispose();
    }
}
