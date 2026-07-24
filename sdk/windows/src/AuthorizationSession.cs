// AuthorizationSession.cs
// XID Windows SDK
//
// WebView2 授权会话 -- IBrowserSession 的 Windows 默认实现。
//
// 流程:
//   1. 构造 /authorize URL (含 PKCE code_challenge、state、nonce)。
//   2. 弹出 WebView2 窗口,导航至授权 URL。
//   3. 监听 NavigationStarting 事件,检测回调 URL 匹配 redirectUri。
//   4. 从回调 URL 提取 authorization code 并校验 state。
//
// Windows 专属 API (WinUI 3 Window / WebView2 / CoreWebView2) 全部限定在
// WINDOWS 编译条件内,非 Windows 目标只看到接口定义,不引入任何 WinUI 依赖。

#if WINDOWS
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using System.Web;
#endif

using System.Security.Cryptography;

namespace Xid.Windows;

#if WINDOWS

/// <summary>
/// 基于 WebView2 的授权会话。Windows 默认实现,适用于嵌入式 Hosted Auth 场景。
/// </summary>
public sealed class WebView2BrowserSession : IBrowserSession
{
    private readonly string _windowTitle;

    /// <param name="windowTitle">弹出授权窗口的标题,默认 "Sign in"。</param>
    public WebView2BrowserSession(string windowTitle = "Sign in")
    {
        _windowTitle = windowTitle;
    }

    /// <inheritdoc/>
    public Task<BrowserSessionResult> RunAsync(
        string authorizeUrl,
        string redirectUri,
        string expectedState,
        CancellationToken ct = default)
    {
        var tcs = new TaskCompletionSource<BrowserSessionResult>();

        // WinUI 3 UI 组件必须在 UI 线程创建
        var window = new Window { Title = _windowTitle };
        var webView = new WebView2();
        window.Content = webView;

        webView.NavigationStarting += (_, args) =>
        {
            string navUrl = args.Uri;
            if (!navUrl.StartsWith(redirectUri, StringComparison.OrdinalIgnoreCase))
                return;

            // 拦截回调,阻止 WebView2 继续导航
            args.Cancel = true;
            window.Close();

            try
            {
                BrowserSessionResult result = ParseCallbackUrl(navUrl, expectedState);
                tcs.TrySetResult(result);
            }
            catch (CallbackException ex)
            {
                tcs.TrySetException(ex);
            }
        };

        window.Closed += (_, _) =>
        {
            // 窗口关闭但 tcs 未完成 -> 用户取消
            tcs.TrySetException(new AuthorizationCanceledException());
        };

        ct.Register(() => tcs.TrySetCanceled(ct));

        // 异步初始化 WebView2 并导航
        _ = InitAndNavigateAsync(webView, authorizeUrl);

        window.Activate();
        return tcs.Task;
    }

    private static BrowserSessionResult ParseCallbackUrl(string callbackUrl, string expectedState)
    {
        Uri uri;
        try { uri = new Uri(callbackUrl); }
        catch (UriFormatException ex)
        {
            throw new CallbackException("回调 URL 格式非法。", inner: ex);
        }

        var qs = HttpUtility.ParseQueryString(uri.Query);

        string? error = qs["error"];
        if (error is not null)
        {
            string? desc = qs["error_description"];
            throw new CallbackException(desc ?? error, error);
        }

        string? code = qs["code"];
        if (string.IsNullOrWhiteSpace(code))
            throw new CallbackException("回调 URL 缺少 code 参数。");

        string? state = qs["state"];
        if (state != expectedState)
            throw new CallbackException("回调 state 不匹配,可能存在 CSRF 攻击。");

        return new BrowserSessionResult { Code = code, State = state };
    }

    private static async Task InitAndNavigateAsync(WebView2 webView, string url)
    {
        await webView.EnsureCoreWebView2Async();
        webView.CoreWebView2.Navigate(url);
    }
}

#endif
