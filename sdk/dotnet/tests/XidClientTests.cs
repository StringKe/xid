// XidClientTests.cs
// dotnet SDK 单元测试
//
// 覆盖:
//   - JWT 验证:ES256 / RS256 签名正确路径
//   - JWT 验证:过期 / nbf 未到 / issuer 不符 / audience 不符
//   - JWT 验证:alg=none 被拒绝
//   - JWT 验证:kid 不存在
//   - JWT 验证:amr / IsGuest 匿名访客判定
//   - Webhook 验证:合法签名
//   - Webhook 验证:时间窗超限(重放防护)
//   - Webhook 验证:签名不匹配
//   - Webhook 验证:缺少必要头
//   - AuthenticateRequest:从 Bearer 头提取
//   - AuthenticateRequest:从 Cookie 提取
//   - AuthenticateRequest:无 token 返回 Fail

using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.IdentityModel.Tokens;

namespace Xid.Tests;

/// <summary>
/// 拦截 JWKS 请求的测试用 HttpMessageHandler,
/// 允许测试无需启动真实 HTTP 服务器。
/// </summary>
file sealed class MockJwksHandler : HttpMessageHandler
{
    private readonly string _jwksJson;

    public MockJwksHandler(string jwksJson) => _jwksJson = jwksJson;

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken ct)
    {
        var response = new HttpResponseMessage(System.Net.HttpStatusCode.OK)
        {
            Content = new StringContent(_jwksJson, Encoding.UTF8, "application/json")
        };
        return Task.FromResult(response);
    }
}

/// <summary>
/// ES256 / RS256 令牌生成辅助工具,测试内部使用。
/// </summary>
file static class TokenHelper
{
    private static readonly JwtSecurityTokenHandler Handler = new();

    static TokenHelper()
    {
        Handler.InboundClaimTypeMap.Clear();
    }

    /// <summary>生成 ES256 密钥对并返回 (ecDsa, kid)。</summary>
    public static (ECDsa Key, string Kid) CreateEcKey()
    {
        var ec = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        return (ec, "ec-key-1");
    }

    /// <summary>生成 RS256 密钥对并返回 (rsa, kid)。</summary>
    public static (RSA Key, string Kid) CreateRsaKey()
    {
        var rsa = RSA.Create(2048);
        return (rsa, "rsa-key-1");
    }

    /// <summary>将 ECDsa 公钥序列化为 JWK JSON。</summary>
    public static string ToJwksJson(ECDsa key, string kid)
    {
        var pub = key.ExportParameters(false);
        var jwk = new
        {
            keys = new[]
            {
                new
                {
                    kty = "EC",
                    crv = "P-256",
                    kid,
                    x = Base64UrlEncoder.Encode(pub.Q.X!),
                    y = Base64UrlEncoder.Encode(pub.Q.Y!),
                }
            }
        };
        return JsonSerializer.Serialize(jwk);
    }

    /// <summary>将 RSA 公钥序列化为 JWK JSON。</summary>
    public static string ToJwksJson(RSA key, string kid)
    {
        var pub = key.ExportParameters(false);
        var jwk = new
        {
            keys = new[]
            {
                new
                {
                    kty = "RSA",
                    kid,
                    n = Base64UrlEncoder.Encode(pub.Modulus!),
                    e = Base64UrlEncoder.Encode(pub.Exponent!),
                }
            }
        };
        return JsonSerializer.Serialize(jwk);
    }

    /// <summary>生成带指定 claims 和签名算法的 JWT。</summary>
    public static string CreateToken(
        SecurityKey signingKey,
        string kid,
        string alg,
        string issuer = "https://xid.dev",
        string? audience = "test-client",
        string subject = "user-123",
        int lifetimeSeconds = 3600,
        int nbfOffsetSeconds = 0,
        IEnumerable<Claim>? extraClaims = null)
    {
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, subject),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString()),
        };
        if (extraClaims != null)
            claims.AddRange(extraClaims);

        // 计算 NotBefore 和 Expires:确保 Expires >= NotBefore
        // 当 lifetimeSeconds < 0(测试过期 token)时,NotBefore 也需要前移
        var notBefore = DateTime.UtcNow.AddSeconds(nbfOffsetSeconds);
        var expires = notBefore.AddSeconds(lifetimeSeconds > 0 ? lifetimeSeconds : Math.Abs(lifetimeSeconds));
        if (lifetimeSeconds < 0)
        {
            // 过期 token:整体时间窗口移到过去
            notBefore = DateTime.UtcNow.AddSeconds(lifetimeSeconds * 2);
            expires = DateTime.UtcNow.AddSeconds(lifetimeSeconds);
        }

        var descriptor = new SecurityTokenDescriptor
        {
            Subject = new ClaimsIdentity(claims),
            Issuer = issuer,
            Audience = audience,
            Expires = expires,
            NotBefore = notBefore,
            SigningCredentials = new SigningCredentials(signingKey, alg),
        };

        var token = Handler.CreateJwtSecurityToken(descriptor);
        // 强制设置 kid header
        token.Header[JwtHeaderParameterNames.Kid] = kid;
        return Handler.WriteToken(token);
    }
}

public class VerifyTokenTests
{
    // -- ES256 正确路径 --

    [Fact]
    public async Task VerifyToken_Es256_ValidToken_ReturnsClaims()
    {
        // Arrange
        var (ecKey, kid) = TokenHelper.CreateEcKey();
        string jwksJson = TokenHelper.ToJwksJson(ecKey, kid);
        var securityKey = new ECDsaSecurityKey(ecKey) { KeyId = kid };
        string token = TokenHelper.CreateToken(securityKey, kid, SecurityAlgorithms.EcdsaSha256,
            audience: "my-app");

        using var http = new HttpClient(new MockJwksHandler(jwksJson));
        var client = new XidClient(new XidOptions
        {
            Issuer = "https://xid.dev",
            Audience = "my-app",
        }, http);

        // Act
        TokenClaims claims = await client.VerifyTokenAsync(token);

        // Assert
        Assert.Equal("user-123", claims.Sub);
        Assert.Equal("https://xid.dev", claims.Iss);
        Assert.Contains("my-app", claims.Aud);
    }

    // -- RS256 正确路径 --

    [Fact]
    public async Task VerifyToken_Rs256_ValidToken_ReturnsClaims()
    {
        // Arrange
        var (rsaKey, kid) = TokenHelper.CreateRsaKey();
        string jwksJson = TokenHelper.ToJwksJson(rsaKey, kid);
        var securityKey = new RsaSecurityKey(rsaKey) { KeyId = kid };
        string token = TokenHelper.CreateToken(securityKey, kid, SecurityAlgorithms.RsaSha256);

        using var http = new HttpClient(new MockJwksHandler(jwksJson));
        var client = new XidClient(new XidOptions { Issuer = "https://xid.dev" }, http);

        // Act
        TokenClaims claims = await client.VerifyTokenAsync(token);

        // Assert
        Assert.Equal("user-123", claims.Sub);
    }

    // -- 过期 token --

    [Fact]
    public async Task VerifyToken_ExpiredToken_Throws()
    {
        // Arrange
        var (ecKey, kid) = TokenHelper.CreateEcKey();
        var securityKey = new ECDsaSecurityKey(ecKey) { KeyId = kid };
        // 生命周期 -3600 秒(一小时前已过期),超出默认 5 分钟时钟偏差
        string token = TokenHelper.CreateToken(securityKey, kid, SecurityAlgorithms.EcdsaSha256,
            lifetimeSeconds: -3600);

        using var http = new HttpClient(new MockJwksHandler(TokenHelper.ToJwksJson(ecKey, kid)));
        var client = new XidClient(new XidOptions { Issuer = "https://xid.dev" }, http);

        // Act & Assert
        var ex = await Assert.ThrowsAsync<TokenVerificationException>(() => client.VerifyTokenAsync(token));
        Assert.Contains("expired", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    // -- nbf 未到 --

    [Fact]
    public async Task VerifyToken_NotYetValid_Throws()
    {
        // Arrange
        var (ecKey, kid) = TokenHelper.CreateEcKey();
        var securityKey = new ECDsaSecurityKey(ecKey) { KeyId = kid };
        // nbf 在未来 10 分钟,超出默认 5 分钟时钟偏差
        string token = TokenHelper.CreateToken(securityKey, kid, SecurityAlgorithms.EcdsaSha256,
            nbfOffsetSeconds: 600);

        using var http = new HttpClient(new MockJwksHandler(TokenHelper.ToJwksJson(ecKey, kid)));
        var client = new XidClient(new XidOptions { Issuer = "https://xid.dev" }, http);

        // Act & Assert
        await Assert.ThrowsAsync<TokenVerificationException>(() => client.VerifyTokenAsync(token));
    }

    // -- issuer 不符 --

    [Fact]
    public async Task VerifyToken_WrongIssuer_Throws()
    {
        // Arrange
        var (ecKey, kid) = TokenHelper.CreateEcKey();
        var securityKey = new ECDsaSecurityKey(ecKey) { KeyId = kid };
        // token issuer 与配置不一致
        string token = TokenHelper.CreateToken(securityKey, kid, SecurityAlgorithms.EcdsaSha256,
            issuer: "https://evil.example.com");

        using var http = new HttpClient(new MockJwksHandler(TokenHelper.ToJwksJson(ecKey, kid)));
        var client = new XidClient(new XidOptions { Issuer = "https://xid.dev" }, http);

        // Act & Assert
        await Assert.ThrowsAsync<TokenVerificationException>(() => client.VerifyTokenAsync(token));
    }

    // -- audience 不符 --

    [Fact]
    public async Task VerifyToken_WrongAudience_Throws()
    {
        // Arrange
        var (ecKey, kid) = TokenHelper.CreateEcKey();
        var securityKey = new ECDsaSecurityKey(ecKey) { KeyId = kid };
        string token = TokenHelper.CreateToken(securityKey, kid, SecurityAlgorithms.EcdsaSha256,
            audience: "wrong-client");

        using var http = new HttpClient(new MockJwksHandler(TokenHelper.ToJwksJson(ecKey, kid)));
        var client = new XidClient(new XidOptions
        {
            Issuer = "https://xid.dev",
            Audience = "correct-client",  // 配置的 audience 与 token 不符
        }, http);

        // Act & Assert
        await Assert.ThrowsAsync<TokenVerificationException>(() => client.VerifyTokenAsync(token));
    }

    // -- alg=none 被拒绝 --

    [Fact]
    public async Task VerifyToken_NoneAlg_Throws()
    {
        // Arrange: 手动构造 alg=none 的 token
        string header = Base64UrlEncode("""{"alg":"none","typ":"JWT"}""");
        string payload = Base64UrlEncode("""{"sub":"attacker","iss":"https://xid.dev","exp":9999999999,"iat":1700000000}""");
        string fakeToken = $"{header}.{payload}.";

        using var http = new HttpClient(new MockJwksHandler("{\"keys\":[]}"));
        var client = new XidClient(new XidOptions { Issuer = "https://xid.dev" }, http);

        // Act & Assert: 应在解析时拒绝(缺少 kid 或验签失败)
        await Assert.ThrowsAsync<TokenVerificationException>(() => client.VerifyTokenAsync(fakeToken));
    }

    // -- kid 不存在 --

    [Fact]
    public async Task VerifyToken_UnknownKid_Throws()
    {
        // Arrange
        var (ecKey, _) = TokenHelper.CreateEcKey();
        var securityKey = new ECDsaSecurityKey(ecKey) { KeyId = "unknown-kid" };
        string token = TokenHelper.CreateToken(securityKey, "unknown-kid", SecurityAlgorithms.EcdsaSha256);

        // JWKS 里只有 known-kid
        string jwksJson = TokenHelper.ToJwksJson(ecKey, "known-kid");
        using var http = new HttpClient(new MockJwksHandler(jwksJson));
        var client = new XidClient(new XidOptions { Issuer = "https://xid.dev" }, http);

        // Act & Assert
        var ex = await Assert.ThrowsAsync<TokenVerificationException>(() => client.VerifyTokenAsync(token));
        Assert.Contains("unknown-kid", ex.Message);
    }

    // -- amr 含 guest:匿名访客判定为 true --

    [Fact]
    public async Task VerifyToken_GuestAmr_IsGuestTrue()
    {
        // Arrange
        var (ecKey, kid) = TokenHelper.CreateEcKey();
        var securityKey = new ECDsaSecurityKey(ecKey) { KeyId = kid };
        string token = TokenHelper.CreateToken(securityKey, kid, SecurityAlgorithms.EcdsaSha256,
            extraClaims: new[] { new Claim("amr", "guest") });

        using var http = new HttpClient(new MockJwksHandler(TokenHelper.ToJwksJson(ecKey, kid)));
        var client = new XidClient(new XidOptions { Issuer = "https://xid.dev" }, http);

        // Act
        TokenClaims claims = await client.VerifyTokenAsync(token);

        // Assert
        Assert.True(claims.IsGuest);
        Assert.Contains("guest", claims.Amr);
    }

    // -- amr 多值含 guest:仍判定为 true --

    [Fact]
    public async Task VerifyToken_MultiAmrWithGuest_IsGuestTrue()
    {
        // Arrange: 匿名访客叠加其他认证方式时 amr 是多值数组
        var (ecKey, kid) = TokenHelper.CreateEcKey();
        var securityKey = new ECDsaSecurityKey(ecKey) { KeyId = kid };
        string token = TokenHelper.CreateToken(securityKey, kid, SecurityAlgorithms.EcdsaSha256,
            extraClaims: new[] { new Claim("amr", "pwd"), new Claim("amr", "guest") });

        using var http = new HttpClient(new MockJwksHandler(TokenHelper.ToJwksJson(ecKey, kid)));
        var client = new XidClient(new XidOptions { Issuer = "https://xid.dev" }, http);

        // Act
        TokenClaims claims = await client.VerifyTokenAsync(token);

        // Assert
        Assert.True(claims.IsGuest);
        Assert.Equal(new[] { "pwd", "guest" }, claims.Amr);
    }

    // -- amr 不含 guest:正式用户判定为 false --

    [Fact]
    public async Task VerifyToken_PwdAmr_IsGuestFalse()
    {
        // Arrange
        var (ecKey, kid) = TokenHelper.CreateEcKey();
        var securityKey = new ECDsaSecurityKey(ecKey) { KeyId = kid };
        string token = TokenHelper.CreateToken(securityKey, kid, SecurityAlgorithms.EcdsaSha256,
            extraClaims: new[] { new Claim("amr", "pwd") });

        using var http = new HttpClient(new MockJwksHandler(TokenHelper.ToJwksJson(ecKey, kid)));
        var client = new XidClient(new XidOptions { Issuer = "https://xid.dev" }, http);

        // Act
        TokenClaims claims = await client.VerifyTokenAsync(token);

        // Assert
        Assert.False(claims.IsGuest);
    }

    // -- 无 amr:判定为 false --

    [Fact]
    public async Task VerifyToken_NoAmr_IsGuestFalse()
    {
        // Arrange
        var (ecKey, kid) = TokenHelper.CreateEcKey();
        var securityKey = new ECDsaSecurityKey(ecKey) { KeyId = kid };
        string token = TokenHelper.CreateToken(securityKey, kid, SecurityAlgorithms.EcdsaSha256);

        using var http = new HttpClient(new MockJwksHandler(TokenHelper.ToJwksJson(ecKey, kid)));
        var client = new XidClient(new XidOptions { Issuer = "https://xid.dev" }, http);

        // Act
        TokenClaims claims = await client.VerifyTokenAsync(token);

        // Assert
        Assert.False(claims.IsGuest);
        Assert.Empty(claims.Amr);
    }

    private static string Base64UrlEncode(string input)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(input);
        return Convert.ToBase64String(bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=');
    }
}

public class WebhookVerificationTests
{
    private static byte[] ComputeExpectedSig(string svixId, string tsStr, string body, byte[] keyBytes)
    {
        using var hmac = new HMACSHA256(keyBytes);
        byte[] msg = Encoding.UTF8.GetBytes($"{svixId}.{tsStr}.{body}");
        return hmac.ComputeHash(msg);
    }

    private static byte[] ComputeExpectedSigBytes(string svixId, string tsStr, byte[] body, byte[] keyBytes)
    {
        using var hmac = new HMACSHA256(keyBytes);
        byte[] prefix = Encoding.UTF8.GetBytes($"{svixId}.{tsStr}.");
        byte[] msg = new byte[prefix.Length + body.Length];
        prefix.CopyTo(msg, 0);
        body.CopyTo(msg, prefix.Length);
        return hmac.ComputeHash(msg);
    }

    private static string BuildSig(byte[] sigBytes) =>
        "v1," + Convert.ToBase64String(sigBytes);

    // -- 合法签名 (whsec_ base64 format) --

    [Fact]
    public void VerifyWebhook_ValidSignature_WhsecFormat()
    {
        // Arrange: use whsec_<base64> format matching svix convention
        var client = new XidClient(new XidOptions { Issuer = "https://xid.dev" },
            new HttpClient(new MockJwksHandler("{\"keys\":[]}")));

        string svixId = "msg_abc";
        long ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        byte[] bodyBytes = Encoding.UTF8.GetBytes("{\"type\":\"user.created\"}");

        // Build whsec_ secret with known key bytes
        byte[] rawKey = new byte[32];
        for (int i = 0; i < rawKey.Length; i++) rawKey[i] = (byte)(i + 1);
        string base64Part = Convert.ToBase64String(rawKey);
        string secret = "whsec_" + base64Part;

        // The SDK will call Convert.FromBase64String(base64Part) -> rawKey
        byte[] sigBytes = ComputeExpectedSigBytes(svixId, ts.ToString(), bodyBytes, rawKey);

        var headers = new Dictionary<string, string>
        {
            ["svix-id"] = svixId,
            ["svix-timestamp"] = ts.ToString(),
            ["svix-signature"] = BuildSig(sigBytes),
        };

        // Act
        WebhookPayload result = client.VerifyWebhook(bodyBytes, headers, secret);

        // Assert
        Assert.Equal(svixId, result.SvixId);
        Assert.Equal(ts, result.Timestamp);
    }

    [Fact]
    public void VerifyWebhook_LegacyHexSecret_UsesUtf8KeyMaterial()
    {
        var client = new XidClient(new XidOptions { Issuer = "https://xid.dev" },
            new HttpClient(new MockJwksHandler("{\"keys\":[]}")));
        string svixId = "msg_legacy";
        long ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        byte[] bodyBytes = Encoding.UTF8.GetBytes("{\"type\":\"user.updated\"}");
        string legacySecret = string.Concat(Enumerable.Repeat("ab", 32));
        byte[] sigBytes = ComputeExpectedSigBytes(
            svixId,
            ts.ToString(),
            bodyBytes,
            Encoding.UTF8.GetBytes(legacySecret));
        var headers = new Dictionary<string, string>
        {
            ["svix-id"] = svixId,
            ["svix-timestamp"] = ts.ToString(),
            ["svix-signature"] = BuildSig(sigBytes),
        };

        WebhookPayload result = client.VerifyWebhook(bodyBytes, headers, legacySecret);

        Assert.Equal(svixId, result.SvixId);
    }

    // -- 合法签名 --

    [Fact]
    public void VerifyWebhook_ValidSignature_ReturnsSvixId()
    {
        // Arrange
        var client = new XidClient(new XidOptions { Issuer = "https://xid.dev" },
            new HttpClient(new MockJwksHandler("{\"keys\":[]}")));

        string svixId = "msg_123";
        long ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        byte[] bodyBytes = Encoding.UTF8.GetBytes("{\"event\":\"user.created\",\"data\":{}}");

        // 使用 UTF-8 secret 字符串(非 base64 编码),避免 base64 往返编解码歧义
        string secret = "test-webhook-secret-32bytes-12345";
        byte[] keyBytes = Encoding.UTF8.GetBytes(secret);
        // 注意:非 base64 时 ParseWebhookSecret 回落到 UTF-8 解码

        byte[] sigBytes = ComputeExpectedSigBytes(svixId, ts.ToString(), bodyBytes, keyBytes);

        var headers = new Dictionary<string, string>
        {
            ["svix-id"] = svixId,
            ["svix-timestamp"] = ts.ToString(),
            ["svix-signature"] = BuildSig(sigBytes),
        };

        // Act
        WebhookPayload result = client.VerifyWebhook(bodyBytes, headers, secret);

        // Assert
        Assert.Equal(svixId, result.SvixId);
        Assert.Equal(ts, result.Timestamp);
    }

    // -- 时间窗超限 --

    [Fact]
    public void VerifyWebhook_StaleTimestamp_Throws()
    {
        // Arrange
        var client = new XidClient(new XidOptions { Issuer = "https://xid.dev" },
            new HttpClient(new MockJwksHandler("{\"keys\":[]}")));

        long staleTs = DateTimeOffset.UtcNow.AddMinutes(-10).ToUnixTimeSeconds();
        string secret = "stale-test-secret";
        byte[] keyBytes = Encoding.UTF8.GetBytes(secret);
        byte[] sigBytes = ComputeExpectedSig("msg_old", staleTs.ToString(), "{}", keyBytes);

        var headers = new Dictionary<string, string>
        {
            ["svix-id"] = "msg_old",
            ["svix-timestamp"] = staleTs.ToString(),
            ["svix-signature"] = BuildSig(sigBytes),
        };

        // Act & Assert
        var ex = Assert.Throws<WebhookVerificationException>(
            () => client.VerifyWebhook(Encoding.UTF8.GetBytes("{}"), headers, secret));
        Assert.Contains("tolerance", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    // -- 签名不匹配 --

    [Fact]
    public void VerifyWebhook_WrongSignature_Throws()
    {
        // Arrange
        var client = new XidClient(new XidOptions { Issuer = "https://xid.dev" },
            new HttpClient(new MockJwksHandler("{\"keys\":[]}")));

        long ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        byte[] wrongSig = RandomNumberGenerator.GetBytes(32);

        var headers = new Dictionary<string, string>
        {
            ["svix-id"] = "msg_tampered",
            ["svix-timestamp"] = ts.ToString(),
            ["svix-signature"] = "v1," + Convert.ToBase64String(wrongSig),
        };

        string secret = "wrong-sig-test-secret";

        // Act & Assert
        Assert.Throws<WebhookVerificationException>(
            () => client.VerifyWebhook(Encoding.UTF8.GetBytes("{}"), headers, secret));
    }

    // -- 缺少 svix-id 头 --

    [Fact]
    public void VerifyWebhook_MissingSvixId_Throws()
    {
        // Arrange
        var client = new XidClient(new XidOptions { Issuer = "https://xid.dev" },
            new HttpClient(new MockJwksHandler("{\"keys\":[]}")));

        var headers = new Dictionary<string, string>
        {
            // 故意省略 svix-id
            ["svix-timestamp"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(),
            ["svix-signature"] = "v1,abc123",
        };

        // Act & Assert
        var ex = Assert.Throws<WebhookVerificationException>(
            () => client.VerifyWebhook(Encoding.UTF8.GetBytes("{}"), headers, "secret"));
        Assert.Contains("svix-id", ex.Message);
    }
}

public class AuthenticateRequestTests
{
    // -- 从 Bearer 头提取 token --

    [Fact]
    public async Task AuthenticateRequest_BearerToken_Authenticated()
    {
        // Arrange
        var (ecKey, kid) = TokenHelper.CreateEcKey();
        var securityKey = new ECDsaSecurityKey(ecKey) { KeyId = kid };
        string token = TokenHelper.CreateToken(securityKey, kid, SecurityAlgorithms.EcdsaSha256);

        using var http = new HttpClient(new MockJwksHandler(TokenHelper.ToJwksJson(ecKey, kid)));
        var client = new XidClient(new XidOptions { Issuer = "https://xid.dev" }, http);

        // Act
        AuthStatus status = await client.AuthenticateRequestAsync($"Bearer {token}");

        // Assert
        Assert.True(status.Authenticated);
        Assert.NotNull(status.Claims);
        Assert.Equal("user-123", status.Claims!.Sub);
    }

    // -- 默认不从 Cookie 提取 token --

    [Fact]
    public async Task AuthenticateRequest_ImplicitAndCoreCookies_Unauthenticated()
    {
        // Arrange
        var (ecKey, kid) = TokenHelper.CreateEcKey();
        var securityKey = new ECDsaSecurityKey(ecKey) { KeyId = kid };
        string token = TokenHelper.CreateToken(securityKey, kid, SecurityAlgorithms.EcdsaSha256);

        using var http = new HttpClient(new MockJwksHandler(TokenHelper.ToJwksJson(ecKey, kid)));
        var client = new XidClient(new XidOptions { Issuer = "https://xid.dev" }, http);

        var cookies = new Dictionary<string, string>
        {
            ["__session"] = token,
            ["__Host-xid.rt.abcdefgh"] = token,
        };

        // Act
        AuthStatus status = await client.AuthenticateRequestAsync(null, cookies);

        // Assert
        Assert.False(status.Authenticated);
        Assert.Null(status.Claims);
    }

    [Fact]
    public async Task AuthenticateRequest_ExplicitApplicationJwtCookie_Authenticated()
    {
        var (ecKey, kid) = TokenHelper.CreateEcKey();
        var securityKey = new ECDsaSecurityKey(ecKey) { KeyId = kid };
        string token = TokenHelper.CreateToken(securityKey, kid, SecurityAlgorithms.EcdsaSha256);

        using var http = new HttpClient(new MockJwksHandler(TokenHelper.ToJwksJson(ecKey, kid)));
        var client = new XidClient(
            new XidOptions
            {
                Issuer = "https://xid.dev",
                SessionCookieName = "__app_xid_jwt",
            },
            http);
        var cookies = new Dictionary<string, string> { ["__app_xid_jwt"] = token };

        AuthStatus status = await client.AuthenticateRequestAsync(null, cookies);

        Assert.True(status.Authenticated);
    }

    // -- 无 token 返回 Fail --

    [Fact]
    public async Task AuthenticateRequest_NoToken_Unauthenticated()
    {
        // Arrange
        using var http = new HttpClient(new MockJwksHandler("{\"keys\":[]}"));
        var client = new XidClient(new XidOptions { Issuer = "https://xid.dev" }, http);

        // Act
        AuthStatus status = await client.AuthenticateRequestAsync(null, null);

        // Assert
        Assert.False(status.Authenticated);
        Assert.NotNull(status.Reason);
    }
}

public class SessionTokenExchangeTests
{
    [Fact]
    public async Task Exchange_ExactSameOrigin_ForwardsCompleteCookie()
    {
        using var client = new XidClient(new XidOptions { Issuer = "https://app.example" });
        string token = await client.ExchangeSessionTokenAsync(
            "https://app.example/api",
            "__Host-xid.rt.abc=opaque; __Host-xid.active=sess_abc",
            "/v1/sessions/token",
            (endpoint, cookie, _) =>
            {
                Assert.Equal("https://app.example/v1/sessions/token", endpoint.ToString());
                Assert.Equal(
                    "__Host-xid.rt.abc=opaque; __Host-xid.active=sess_abc",
                    cookie);
                return Task.FromResult(
                    new SessionTokenHttpResponse(200, "{\"token\":\"jwt-value\"}"));
            });
        Assert.Equal("jwt-value", token);
    }

    [Fact]
    public async Task Exchange_RejectsCrossOriginBeforeTransport()
    {
        using var client = new XidClient(new XidOptions { Issuer = "https://app.example" });
        bool called = false;
        await Assert.ThrowsAsync<SessionTokenExchangeException>(() =>
            client.ExchangeSessionTokenAsync(
                "https://app.example/api",
                "__Host-xid.rt.abc=opaque",
                "https://xid.dev/v1/sessions/token",
                (_, _, _) =>
                {
                    called = true;
                    return Task.FromResult(
                        new SessionTokenHttpResponse(200, "{\"token\":\"jwt\"}"));
                }));
        Assert.False(called);
    }

    [Theory]
    [InlineData(302, "{\"token\":\"jwt\"}")]
    [InlineData(200, "{\"jwt\":\"wrong\"}")]
    [InlineData(200, "{\"token\":\"\"}")]
    [InlineData(200, "{\"token\":\"jwt\",\"extra\":true}")]
    [InlineData(200, "not-json")]
    public async Task Exchange_RejectsRedirectAndInvalidResponse(int status, string body)
    {
        using var client = new XidClient(new XidOptions { Issuer = "https://app.example" });
        await Assert.ThrowsAsync<SessionTokenExchangeException>(() =>
            client.ExchangeSessionTokenAsync(
                "https://app.example/api",
                "__Host-xid.rt.abc=opaque",
                null,
                (_, _, _) => Task.FromResult(new SessionTokenHttpResponse(status, body))));
    }
}
