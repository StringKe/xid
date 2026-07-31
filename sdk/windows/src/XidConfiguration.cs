// XidConfiguration.cs
// XID Windows SDK
//
// SDK 配置结构,传入 XidClient.Configure()。
// 所有 Windows 专属类型通过接口引用,跨平台可编译。

namespace Xid.Windows;

/// <summary>
/// XID SDK 配置选项。
/// </summary>
public sealed class XidConfiguration
{
    /// <summary>
    /// XID issuer URL,例如 https://xid.dev 或自托管域名根地址。
    /// OIDC discovery 文档位于 {issuer}/.well-known/openid-configuration。
    /// </summary>
    public required Uri Issuer { get; init; }

    /// <summary>
    /// 在 XID console 注册的 OAuth 客户端 ID。
    /// Windows 桌面应用为 public client,不存 ClientSecret。
    /// </summary>
    public required string ClientId { get; init; }

    /// <summary>
    /// 注册的 redirect URI。
    /// 建议使用自定义 URI scheme,例如 com.example.myapp://auth/callback。
    /// 也可使用 loopback 地址,例如 http://127.0.0.1:{port}/callback。
    /// </summary>
    public required string RedirectUri { get; init; }

    /// <summary>
    /// 请求的 OAuth scope 列表。
    /// 默认包含 openid / profile / email。
    /// 当前 SDK 尚未实现 DPoP,因此不支持 offline_access。
    /// </summary>
    public IReadOnlyList<string> Scopes { get; init; } =
        ["openid", "profile", "email"];

    /// <summary>
    /// token 持久化适配器。
    /// 默认使用 <see cref="DpapiTokenStorage"/> (DPAPI + IsolatedStorage,Windows 专属)。
    /// 非 Windows 平台或需要自定义存储时,通过 XidClient.SetTokenStorage() 替换。
    /// </summary>
    public ITokenStorage TokenStorage { get; init; } = new DpapiTokenStorage();

    /// <summary>
    /// 浏览器授权会话适配器。
    /// Windows 平台默认使用 <see cref="WebView2BrowserSession"/> (需 WebView2 运行时)。
    /// 非 Windows 平台必须在 Configure() 之后通过 XidClient.SetBrowserSession() 注入实现。
    /// </summary>
    public IBrowserSession? BrowserSession { get; init; }
#if WINDOWS
        = new WebView2BrowserSession();
#endif

    /// <summary>
    /// WebView2 授权窗口标题,默认 "Sign in"。
    /// 仅当使用默认 WebView2BrowserSession 时生效。
    /// </summary>
    public string AuthWindowTitle { get; init; } = "Sign in";

    /// <summary>
    /// HTTP 请求超时,默认 30 秒。
    /// </summary>
    public TimeSpan HttpTimeout { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>
    /// RP-initiated logout 完成后的跳转 URI(可选)。
    /// </summary>
    public string? PostLogoutRedirectUri { get; init; }

    /// <summary>JWKS 缓存 TTL,默认 1 小时。</summary>
    public TimeSpan JwksTtl { get; init; } = TimeSpan.FromHours(1);
}
