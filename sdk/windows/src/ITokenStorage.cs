// ITokenStorage.cs
// XID Windows SDK
// Status: implemented; compiled and unit-tested locally, real IdP round-trip pending
//
// token 持久化适配器接口。
// 默认实现 DpapiTokenStorage 使用 DPAPI + IsolatedStorage。
// 调用方可替换为自定义实现 (例如 Windows Hello 保护的凭据存储)。

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
/// 存储在安全介质中的 token 集合。
/// </summary>
public sealed class StoredTokenSet
{
    public required string AccessToken { get; init; }
    public string? RefreshToken { get; init; }
    public required string IdToken { get; init; }

    /// <summary>access token 过期时间 (UTC,ISO 8601)。</summary>
    public required DateTimeOffset ExpiresAt { get; init; }
}
