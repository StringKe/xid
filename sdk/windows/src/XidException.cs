// XidException.cs
// XID Windows SDK
// Status: implemented; compiled and unit-tested locally, real IdP round-trip pending
//
// SDK 异常层次结构。所有 SDK 错误继承 XidException,
// 调用方可统一 catch 基类,也可按子类细分处理。

namespace Xid.Windows;

/// <summary>
/// 所有 XID Windows SDK 错误的基类。
/// </summary>
public class XidException : Exception
{
    /// <summary>机器可读的错误码,与 XidAPIError.code 格式对齐。</summary>
    public string Code { get; }

    public XidException(string message, string code = "xid_error", Exception? inner = null)
        : base(message, inner)
    {
        Code = code;
    }
}

/// <summary>
/// SDK 未经 configure() 初始化即调用时抛出。
/// </summary>
public sealed class XidNotConfiguredException : XidException
{
    public XidNotConfiguredException()
        : base("Xid SDK 未初始化,请先调用 XidClient.Configure()。", "not_configured") { }
}

/// <summary>
/// PKCE code_verifier / code_challenge 生成失败。
/// 通常由 RandomNumberGenerator 不可用引起。
/// </summary>
public sealed class PkceGenerationException : XidException
{
    public PkceGenerationException(string message, Exception? inner = null)
        : base(message, "pkce_generation_failed", inner) { }
}

/// <summary>
/// OIDC Discovery 文档拉取或解析失败。
/// </summary>
public sealed class DiscoveryException : XidException
{
    public DiscoveryException(string message, Exception? inner = null)
        : base(message, "discovery_failed", inner) { }
}

/// <summary>
/// /token 端点调用失败或返回错误响应。
/// </summary>
public sealed class TokenExchangeException : XidException
{
    /// <summary>OAuth 错误码,例如 "invalid_grant"。</summary>
    public string? OAuthError { get; }

    public TokenExchangeException(string message, string? oauthError = null, Exception? inner = null)
        : base(message, "token_exchange_failed", inner)
    {
        OAuthError = oauthError;
    }
}

/// <summary>
/// 安全存储(DPAPI / IsolatedStorage)读写失败。
/// </summary>
public sealed class TokenStorageException : XidException
{
    public TokenStorageException(string message, Exception? inner = null)
        : base(message, "token_storage_failed", inner) { }
}

/// <summary>
/// WebView2 授权窗口被用户关闭或重定向未发生。
/// </summary>
public sealed class AuthorizationCanceledException : XidException
{
    public AuthorizationCanceledException()
        : base("用户取消了授权操作。", "authorization_canceled") { }
}

/// <summary>
/// 回调 URL 解析失败:缺少 code 参数,或包含 error 参数。
/// </summary>
public sealed class CallbackException : XidException
{
    /// <summary>OAuth 错误码,来自回调 URL 的 error 参数。</summary>
    public string? OAuthError { get; }

    public CallbackException(string message, string? oauthError = null, Exception? inner = null)
        : base(message, "callback_error", inner)
    {
        OAuthError = oauthError;
    }
}

/// <summary>JWKS 拉取或解析失败。</summary>
public sealed class JwksException : XidException
{
    public JwksException(string message, Exception? inner = null)
        : base(message, "jwks_error", inner) { }
}

/// <summary>id token 签名或 claims 验证失败。</summary>
public sealed class TokenVerificationException : XidException
{
    public TokenVerificationException(string message, Exception? inner = null)
        : base(message, "token_verification_error", inner) { }
}
