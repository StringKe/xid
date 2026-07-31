# Xid.Windows

> Registry status: UNPUBLISHED. No external registry release is verified or authorized.
> Use a local `ProjectReference` until an authorized NuGet release exists.

**Status: implemented (verified locally)**

> 本机 `dotnet test` 全部 PASS(net8.0 跨平台编译,net10.0 测试,见 `docs/sdks/platform-matrix.md`)。
> 真实 IdP round-trip(L4)尚未验证,不得直接用于生产环境。

XID 身份平台 Windows 客户端 SDK,面向 WinUI 3 / Windows App SDK 应用。

实现 Hosted Auth + OIDC Authorization Code + PKCE S256 流程,token 经 DPAPI 加密存入 IsolatedStorage。

当前 public client 默认请求 `openid profile email`。SDK 尚未实现 DPoP,因此会在授权前拒绝
`offline_access`,也不会请求、存储或使用 refresh token。access token 在有效期内可直接读取;
到期或使用 `ForceRefresh` 后必须重新调用 `SignInAsync()` 完成授权。

---

## 安装

```xml
<ItemGroup>
  <ProjectReference Include="../xid/sdk/windows/Xid.Windows.csproj" />
</ItemGroup>
```

`Xid.Windows` 是预留 NuGet package ID,当前不能通过 `<PackageReference>` 从 NuGet 安装。

前置要求:

- .NET 8 + Windows App SDK 1.6+
- WebView2 Runtime (Evergreen,已随 Edge 安装)
- 应用已配置 `<UseWinUI>true</UseWinUI>`

---

## 快速开始

### 1. 初始化(App.xaml.cs)

```csharp
using Xid.Windows;

protected override void OnLaunched(LaunchActivatedEventArgs args)
{
    XidClient.Shared.Configure(new XidConfiguration
    {
        Issuer     = new Uri("https://xid.dev"),
        ClientId   = "your_client_id",
        RedirectUri = "com.example.myapp://auth/callback",
        // Scopes 默认: openid profile email
    });
}
```

### 2. 登录

```csharp
using Xid.Windows;

try
{
    XidSession session = await XidClient.Shared.SignInAsync();
    Console.WriteLine($"已登录: {session.User.Email}");
}
catch (AuthorizationCanceledException)
{
    // 用户关闭了授权窗口
}
catch (XidException ex)
{
    Console.WriteLine($"登录失败 [{ex.Code}]: {ex.Message}");
}
```

### 3. 获取 access token

```csharp
string? token = await XidClient.Shared.GetAccessToken();
if (token is null)
{
    // 未登录,跳转登录页
    return;
}

// 调用受保护 API
httpClient.DefaultRequestHeaders.Authorization =
    new AuthenticationHeaderValue("Bearer", token);
```

### 4. 获取当前会话

```csharp
XidSession? session = await XidClient.Shared.GetSession();
if (session is null)
{
    // 未登录
    return;
}
Console.WriteLine($"用户: {session.User.Name}");
Console.WriteLine($"过期: {session.ExpiresAt:u}");
```

### 5. 处理自定义 URI scheme 回调(可选)

若使用自定义 URI scheme 而非 WebView2 弹窗,在应用 URI 激活回调中调用:

```csharp
// App.xaml.cs 或 MainWindow 的激活处理
protected override void OnActivated(IActivatedEventArgs args)
{
    if (args.Kind == ActivationKind.Protocol)
    {
        var protocolArgs = (ProtocolActivatedEventArgs)args;
        await XidClient.Shared.HandleRedirectAsync(protocolArgs.Uri);
    }
}
```

### 6. 登出

```csharp
await XidClient.Shared.SignOut();
```

### 7. 替换 token 存储适配器

```csharp
// 在 Configure() 之后调用
XidClient.Shared.SetTokenStorage(new MyCustomStorage());
```

自定义存储实现 `ITokenStorage` 接口:

```csharp
public sealed class MyCustomStorage : ITokenStorage
{
    public Task SaveAsync(StoredTokenSet tokens, CancellationToken ct = default) { ... }
    public Task<StoredTokenSet?> LoadAsync(CancellationToken ct = default) { ... }
    public Task ClearAsync(CancellationToken ct = default) { ... }
}
```

---

## 匿名登录(Firebase 式 guest)

guest 是真实的用户实体(服务端 `provisioned_by = 'anonymous'`),可先让用户体验应用,再引导转正。

```csharp
XidSession session = await XidClient.Shared.SignInAnonymouslyAsync();

if (session.IsAnonymous)
{
    Console.WriteLine($"guest id: {session.User.Sub}");
    // guest 没有 access token;调用 XID cookie 认证的 API 时带上会话 cookie:
    // request.Headers.TryAddWithoutValidation("Cookie", session.SessionCookie);
}
```

行为说明:

- **惰性语义**:本地已有有效会话(token 或 guest)时不发请求,直接返回现有会话;不会重复建号。
- **建号能力**:真正建号前先 GET `/auth/config?intent=sign-up` 取得一次性
  `guest.capabilityToken`,再随 POST `/auth/guest` 提交;capability 不缓存或复用。
- **凭证形态**:guest 会话无 access token / id token,凭证是 `SessionId` + `SessionCookie`
  (`__Host-xid.rt.*`),经 `ITokenStorage` 与 OIDC token 一同加密持久化。
- **不可恢复、单设备**:guest 账号只存在当前设备的 cookie 会话里,设备丢失或会话过期后无法找回。
  请尽早引导用户在应用内完成任一正式登录转正。
- **sub 连续性**:转正后 `User.Sub` 不变,应用内数据自然延续;若 guest 改登另一个既有账号,
  `Sub` 会变,调用方可对比登录前后的 `User.Sub` 判断是否同一账号。
- 服务端启用 Turnstile 时,通过 `SignInAnonymouslyOptions.TurnstileToken` 传入;native 端通常不需要。

---

## API 参考

### XidClient

| 方法                                                        | 说明                                   |
| ----------------------------------------------------------- | -------------------------------------- |
| `Configure(XidConfiguration)`                               | 初始化 SDK,应用启动时调用一次          |
| `SignInAsync(SignInOptions?, CancellationToken)`            | 弹出 WebView2 授权窗口,完成登录        |
| `SignInAnonymouslyAsync(SignInAnonymouslyOptions?, CancellationToken)` | 匿名访客 (guest) 登录,返回 cookie 会话 |
| `HandleRedirectAsync(Uri, CancellationToken)`               | 处理自定义 URI scheme 回调             |
| `GetSession(CancellationToken)`                             | 获取未过期会话;过期后返回 null          |
| `GetAccessToken(GetAccessTokenOptions?, CancellationToken)` | 获取未过期 token;过期后要求重新授权     |
| `SignOut(CancellationToken)`                                | 清除本地会话和 token                   |
| `SetTokenStorage(ITokenStorage)`                            | 替换 token 存储适配器                  |

### XidConfiguration

| 属性              | 类型                    | 说明                                       |
| ----------------- | ----------------------- | ------------------------------------------ |
| `Issuer`          | `Uri`                   | XID issuer URL,例如 `https://xid.dev`      |
| `ClientId`        | `string`                | OAuth 客户端 ID(public client)             |
| `RedirectUri`     | `string`                | 注册的回调 URI                             |
| `Scopes`          | `IReadOnlyList<string>` | 默认 `openid profile email`;拒绝 `offline_access` |
| `TokenStorage`    | `ITokenStorage`         | 默认 `DpapiTokenStorage`                   |
| `AuthWindowTitle` | `string`                | WebView2 窗口标题,默认 "Sign in"           |
| `HttpTimeout`     | `TimeSpan`              | HTTP 超时,默认 30 秒                       |

### XidSession

| 属性            | 说明                                                  |
| --------------- | ----------------------------------------------------- |
| `AccessToken`   | access token (JWT),生命周期约 1 小时;guest 会话为 null |
| `RefreshToken`  | 保留字段;DPoP 支持完成前始终为 null                    |
| `IdToken`       | id token (JWT);guest 会话为 null                       |
| `ExpiresAt`     | access token 过期时间 (UTC);guest 会话为 null           |
| `User`          | 用户信息(sub / email / name / picture)                 |
| `SessionId`     | guest 会话 ID;OIDC 会话为 null                          |
| `SessionCookie` | guest 会话 cookie(name=value);OIDC 会话为 null          |
| `IsAnonymous`   | 是否为匿名访客 (guest)                                  |
| `IsExpired`     | access token 是否已过期                                |
| `IsNearExpiry`  | 剩余不足 60 秒视为即将过期                             |

### XidUser

| 属性            | 说明                                            |
| --------------- | ----------------------------------------------- |
| `Sub`           | 用户主体标识符;guest 转正后不变                  |
| `ProvisionedBy` | 账号开通来源(`'anonymous'` 表示 guest),可为 null |
| `IsAnonymous`   | `ProvisionedBy == 'anonymous'`                   |

---

## 安全说明

- public client:不存 client_secret。
- PKCE 强制 S256,服务端拒绝 plain。
- token 经 DPAPI (CurrentUser scope) 加密后存入 IsolatedStorage。
- 不使用 implicit flow 或 password grant。
- state 参数防 CSRF,每次 signIn 生成新随机值。

---

## 依赖

| 包                                           | 版本          | 用途                    |
| -------------------------------------------- | ------------- | ----------------------- |
| `Microsoft.WindowsAppSDK`                    | 1.6.250228002 | WinUI 3 + WebView2 宿主 |
| `Microsoft.Web.WebView2`                     | 1.0.3065.39   | Chromium 授权窗口       |
| `System.Security.Cryptography.ProtectedData` | 8.0.0         | DPAPI 加密              |

---

## 已实现的增强能力

- [x] **id token JWKS 验签** -- `JwksCache` + `IdTokenVerifier`(ES256/RS256/PS256)
- [x] **nonce 校验** -- `SignInAsync` 生成 nonce,换码后验证 id token `nonce` claim
- [x] **end_session** -- `SignOut(callEndSession: true)` POST `id_token_hint`

---

## 后续增强(非阻塞)

- [ ] WebAuthenticationBroker 支持(减少对 WebView2 运行时的硬依赖)
- [ ] loopback 端口随机化 + HTTP listener 实现(loopback redirect URI 方案)
- [ ] 多账号会话支持
- [ ] MSIX 打包适配(IsolatedStorage 在 MSIX 沙箱下的路径隔离验证)
- [ ] Windows Hello / Windows Credential Manager 存储适配器
- [ ] L4 round-trip -- 真实 IdP 端到端验证
