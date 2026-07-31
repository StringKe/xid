// XidSession.cs
// XID Windows SDK
// Status: implemented; compiled and unit-tested locally, real IdP round-trip pending
//
// 用户会话快照和用户信息结构。
// 会话有两种形态:
//   - OIDC 会话:access token / id token;access token 过期后需重新授权。
//   - guest(匿名访客)会话:无 token,凭证是 cookie 会话(SessionId + SessionCookie)。

namespace Xid.Windows;

/// <summary>
/// 用户会话快照。通过 XidClient.GetSession() 获取。
/// </summary>
public sealed class XidSession
{
    /// <summary>
    /// access token (JWT)。生命周期通常 1 小时。
    /// guest 会话不签发 access token,为 null。
    /// </summary>
    public string? AccessToken { get; }

    /// <summary>
    /// 保留字段。当前 SDK 未实现 DPoP,public client 会话始终为 null。
    /// </summary>
    public string? RefreshToken { get; }

    /// <summary>
    /// id token (JWT)。包含用户身份声明。
    /// guest 会话不签发 id token,为 null。
    /// </summary>
    public string? IdToken { get; }

    /// <summary>
    /// access token 过期时间 (UTC)。
    /// guest 会话有效期由服务端 cookie 会话决定,客户端不可知,为 null。
    /// </summary>
    public DateTimeOffset? ExpiresAt { get; }

    /// <summary>从 id token claims 或 /v1/me 解码的用户基础信息。</summary>
    public XidUser User { get; }

    /// <summary>
    /// guest 会话 ID(POST /auth/guest 签发)。OIDC 会话为 null。
    /// </summary>
    public string? SessionId { get; }

    /// <summary>
    /// guest 会话 cookie(__Host-xid.rt.*,name=value 形式)。
    /// 原生端调用 {issuer} 下的 cookie 认证 API(如 /v1/me)时作为 Cookie 头发送。
    /// OIDC 会话为 null。
    /// </summary>
    public string? SessionCookie { get; }

    /// <summary>当前会话是否为匿名访客 (guest)。</summary>
    public bool IsAnonymous => User.IsAnonymous;

    /// <summary>access token 是否已过期。guest 会话恒为 false(有效期由服务端判定)。</summary>
    public bool IsExpired => ExpiresAt is not null && DateTimeOffset.UtcNow >= ExpiresAt.Value;

    /// <summary>access token 是否即将过期 (距过期不足 60 秒视为即将过期)。guest 会话恒为 false。</summary>
    public bool IsNearExpiry =>
        ExpiresAt is not null && DateTimeOffset.UtcNow >= ExpiresAt.Value.AddSeconds(-60);

    internal XidSession(
        string? accessToken,
        string? refreshToken,
        string? idToken,
        DateTimeOffset? expiresAt,
        XidUser user,
        string? sessionId = null,
        string? sessionCookie = null)
    {
        AccessToken = accessToken;
        RefreshToken = refreshToken;
        IdToken = idToken;
        ExpiresAt = expiresAt;
        User = user;
        SessionId = sessionId;
        SessionCookie = sessionCookie;
    }
}

/// <summary>
/// 从 id token claims 或 /v1/me 解码的用户基础信息。
/// </summary>
public sealed class XidUser
{
    /// <summary>用户主体标识符 (subject claim / user id)。guest 转正后 sub 不变。</summary>
    public string Sub { get; }

    public string? Email { get; }
    public bool? EmailVerified { get; }
    public string? Name { get; }

    /// <summary>头像 URL。</summary>
    public string? Picture { get; }

    /// <summary>
    /// 账号开通来源(/v1/me 的 provisioned_by 字段)。
    /// 'anonymous' 表示匿名访客;OIDC id token 不携带此字段,为 null。
    /// </summary>
    public string? ProvisionedBy { get; }

    /// <summary>是否为匿名访客 (provisioned_by == 'anonymous')。</summary>
    public bool IsAnonymous => ProvisionedBy == "anonymous";

    internal XidUser(
        string sub,
        string? email,
        bool? emailVerified,
        string? name,
        string? picture,
        string? provisionedBy = null)
    {
        Sub = sub;
        Email = email;
        EmailVerified = emailVerified;
        Name = name;
        Picture = picture;
        ProvisionedBy = provisionedBy;
    }
}
