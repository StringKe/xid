// IBrowserSession.cs
// XID Windows SDK
//
// 浏览器授权会话抽象接口。
// 默认实现 WebView2BrowserSession (Windows 专属) 使用 WebView2 嵌入式浏览器。
// 可替换为系统浏览器实现(用于 CLI 或自定义 scheme 场景)。
// 此接口无任何 Windows 运行时依赖,跨平台可编译。

namespace Xid.Windows;

/// <summary>
/// 浏览器授权会话结果。
/// </summary>
public sealed class BrowserSessionResult
{
    /// <summary>OAuth authorization code。</summary>
    public required string Code { get; init; }

    /// <summary>回调中的 state 参数,与请求时一致。</summary>
    public required string State { get; init; }
}

/// <summary>
/// 浏览器授权会话适配器接口。
/// 实现打开浏览器引导用户完成 OAuth 授权,并将回调 URL 中的 code/state 返回给调用方。
/// </summary>
public interface IBrowserSession
{
    /// <summary>
    /// 启动授权会话,等待用户授权完成并返回结果。
    /// 实现负责打开浏览器(WebView2 / 系统浏览器等)并监听重定向回调。
    /// </summary>
    /// <param name="authorizeUrl">完整授权 URL (含 PKCE challenge / state / nonce)。</param>
    /// <param name="redirectUri">注册的 redirect URI,用于检测回调。</param>
    /// <param name="expectedState">期望的 state 值,实现须校验一致性。</param>
    /// <param name="ct">取消令牌。</param>
    /// <returns>包含 authorization code 的结果。</returns>
    /// <exception cref="CallbackException">回调包含 error 参数,或 state 不匹配。</exception>
    /// <exception cref="AuthorizationCanceledException">用户主动取消授权。</exception>
    Task<BrowserSessionResult> RunAsync(
        string authorizeUrl,
        string redirectUri,
        string expectedState,
        CancellationToken ct = default);
}
