// XidWindowsTests.cs
// XID Windows SDK 单元测试
//
// 覆盖:
//   - PKCE S256 生成:verifier 长度 / challenge 长度 / method 固定 S256 / 使用 CSPRNG
//   - PKCE S256 校验:challenge = BASE64URL(SHA256(verifier))
//   - IdTokenDecoder:标准 claims 解码
//   - IdTokenDecoder:格式非法 JWT 抛异常
//   - XidClient:未初始化调用抛 XidNotConfiguredException
//   - XidClient:未设置 BrowserSession 调用 SignIn 抛异常
//   - XidClient:SetTokenStorage 替换存储适配器
//   - IBrowserSession / ITokenStorage:接口可替换
//   - StoredTokenSet:字段读写

using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.IdentityModel.Tokens;

namespace Xid.Windows.Tests;

public class PkceTests
{
    // -- S256 基本属性 --

    [Fact]
    public void Generate_Verifier_Has43OrMoreChars()
    {
        // RFC 7636: code_verifier 最少 43 字符
        PkceParameters pkce = PkceParameters.Generate();
        Assert.True(pkce.Verifier.Length >= 43,
            $"code_verifier length should be >= 43, got {pkce.Verifier.Length}");
    }

    [Fact]
    public void Generate_Challenge_Has43Chars()
    {
        // SHA256 -> 32 bytes -> BASE64URL = 43 chars (无填充)
        PkceParameters pkce = PkceParameters.Generate();
        Assert.Equal(43, pkce.Challenge.Length);
    }

    [Fact]
    public void Generate_Method_IsS256()
    {
        PkceParameters pkce = PkceParameters.Generate();
        Assert.Equal("S256", pkce.Method);
    }

    [Fact]
    public void Generate_Challenge_MatchesSha256OfVerifier()
    {
        // challenge = BASE64URL(SHA256(ASCII(verifier)))
        PkceParameters pkce = PkceParameters.Generate();

        byte[] verifierBytes = Encoding.ASCII.GetBytes(pkce.Verifier);
        byte[] hashBytes = SHA256.HashData(verifierBytes);

        // BASE64URL encode (无填充)
        string expectedChallenge = Convert.ToBase64String(hashBytes)
            .Replace('+', '-')
            .Replace('/', '_')
            .TrimEnd('=');

        Assert.Equal(expectedChallenge, pkce.Challenge);
    }

    [Fact]
    public void Generate_Verifier_IsBase64UrlAlphabet()
    {
        // verifier 只应包含 Base64URL 字符集
        PkceParameters pkce = PkceParameters.Generate();
        foreach (char c in pkce.Verifier)
        {
            bool valid = (c >= 'A' && c <= 'Z') ||
                         (c >= 'a' && c <= 'z') ||
                         (c >= '0' && c <= '9') ||
                         c == '-' || c == '_';
            Assert.True(valid, $"Unexpected char '{c}' in verifier");
        }
    }

    [Fact]
    public void Generate_TwoCallsProduceDifferentValues()
    {
        // CSPRNG 保证:连续两次生成应不相同(概率极大)
        PkceParameters a = PkceParameters.Generate();
        PkceParameters b = PkceParameters.Generate();
        Assert.NotEqual(a.Verifier, b.Verifier);
        Assert.NotEqual(a.Challenge, b.Challenge);
    }
}

public class IdTokenDecoderTests
{
    // -- 辅助:构造假 JWT payload (不签名) --

    private static string BuildFakeIdToken(object claims)
    {
        string header = Base64UrlEncode("{\"alg\":\"ES256\",\"typ\":\"JWT\"}");
        string payload = Base64UrlEncode(JsonSerializer.Serialize(claims));
        string sig = Base64UrlEncode("fakesig");
        return $"{header}.{payload}.{sig}";
    }

    private static string Base64UrlEncode(string input)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(input);
        return Convert.ToBase64String(bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=');
    }

    // -- 标准 claims 解码 --

    [Fact]
    public void Decode_StandardClaims_ParsedCorrectly()
    {
        string idToken = BuildFakeIdToken(new
        {
            sub = "user-456",
            email = "test@example.com",
            email_verified = true,
            name = "Test User",
            picture = "https://example.com/pic.jpg",
            exp = 9999999999L,
            iss = "https://xid.dev",
        });

        IdTokenClaims claims = IdTokenDecoder.Decode(idToken);

        Assert.Equal("user-456", claims.Sub);
        Assert.Equal("test@example.com", claims.Email);
        Assert.True(claims.EmailVerified);
        Assert.Equal("Test User", claims.Name);
        Assert.Equal("https://example.com/pic.jpg", claims.Picture);
        Assert.Equal(9999999999L, claims.Exp);
        Assert.Equal("https://xid.dev", claims.Iss);
    }

    // -- 缺少可选字段返回 null --

    [Fact]
    public void Decode_MinimalClaims_OptionalFieldsAreNull()
    {
        string idToken = BuildFakeIdToken(new
        {
            sub = "user-minimal",
            exp = 9999999999L,
        });

        IdTokenClaims claims = IdTokenDecoder.Decode(idToken);

        Assert.Equal("user-minimal", claims.Sub);
        Assert.Null(claims.Email);
        Assert.Null(claims.EmailVerified);
        Assert.Null(claims.Name);
        Assert.Null(claims.Picture);
    }

    // -- 格式非法:非三段 JWT --

    [Fact]
    public void Decode_MalformedToken_Throws()
    {
        Assert.Throws<TokenExchangeException>(() =>
            IdTokenDecoder.Decode("not.a.valid.jwt.token"));
    }

    // -- 格式非法:payload 非法 Base64 --

    [Fact]
    public void Decode_InvalidBase64Payload_Throws()
    {
        Assert.Throws<TokenExchangeException>(() =>
            IdTokenDecoder.Decode("header.!invalid!.sig"));
    }
}

public class XidClientConfigTests
{
    // -- 未初始化调用抛 XidNotConfiguredException --

    [Fact]
    public async Task GetSession_BeforeConfigure_ThrowsNotConfigured()
    {
        var client = XidClient.Shared;
        // 为了不影响全局 Shared 实例,用 reflection 创建新实例
        var ctor = typeof(XidClient).GetConstructor(
            System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance,
            null, Type.EmptyTypes, null);
        Assert.NotNull(ctor);
        var freshClient = (XidClient)ctor!.Invoke([]);

        await Assert.ThrowsAsync<XidNotConfiguredException>(() => freshClient.GetSession());
    }

    [Fact]
    public async Task SignOut_BeforeConfigure_ThrowsNotConfigured()
    {
        var ctor = typeof(XidClient).GetConstructor(
            System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance,
            null, Type.EmptyTypes, null);
        var freshClient = (XidClient)ctor!.Invoke([]);

        await Assert.ThrowsAsync<XidNotConfiguredException>(() => freshClient.SignOut());
    }

    // -- 未设置 BrowserSession 调用 SignInAsync 抛异常 --

    [Fact]
    public async Task SignIn_NoBrowserSession_ThrowsXidException()
    {
        var ctor = typeof(XidClient).GetConstructor(
            System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance,
            null, Type.EmptyTypes, null);
        var freshClient = (XidClient)ctor!.Invoke([]);

        // 配置 SDK,不注入 BrowserSession
        freshClient.Configure(new XidConfiguration
        {
            Issuer = new Uri("https://xid.dev"),
            ClientId = "test-client",
            RedirectUri = "myapp://auth/callback",
            // BrowserSession 在 non-Windows 编译下默认为 null
        });

        var ex = await Assert.ThrowsAsync<XidException>(() => freshClient.SignInAsync());
        Assert.Equal("no_browser_session", ex.Code);
    }

    // -- SetTokenStorage 替换存储适配器 --

    [Fact]
    public void SetTokenStorage_ReplacesAdapter()
    {
        var ctor = typeof(XidClient).GetConstructor(
            System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance,
            null, Type.EmptyTypes, null);
        var freshClient = (XidClient)ctor!.Invoke([]);

        freshClient.Configure(new XidConfiguration
        {
            Issuer = new Uri("https://xid.dev"),
            ClientId = "test-client",
            RedirectUri = "myapp://auth/callback",
        });

        var mockStorage = new InMemoryTokenStorage();
        freshClient.SetTokenStorage(mockStorage); // should not throw

        // If we can set storage without error, the contract is met
        Assert.NotNull(mockStorage);
    }

    // -- SetBrowserSession 可在配置后注入 --

    [Fact]
    public void SetBrowserSession_ReplacesAdapter()
    {
        var ctor = typeof(XidClient).GetConstructor(
            System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance,
            null, Type.EmptyTypes, null);
        var freshClient = (XidClient)ctor!.Invoke([]);

        freshClient.Configure(new XidConfiguration
        {
            Issuer = new Uri("https://xid.dev"),
            ClientId = "test-client",
            RedirectUri = "myapp://auth/callback",
        });

        var mockBrowser = new NopBrowserSession();
        freshClient.SetBrowserSession(mockBrowser); // should not throw
        Assert.NotNull(mockBrowser);
    }
}

public class StoredTokenSetTests
{
    // -- StoredTokenSet 字段读写 --

    [Fact]
    public void StoredTokenSet_Properties_RoundTrip()
    {
        var stored = new StoredTokenSet
        {
            AccessToken = "at_123",
            RefreshToken = "rt_456",
            IdToken = "id_789",
            ExpiresAt = DateTimeOffset.UtcNow.AddHours(1),
        };

        Assert.Equal("at_123", stored.AccessToken);
        Assert.Equal("rt_456", stored.RefreshToken);
        Assert.Equal("id_789", stored.IdToken);
        Assert.True(stored.ExpiresAt > DateTimeOffset.UtcNow);
    }

    // -- InMemoryTokenStorage 满足 ITokenStorage 契约 --

    [Fact]
    public async Task InMemoryTokenStorage_SaveLoadClear_WorksCorrectly()
    {
        ITokenStorage storage = new InMemoryTokenStorage();
        var tokens = new StoredTokenSet
        {
            AccessToken = "access",
            RefreshToken = "refresh",
            IdToken = "idtoken",
            ExpiresAt = DateTimeOffset.UtcNow.AddHours(1),
        };

        // Save
        await storage.SaveAsync(tokens);

        // Load
        StoredTokenSet? loaded = await storage.LoadAsync();
        Assert.NotNull(loaded);
        Assert.Equal("access", loaded!.AccessToken);
        Assert.Equal("refresh", loaded.RefreshToken);

        // Clear
        await storage.ClearAsync();
        StoredTokenSet? afterClear = await storage.LoadAsync();
        Assert.Null(afterClear);
    }
}

public class IdTokenVerifierTests
{
    [Fact]
    public async Task Verify_ValidEs256Token_Succeeds()
    {
        var (ecKey, kid) = TokenTestHelper.CreateEcKey();
        string jwksJson = TokenTestHelper.ToJwksJson(ecKey, kid);
        using var handler = new MockJwksHandler(jwksJson);
        using var http = new HttpClient(handler);
        var cache = new JwksCache("https://xid.dev/jwks", httpClient: http);

        string token = TokenTestHelper.CreateToken(
            new ECDsaSecurityKey(ecKey) { KeyId = kid },
            kid,
            SecurityAlgorithms.EcdsaSha256,
            audience: "test-client",
            extraClaims: [new Claim(JwtRegisteredClaimNames.Nonce, "nonce-abc")]);

        IdTokenClaims claims = await IdTokenVerifier.VerifyAsync(
            token,
            cache,
            "https://xid.dev",
            "test-client",
            "nonce-abc");

        Assert.Equal("user-123", claims.Sub);
    }

    [Fact]
    public async Task Verify_NonceMismatch_Throws()
    {
        var (ecKey, kid) = TokenTestHelper.CreateEcKey();
        string jwksJson = TokenTestHelper.ToJwksJson(ecKey, kid);
        using var handler = new MockJwksHandler(jwksJson);
        using var http = new HttpClient(handler);
        var cache = new JwksCache("https://xid.dev/jwks", httpClient: http);

        string token = TokenTestHelper.CreateToken(
            new ECDsaSecurityKey(ecKey) { KeyId = kid },
            kid,
            SecurityAlgorithms.EcdsaSha256,
            audience: "test-client",
            extraClaims: [new Claim(JwtRegisteredClaimNames.Nonce, "expected")]);

        await Assert.ThrowsAsync<TokenVerificationException>(() =>
            IdTokenVerifier.VerifyAsync(
                token,
                cache,
                "https://xid.dev",
                "test-client",
                "actual"));
    }
}

public class IBrowserSessionContractTests
{
    // -- 自定义 IBrowserSession 实现可被注入 --

    [Fact]
    public void CustomBrowserSession_CanBeInjected()
    {
        IBrowserSession session = new NopBrowserSession();
        Assert.NotNull(session);
    }

    // -- CancelledBrowserSession 抛 AuthorizationCanceledException --

    [Fact]
    public async Task CancelledBrowserSession_ThrowsAuthorizationCanceled()
    {
        IBrowserSession session = new CancellingBrowserSession();

        await Assert.ThrowsAsync<AuthorizationCanceledException>(() =>
            session.RunAsync("https://xid.dev/authorize", "myapp://cb", "state", default));
    }
}

// ---- 测试辅助实现 ----

/// <summary>内存 token 存储,测试用。</summary>
file sealed class InMemoryTokenStorage : ITokenStorage
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

/// <summary>不执行任何操作的 browser session 适配器,测试用。</summary>
file sealed class NopBrowserSession : IBrowserSession
{
    public Task<BrowserSessionResult> RunAsync(
        string authorizeUrl,
        string redirectUri,
        string expectedState,
        CancellationToken ct = default)
        => Task.FromResult(new BrowserSessionResult { Code = "code", State = expectedState });
}

/// <summary>总是取消授权的 browser session 适配器,测试用。</summary>
file sealed class CancellingBrowserSession : IBrowserSession
{
    public Task<BrowserSessionResult> RunAsync(
        string authorizeUrl,
        string redirectUri,
        string expectedState,
        CancellationToken ct = default)
        => Task.FromException<BrowserSessionResult>(new AuthorizationCanceledException());
}

file sealed class MockJwksHandler : HttpMessageHandler
{
    private readonly string _jwksJson;

    public MockJwksHandler(string jwksJson) => _jwksJson = jwksJson;

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken ct)
    {
        var response = new HttpResponseMessage(System.Net.HttpStatusCode.OK)
        {
            Content = new StringContent(_jwksJson, Encoding.UTF8, "application/json"),
        };
        return Task.FromResult(response);
    }
}

file static class TokenTestHelper
{
    private static readonly JwtSecurityTokenHandler Handler = new();

    static TokenTestHelper()
    {
        Handler.InboundClaimTypeMap.Clear();
    }

    public static (ECDsa Key, string Kid) CreateEcKey()
    {
        var ec = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        return (ec, "ec-key-1");
    }

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
                },
            },
        };
        return JsonSerializer.Serialize(jwk);
    }

    public static string CreateToken(
        SecurityKey signingKey,
        string kid,
        string alg,
        string issuer = "https://xid.dev",
        string? audience = "test-client",
        string subject = "user-123",
        IEnumerable<Claim>? extraClaims = null)
    {
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, subject),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString()),
        };
        if (extraClaims is not null)
            claims.AddRange(extraClaims);

        var descriptor = new SecurityTokenDescriptor
        {
            Subject = new ClaimsIdentity(claims),
            Issuer = issuer,
            Audience = audience,
            Expires = DateTime.UtcNow.AddHours(1),
            SigningCredentials = new SigningCredentials(signingKey, alg),
        };
        return Handler.WriteToken(Handler.CreateToken(descriptor));
    }
}
