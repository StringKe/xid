// XidSession.cs
// XID Windows SDK
// Status: implemented; compiled and unit-tested locally, real IdP round-trip pending
//
// 用户会话快照和用户信息结构。

namespace Xid.Windows;

/// <summary>
/// 用户会话快照。通过 XidClient.GetSession() 获取。
/// </summary>
public sealed class XidSession
{
    /// <summary>access token (JWT)。生命周期通常 1 小时。</summary>
    public string AccessToken { get; }

    /// <summary>
    /// refresh token。生命周期由服务端配置,默认 7 天绝对 / 30 天空闲。
    /// XID 服务端执行轮换:每次刷新发新 token 并作废旧 token。
    /// </summary>
    public string? RefreshToken { get; }

    /// <summary>id token (JWT)。包含用户身份声明。</summary>
    public string IdToken { get; }

    /// <summary>access token 过期时间 (UTC)。</summary>
    public DateTimeOffset ExpiresAt { get; }

    /// <summary>从 id token claims 解码的用户基础信息。</summary>
    public XidUser User { get; }

    /// <summary>access token 是否已过期。</summary>
    public bool IsExpired => DateTimeOffset.UtcNow >= ExpiresAt;

    /// <summary>access token 是否即将过期 (距过期不足 60 秒视为即将过期)。</summary>
    public bool IsNearExpiry => DateTimeOffset.UtcNow >= ExpiresAt.AddSeconds(-60);

    internal XidSession(
        string accessToken,
        string? refreshToken,
        string idToken,
        DateTimeOffset expiresAt,
        XidUser user)
    {
        AccessToken = accessToken;
        RefreshToken = refreshToken;
        IdToken = idToken;
        ExpiresAt = expiresAt;
        User = user;
    }
}

/// <summary>
/// 从 id token claims 解码的用户基础信息。
/// </summary>
public sealed class XidUser
{
    /// <summary>用户主体标识符 (subject claim)。</summary>
    public string Sub { get; }

    public string? Email { get; }
    public bool? EmailVerified { get; }
    public string? Name { get; }

    /// <summary>头像 URL。</summary>
    public string? Picture { get; }

    internal XidUser(
        string sub,
        string? email,
        bool? emailVerified,
        string? name,
        string? picture)
    {
        Sub = sub;
        Email = email;
        EmailVerified = emailVerified;
        Name = name;
        Picture = picture;
    }
}
