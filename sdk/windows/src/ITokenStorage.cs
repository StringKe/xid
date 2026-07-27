// ITokenStorage.cs
// XID Windows SDK
// Status: implemented; compiled and unit-tested locally, real IdP round-trip pending
//
// token 持久化适配器接口。
// 默认实现 DpapiTokenStorage 使用 DPAPI + IsolatedStorage。
// 调用方可替换为自定义实现 (例如 Windows Hello 保护的凭据存储)。
//
// 同一份存储记录也承载 guest(匿名访客)会话:guest 无 token,
// 凭证是 cookie 会话,因此 token 字段可空、Guest 字段承载 cookie 凭证。

namespace Xid.Windows;

/// <summary>
/// token 持久化适配器接口。
/// 实现必须保证线程安全。
/// </summary>
public interface ITokenStorage
{
    /// <summary>保存会话 token。</summary>
    Task SaveAsync(StoredTokenSet tokens, CancellationToken ct = default);

    /// <summary>读取会话 token,不存在时返回 null。</summary>
    Task<StoredTokenSet?> LoadAsync(CancellationToken ct = default);

    /// <summary>删除所有已存储的 token (登出时调用)。</summary>
    Task ClearAsync(CancellationToken ct = default);
}

/// <summary>
/// 存储在安全介质中的会话凭证集合。
/// OIDC 会话填 token 字段、Guest 为 null;guest 会话填 Guest、token 字段为 null。
/// </summary>
public sealed class StoredTokenSet
{
    /// <summary>access token (JWT)。guest 会话为 null。</summary>
    public string? AccessToken { get; init; }
    public string? RefreshToken { get; init; }

    /// <summary>id token (JWT)。guest 会话为 null。</summary>
    public string? IdToken { get; init; }

    /// <summary>access token 过期时间 (UTC,ISO 8601)。guest 会话为 null。</summary>
    public DateTimeOffset? ExpiresAt { get; init; }

    /// <summary>guest(匿名访客)会话凭证。OIDC 会话为 null。</summary>
    public StoredGuestSession? Guest { get; init; }
}

/// <summary>
/// guest(匿名访客)会话的持久化凭证。
/// </summary>
public sealed class StoredGuestSession
{
    /// <summary>POST /auth/guest 签发的会话 ID。</summary>
    public required string SessionId { get; init; }

    /// <summary>__Host-xid.rt.* 会话 cookie (name=value 形式)。</summary>
    public required string SessionCookie { get; init; }

    public required string Sub { get; init; }
    public string? Email { get; init; }
    public string? Name { get; init; }
    public string? Picture { get; init; }

    /// <summary>/v1/me 的 provisioned_by 字段;'anonymous' 表示 guest。</summary>
    public string? ProvisionedBy { get; init; }
}
