# Xid .NET Server SDK

**Status: implemented (verified locally)**

> 本机 `dotnet test` 全部 PASS(net8.0 + net9.0,见 `docs/sdks/platform-matrix.md`)。
> 真实 IdP round-trip(L4)尚未验证,生产使用前必须完整测试。

XID Identity Platform 的 .NET 服务端 SDK。目标运行时 net8.0。

职责范围:

- networkless JWT 验证(JWKS 带内存缓存,ES256 主 / RS256 / PS256 兼容)
- 请求认证(Authorization: Bearer 或 Cookie)
- webhook 验证(svix 风格 HMAC-SHA256 + 5 分钟时间窗防重放)

不负责 OAuth 授权流程(那是客户端 SDK 的职责)。

---

## 安装

```xml
<!-- Xid.csproj 或 .csproj 引用 -->
<PackageReference Include="Xid" Version="0.1.0" />
```

依赖:

- `Microsoft.IdentityModel.Tokens` 8.3.2
- `System.IdentityModel.Tokens.Jwt` 8.3.2

---

## 最小用法示例

### ASP.NET Core 依赖注入(推荐)

```csharp
// Program.cs
using Xid;

builder.Services.AddXid(options =>
{
    options.Issuer = "https://xid.dev";       // 或自托管域名
    options.Audience = "your-client-id";       // 可选
});
```

```csharp
// Controller / Minimal API
public class MyController(XidClient xid) : ControllerBase
{
    [HttpGet("/me")]
    public async Task<IActionResult> GetMe()
    {
        var auth = await xid.AuthenticateRequestAsync(
            authorizationHeader: Request.Headers.Authorization,
            cookies: Request.Cookies.ToDictionary(c => c.Key, c => c.Value));

        if (!auth.Authenticated)
            return Unauthorized(auth.Reason);

        return Ok(new { sub = auth.Claims!.Sub, email = auth.Claims.Email });
    }
}
```

### 不使用 DI

```csharp
using Xid;

var client = new XidClient(new XidOptions
{
    Issuer = "https://xid.dev",
    Audience = "your-client-id",
});

// 验证 access token
try
{
    var claims = await client.VerifyTokenAsync("eyJ...");
    Console.WriteLine($"sub={claims.Sub} email={claims.Email}");
}
catch (TokenVerificationException ex)
{
    Console.WriteLine($"Invalid token: {ex.Message}");
}
```

### Webhook 验证

```csharp
// Minimal API -- webhook endpoint
app.MapPost("/webhooks/xid", async (HttpRequest req, XidClient xid) =>
{
    using var ms = new MemoryStream();
    await req.Body.CopyToAsync(ms);
    var body = ms.ToArray();

    var headers = new Dictionary<string, string>
    {
        ["svix-id"]        = req.Headers["svix-id"].ToString(),
        ["svix-timestamp"] = req.Headers["svix-timestamp"].ToString(),
        ["svix-signature"] = req.Headers["svix-signature"].ToString(),
    };

    try
    {
        var webhook = xid.VerifyWebhook(body, headers, secret: "whsec_your_secret");
        var evt = JsonSerializer.Deserialize<JsonElement>(webhook.RawBody.Span);
        // 处理事件...
        return Results.Ok();
    }
    catch (WebhookVerificationException ex)
    {
        return Results.BadRequest(ex.Message);
    }
});
```

---

## API

### XidOptions

| 属性                     | 类型       | 默认值      | 说明                                                   |
| ------------------------ | ---------- | ----------- | ------------------------------------------------------ |
| `Issuer`                 | `string`   | (必填)      | XID issuer URL,例如 `https://xid.dev`                  |
| `Audience`               | `string?`  | null        | 期望的 aud claim;null 时跳过 audience 校验             |
| `JwksUri`                | `string?`  | null        | 自定义 JWKS endpoint;null 时自动构造为 `{Issuer}/jwks` |
| `JwksTtl`                | `TimeSpan` | 1 小时      | JWKS 内存缓存有效期                                    |
| `SessionCookieName`      | `string`   | `__session` | 回落 Cookie 名称                                       |
| `ClockSkew`              | `TimeSpan` | 5 分钟      | JWT exp/nbf 时钟偏差容忍                               |
| `WebhookToleranceWindow` | `TimeSpan` | 5 分钟      | Webhook 时间窗防重放                                   |

### XidClient

```csharp
// 验证 token,失败抛 TokenVerificationException
Task<TokenClaims> VerifyTokenAsync(string token, CancellationToken ct = default)

// 从请求头/Cookie 提取 token 并验证,不抛异常
Task<AuthStatus> AuthenticateRequestAsync(
    string? authorizationHeader,
    IReadOnlyDictionary<string, string>? cookies = null,
    CancellationToken ct = default)

// 验证 webhook 签名,失败抛 WebhookVerificationException
WebhookPayload VerifyWebhook(
    ReadOnlySpan<byte> payload,
    IReadOnlyDictionary<string, string> headers,
    string secret)
```

### TokenClaims

| 属性            | 类型                                | 对应 JWT claim    |
| --------------- | ----------------------------------- | ----------------- |
| `Sub`           | `string`                            | sub               |
| `Iss`           | `string`                            | iss               |
| `Aud`           | `IReadOnlyList<string>`             | aud               |
| `Exp`           | `long`                              | exp (Unix 秒)     |
| `Iat`           | `long`                              | iat (Unix 秒)     |
| `Jti`           | `string?`                           | jti               |
| `Nbf`           | `long?`                             | nbf (Unix 秒)     |
| `Scope`         | `string?`                           | scope             |
| `ClientId`      | `string?`                           | client_id         |
| `Email`         | `string?`                           | email             |
| `EmailVerified` | `bool?`                             | email_verified    |
| `Name`          | `string?`                           | name              |
| `Extra`         | `FrozenDictionary<string, object?>` | 其余自定义 claims |

### AuthStatus

```csharp
bool Authenticated   // true = 认证成功
TokenClaims? Claims  // Authenticated=true 时有值
string? Reason       // Authenticated=false 时说明原因
```

### 异常

| 类型                           | Code                         | 触发场景                       |
| ------------------------------ | ---------------------------- | ------------------------------ |
| `XidException`                 | `xid_error`                  | 所有 SDK 错误的基类            |
| `JwksException`                | `jwks_error`                 | JWKS 拉取或解析失败            |
| `TokenVerificationException`   | `token_verification_error`   | JWT 签名/claims 验证失败       |
| `WebhookVerificationException` | `webhook_verification_error` | Webhook 签名不合法或时间窗超限 |

---

## 目录结构

```
sdk/dotnet/
  Xid.csproj                   包清单与依赖
  README.md                    本文件
  src/
    Exceptions.cs              异常层次结构
    Models.cs                  TokenClaims / AuthStatus / WebhookPayload
    JwksCache.cs               JWKS 拉取与内存缓存
    XidClient.cs               主入口 -- JWT 验证 / 请求认证 / Webhook 验证
    ServiceCollectionExtensions.cs  ASP.NET Core DI 集成
```

---

## 已实现的增强能力

- [x] **ILogger 接入**:`JwksCache` 构造器接受 `ILogger<JwksCache>?`,单条 JWK 解析失败时 `LogWarning`
- [x] **分布式缓存接口**:`IJwksExternalCache` + `JwksCache` 可选注入,多实例共享 JWKS 快照
- [x] **测试覆盖**:`dotnet test` 16 项单元测试(ES256/RS256、aud/iss/exp 负路径、webhook)

---

## 后续增强(非阻塞)

- [ ] **JWKS 预热**:启动时主动拉取 JWKS 而非等第一次请求触发,减少冷启动延迟
- [ ] **多 Audience 支持**:XidOptions.Audience 目前只接受单字符串,待支持 `IEnumerable<string>`
- [ ] **PS256 公钥解析验证**:RSA 公钥路径同时服务 RS256 和 PS256,需确认 alg 头匹配逻辑
- [ ] **NuGet 发布流水线**:GitHub Actions CI(build / test / pack / publish)
- [ ] **Source Link 与符号包**:调试体验
- [ ] **ASP.NET Core Middleware**:封装 AuthenticateRequestAsync 为标准 AuthenticationHandler,接入 [Authorize] 属性体系
