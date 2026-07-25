// XID SDK 数据模型
//
// 所有模型设计为不可变(readonly record struct 或 sealed record),
// 一旦验证通过即冻结,调用方不得修改。

using System.Collections.Frozen;

namespace Xid;

/// <summary>
/// 验证通过的 access token claims 快照。
/// 字段命名与 OIDC/JWT 规范保持一致。
/// 未映射到具名字段的自定义 claims 收进 Extra。
/// </summary>
public sealed record TokenClaims
{
    // ---- 标准 JWT claims ----
    /// <summary>Subject -- 用户唯一标识符。</summary>
    public required string Sub { get; init; }

    /// <summary>Issuer -- token 签发方,须与配置的 Issuer 精确一致。</summary>
    public required string Iss { get; init; }

    /// <summary>Audience -- token 受众。可为单值或多值列表。</summary>
    public required IReadOnlyList<string> Aud { get; init; }

    /// <summary>Expiration time (Unix 秒)。</summary>
    public required long Exp { get; init; }

    /// <summary>Issued at (Unix 秒)。</summary>
    public required long Iat { get; init; }

    /// <summary>JWT ID -- 防重放唯一标识,可为 null。</summary>
    public string? Jti { get; init; }

    /// <summary>Not before (Unix 秒),可为 null。</summary>
    public long? Nbf { get; init; }

    // ---- token 类型相关 ----
    /// <summary>OAuth scope 字符串,空格分隔。</summary>
    public string? Scope { get; init; }

    /// <summary>颁发此 token 的 OAuth client_id。</summary>
    public string? ClientId { get; init; }

    // ---- 身份相关 ----
    public string? Email { get; init; }
    public bool? EmailVerified { get; init; }
    public string? Name { get; init; }

    /// <summary>未映射到具名字段的额外 claims。值类型为 object?。</summary>
    public FrozenDictionary<string, object?> Extra { get; init; } =
        FrozenDictionary<string, object?>.Empty;

    /// <summary>
    /// 从 System.IdentityModel.Tokens.Jwt 解出的 ClaimsIdentity 字典构造 TokenClaims。
    /// 内部使用,调用方不应直接调用。
    /// </summary>
    internal static TokenClaims FromPayload(IDictionary<string, object?> payload)
    {
        static string Req(IDictionary<string, object?> d, string key) =>
            d.TryGetValue(key, out var v) && v is string s && s.Length > 0
                ? s
                : throw new TokenVerificationException($"Required claim '{key}' missing or empty.");

        static long ReqLong(IDictionary<string, object?> d, string key) =>
            d.TryGetValue(key, out var v)
                ? v switch
                {
                    long l => l,
                    int i => (long)i,
                    string s when long.TryParse(s, out var parsed) => parsed,
                    _ => throw new TokenVerificationException($"Claim '{key}' has unexpected type.")
                }
                : throw new TokenVerificationException($"Required claim '{key}' missing.");

        // aud 可以是单字符串也可以是 string[]
        IReadOnlyList<string> aud = payload.TryGetValue("aud", out var audRaw)
            ? audRaw switch
            {
                string s => new[] { s },
                IEnumerable<object> list => list.Select(x => x?.ToString() ?? "").ToArray(),
                _ => Array.Empty<string>()
            }
            : Array.Empty<string>();

        var knownKeys = new HashSet<string>(StringComparer.Ordinal)
        {
            "sub", "iss", "aud", "exp", "iat", "jti", "nbf",
            "scope", "client_id", "email", "email_verified", "name"
        };

        var extra = payload
            .Where(kv => !knownKeys.Contains(kv.Key))
            .ToFrozenDictionary(kv => kv.Key, kv => kv.Value);

        return new TokenClaims
        {
            Sub = Req(payload, "sub"),
            Iss = Req(payload, "iss"),
            Aud = aud,
            Exp = ReqLong(payload, "exp"),
            Iat = ReqLong(payload, "iat"),
            Jti = payload.TryGetValue("jti", out var jti) ? jti?.ToString() : null,
            Nbf = payload.TryGetValue("nbf", out var nbf) ? nbf switch
            {
                long l => l,
                int i => (long)i,
                string s when long.TryParse(s, out var p) => p,
                _ => null
            } : null,
            Scope = payload.TryGetValue("scope", out var sc) ? sc?.ToString() : null,
            ClientId = payload.TryGetValue("client_id", out var cid) ? cid?.ToString() : null,
            Email = payload.TryGetValue("email", out var em) ? em?.ToString() : null,
            EmailVerified = payload.TryGetValue("email_verified", out var ev) ? ev switch
            {
                bool b => b,
                string s => s.Equals("true", StringComparison.OrdinalIgnoreCase),
                _ => null
            } : null,
            Name = payload.TryGetValue("name", out var nm) ? nm?.ToString() : null,
            Extra = extra,
        };
    }
}

/// <summary>
/// AuthenticateRequest 的返回值。
/// Authenticated=true 时 Claims 有值;false 时 Reason 说明原因。
/// </summary>
public sealed record AuthStatus
{
    public bool Authenticated { get; init; }
    public TokenClaims? Claims { get; init; }
    public string? Reason { get; init; }

    /// <summary>认证成功。</summary>
    public static AuthStatus Ok(TokenClaims claims) =>
        new() { Authenticated = true, Claims = claims };

    /// <summary>认证失败,附原因说明。</summary>
    public static AuthStatus Fail(string reason) =>
        new() { Authenticated = false, Reason = reason };
}

/// <summary>
/// VerifyWebhook 通过后的信息摘要。
/// RawBody 是未解析的原始字节,调用方自行反序列化。
/// </summary>
public sealed record WebhookPayload
{
    /// <summary>svix-id 头的值 -- 事件唯一标识。</summary>
    public required string SvixId { get; init; }

    /// <summary>svix-timestamp 的 Unix 秒时间戳。</summary>
    public required long Timestamp { get; init; }

    /// <summary>通过签名验证的原始请求体字节。</summary>
    public required ReadOnlyMemory<byte> RawBody { get; init; }
}
