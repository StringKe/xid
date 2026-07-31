# Xid .NET Server SDK

> Registry status: UNPUBLISHED. No external registry release is verified or authorized.
> Use a local `ProjectReference` until an authorized NuGet release exists.

**Status: implemented (verified locally)**

> 本机 `dotnet test` 全部 PASS(net8.0 + net9.0,见 `docs/sdks/platform-matrix.md`)。
> 真实 IdP round-trip(L4)尚未验证,生产使用前必须完整测试。

XID Identity Platform 的 .NET 服务端 SDK。目标运行时 net8.0。

职责范围:

- networkless JWT 验证(JWKS 带内存缓存,ES256 主 / RS256 / PS256 兼容)
- 请求认证(默认 Authorization: Bearer;应用自有 JWT cookie 必须显式配置)
- Core opaque browser session -> short-lived JWT 显式 exchange
- webhook 验证(svix 风格 HMAC-SHA256 + 5 分钟时间窗防重放)

不负责 OAuth 授权流程(那是客户端 SDK 的职责)。

---

## 安装

```xml
<ItemGroup>
  <ProjectReference Include="../xid/sdk/dotnet/Xid.csproj" />
</ItemGroup>
```

`Xid` 是预留 NuGet package ID,当前不能通过 `<PackageReference>` 从 NuGet 安装。

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

默认不读取任何 cookie。只有设置
`SessionCookieName = "__Host-myapp.xid-jwt"` 时才读取应用自己持有的 JWT cookie。
`__Host-xid.rt.*` 是 opaque Core browser session,SDK 不会扫描或本地验证它。

```csharp
// Controller / Minimal API
public class MyController(XidClient xid) : ControllerBase
{
    [HttpGet("/me")]
    public async Task<IActionResult> GetMe()
    {
        var auth = await xid.AuthenticateRequestAsync(
            authorizationHeader: Request.Headers.Authorization);

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

### 将 Core browser session 交换为 JWT

```csharp
string token = await xid.ExchangeSessionTokenAsync(
    $"{Request.Scheme}://{Request.Host}{Request.Path}",
    Request.Headers.Cookie.ToString());
```

SDK 强制 exact same-origin `POST /v1/sessions/token`,完整转发 `Cookie` header,不跟随
redirect,并且只接受 HTTP 200 与 exact `{"token":"..."}` response。特殊 HTTP runtime
可通过 `SessionTokenTransport` adapter 注入,安全校验仍由 SDK 执行。

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

    var webhookSecret = Environment.GetEnvironmentVariable("XID_WEBHOOK_SECRET")
        ?? throw new InvalidOperationException("XID_WEBHOOK_SECRET is required");

    try
    {
        var webhook = xid.VerifyWebhook(body, headers, secret: webhookSecret);
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
| `SessionCookieName`      | `string?`  | null        | 应用自有 JWT cookie;null 禁用 fallback                 |
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

// Core opaque session -> short-lived JWT
Task<string> ExchangeSessionTokenAsync(
    string incomingRequestUrl,
    string cookieHeader,
    string? endpoint = null,
    SessionTokenTransport? transport = null,
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
| `Amr`           | `IReadOnlyList<string>`             | amr               |
| `IsGuest`       | `bool`                              | 由 amr 派生       |
| `Extra`         | `FrozenDictionary<string, object?>` | 其余自定义 claims |

### 匿名访客判定

`TokenClaims.IsGuest` 在 amr 包含 `guest` 时为 true,用于拦截匿名访客的敏感写操作
(等价 Firebase Security Rules 的 `sign_in_provider != 'anonymous'`)。
amr 缺失或为空时为 false;访客转正后平台签发的 token 不再带 `guest`,该值恒为 false。

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
| `SessionTokenExchangeException` | `session_token_exchange_error` | session exchange 失败        |
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
    SessionTokenExchange.cs    session exchange response / transport / exception
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
