// XID SDK 异常层次结构
//
// 所有 SDK 错误继承 XidException,调用方可统一 catch 基类,
// 也可按子类细分处理。

namespace Xid;

/// <summary>
/// 所有 XID SDK 错误的基类。
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
/// JWKS 拉取或解析失败。
/// 典型原因:网络不可达、JWKS endpoint 返回非 2xx、JSON 格式非法。
/// </summary>
public sealed class JwksException : XidException
{
    public JwksException(string message, Exception? inner = null)
        : base(message, "jwks_error", inner) { }
}

/// <summary>
/// JWT 验证失败。
/// 涵盖:签名不合法、claims 不符(iss/aud/exp)、token 过期、kid 不存在等。
/// </summary>
public sealed class TokenVerificationException : XidException
{
    public TokenVerificationException(string message, Exception? inner = null)
        : base(message, "token_verification_error", inner) { }
}

/// <summary>
/// Webhook 签名验证失败或时间窗超限(重放防护触发)。
/// </summary>
public sealed class WebhookVerificationException : XidException
{
    public WebhookVerificationException(string message, Exception? inner = null)
        : base(message, "webhook_verification_error", inner) { }
}
