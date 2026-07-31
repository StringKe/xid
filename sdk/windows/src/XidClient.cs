// XidClient.cs
// XID Windows SDK
//
// 公共 API 入口点。实现 Shared native contract:
//   Configure(options) / SignInAsync(options) / HandleRedirectAsync(url)
//   GetSession() / GetAccessToken(options) / SignOut() / SetTokenStorage(adapter)
//   SignInAnonymouslyAsync(options) -- Firebase 式 guest 登录(cookie 会话,无 token)
//
// 安全约束:
//   - public client:不存 client_secret。
//   - PKCE 强制 S256,不使用 plain。
//   - 不使用 implicit flow 或 password grant。
//   - token 通过 ITokenStorage 接口加密存储(默认 DPAPI + IsolatedStorage)。
//   - IBrowserSession 接口抽象浏览器操作,无直接 WinUI 3 依赖。

using System.Security.Cryptography;

namespace Xid.Windows;

// -- 选项类型 --

/// <summary>
/// SignInAsync() 选项。
/// </summary>
public sealed class SignInOptions
{
    /// <summary>
    /// 额外 scope 追加到配置的默认 scope 列表。
    /// </summary>
    public IReadOnlyList<string>? AdditionalScopes { get; init; }

    /// <summary>
    /// 传递给 /authorize 的额外查询参数,例如 login_hint。
    /// </summary>
    public IReadOnlyDictionary<string, string>? ExtraParams { get; init; }
}

/// <summary>
/// GetAccessToken() 选项。
/// </summary>
public sealed class GetAccessTokenOptions
{
    /// <summary>
    /// 当前 public client 不支持 DPoP refresh。
    /// 若为 true,清除本地 token 并要求调用方重新授权。
    /// </summary>
    public bool ForceRefresh { get; init; }
}

/// <summary>
/// SignInAnonymouslyAsync() 选项。
/// </summary>
public sealed class SignInAnonymouslyOptions
{
    /// <summary>
    /// Turnstile 验证 token。仅当服务端启用 Turnstile 时需要,native 端通常传 null。
    /// </summary>
    public string? TurnstileToken { get; init; }
}

// -- 主客户端 --

/// <summary>
/// XID Windows SDK 主客户端。
/// 通过 <see cref="Configure"/> 初始化,然后调用 <see cref="SignInAsync"/> 开始登录流程。
/// 线程安全:会话状态不包含可轮换的 refresh token。
/// </summary>
public sealed class XidClient
{
    /// <summary>进程内单例。大多数场景使用此实例即可。</summary>
    public static XidClient Shared { get; } = new();

    private XidConfiguration? _config;
    private HttpClient? _http;
    private OidcDiscovery? _discovery;
    private TokenEndpointClient? _tokenClient;
    private JwksCache? _jwksCache;
    private GuestAuthClient? _guestAuth;

    // 可覆盖的适配器(通过 Set* 方法更新)
    private ITokenStorage? _tokenStorageOverride;
    private IBrowserSession? _browserSessionOverride;

    // 当前有效会话(内存缓存)
    private XidSession? _session;

    // 进行中的 PKCE 参数(SignInAsync -> HandleRedirectAsync 跨步骤保持)
    private PkceParameters? _pendingPkce;
    private string? _pendingState;
    private string? _pendingNonce;

    private ITokenStorage ActiveStorage => _tokenStorageOverride ?? _config!.TokenStorage;
    private IBrowserSession? ActiveBrowser => _browserSessionOverride ?? _config!.BrowserSession;

    private XidClient() { }

    // -- Configure --

    /// <summary>
    /// 初始化 SDK。应用启动时调用一次。
    /// </summary>
    public void Configure(XidConfiguration options)
    {
        ArgumentNullException.ThrowIfNull(options);
        ValidatePublicClientScopes(options.Scopes);
        _config = options;
        _http = new HttpClient { Timeout = options.HttpTimeout };
        _discovery = new OidcDiscovery(_http, options.Issuer);
        _tokenClient = new TokenEndpointClient(_http, options.ClientId);
        var jwksUri = $"{options.Issuer.ToString().TrimEnd('/')}/jwks";
        _jwksCache = new JwksCache(jwksUri, options.JwksTtl, _http);
        // guest 流程必须读到 Set-Cookie 原文,不能被 handler 的 CookieContainer 吞掉
        _guestAuth = new GuestAuthClient(
            new HttpClient(new HttpClientHandler { UseCookies = false }) { Timeout = options.HttpTimeout },
            options.Issuer);
    }

    // -- SetTokenStorage --

    /// <summary>
    /// 替换 token 存储适配器。在 <see cref="Configure"/> 之后调用。
    /// </summary>
    public void SetTokenStorage(ITokenStorage storage)
    {
        ArgumentNullException.ThrowIfNull(storage);
        RequireConfigured();
        _tokenStorageOverride = storage;
    }

    /// <summary>
    /// 注入浏览器会话适配器。
    /// 非 Windows 平台必须在 <see cref="SignInAsync"/> 之前调用此方法注入实现。
    /// Windows 平台已有默认 <see cref="WebView2BrowserSession"/>。
    /// </summary>
    public void SetBrowserSession(IBrowserSession browserSession)
    {
        ArgumentNullException.ThrowIfNull(browserSession);
        RequireConfigured();
        _browserSessionOverride = browserSession;
    }

    // 测试注入点:替换 guest HTTP 客户端(mock HttpMessageHandler)。
    internal void SetGuestAuthClient(GuestAuthClient guestAuth)
    {
        ArgumentNullException.ThrowIfNull(guestAuth);
        RequireConfigured();
        _guestAuth = guestAuth;
    }

    // -- SignInAnonymouslyAsync --

    /// <summary>
    /// 匿名访客 (guest) 登录:先取一次性 guest capability,再 POST /auth/guest
    /// 建立 cookie 会话,最后用 /v1/me 取用户信息。
    /// Firebase 语义:本地已有有效会话(token 或 guest)时不发请求,直接返回现有会话。
    /// guest 不签发 access token,返回会话的 <see cref="XidSession.AccessToken"/> 为 null,
    /// 调用方用 <see cref="XidSession.SessionCookie"/> 访问 cookie 认证的 API。
    /// 转正(用户完成任一正式登录)后 sub 不变;若改登另一个既有账号,sub 会变。
    /// </summary>
    /// <param name="options">可选 Turnstile token。</param>
    /// <param name="ct">取消令牌。</param>
    /// <returns>当前(已有或新建的)会话。</returns>
    public async Task<XidSession> SignInAnonymouslyAsync(
        SignInAnonymouslyOptions? options = null,
        CancellationToken ct = default)
    {
        RequireConfigured();

        // 惰性:已有有效会话直接复用,不重复建号
        XidSession? existing = await GetSession(ct).ConfigureAwait(false);
        if (existing is not null)
            return existing;

        GuestAuthResult result = await _guestAuth!.SignInAnonymouslyAsync(
            options?.TurnstileToken, ct).ConfigureAwait(false);

        XidUser user = new(
            result.User.Id!,
            result.User.Email,
            result.User.EmailVerified,
            result.User.Name,
            result.User.ImageUrl,
            result.User.ProvisionedBy);

        var session = new XidSession(
            accessToken: null,
            refreshToken: null,
            idToken: null,
            expiresAt: null,
            user,
            result.SessionId,
            result.SessionCookie);

        try
        {
            await ActiveStorage.SaveAsync(SessionToStored(session), ct).ConfigureAwait(false);
        }
        catch (Exception saveError)
        {
            try
            {
                await ActiveStorage.ClearAsync(ct).ConfigureAwait(false);
            }
            catch (Exception cleanupError)
            {
                throw new AggregateException(
                    "guest 会话持久化失败且无法清理半截会话。",
                    saveError,
                    cleanupError);
            }
            throw;
        }
        _session = session;

        return session;
    }

    // -- SignInAsync --

    /// <summary>
    /// 发起授权流程。通过 <see cref="IBrowserSession"/> 打开授权界面,引导用户登录。
    /// 完成后会话自动保存,可通过 <see cref="GetSession"/> 获取。
    /// </summary>
    /// <param name="options">可选登录参数。</param>
    /// <param name="ct">取消令牌。</param>
    /// <returns>登录成功后的会话。</returns>
    public async Task<XidSession> SignInAsync(
        SignInOptions? options = null,
        CancellationToken ct = default)
    {
        RequireConfigured();
        ValidatePublicClientScopes(options?.AdditionalScopes ?? []);
        RequireBrowserSession();

        OidcDiscoveryDocument doc = await _discovery!.GetAsync(ct).ConfigureAwait(false);

        PkceParameters pkce = PkceParameters.Generate();
        string state = GenerateState();
        string nonce = GenerateNonce();

        // 保存,供 HandleRedirectAsync 使用
        _pendingPkce = pkce;
        _pendingState = state;
        _pendingNonce = nonce;

        string authorizeUrl = BuildAuthorizeUrl(doc.AuthorizationEndpoint, pkce, state, nonce, options);

        BrowserSessionResult result = await ActiveBrowser!.RunAsync(
            authorizeUrl,
            _config!.RedirectUri,
            state,
            ct).ConfigureAwait(false);

        // 授权码换 token
        XidSession session = await ExchangeCodeAsync(doc, result.Code, pkce, ct).ConfigureAwait(false);

        ClearPendingAuth();

        _session = session;
        await ActiveStorage.SaveAsync(SessionToStored(session), ct).ConfigureAwait(false);

        return session;
    }

    // -- HandleRedirectAsync --

    /// <summary>
    /// 处理自定义 URI scheme 或 loopback 回调 URL。
    /// 适用于不使用 IBrowserSession 弹窗、而是注册自定义 scheme 拦截的场景。
    /// 在应用的 URI 激活回调中调用此方法。
    /// </summary>
    /// <param name="callbackUrl">完整回调 URL,包含 code 和 state 参数。</param>
    /// <param name="ct">取消令牌。</param>
    /// <returns>登录成功后的会话。</returns>
    public async Task<XidSession> HandleRedirectAsync(Uri callbackUrl, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(callbackUrl);
        RequireConfigured();

        if (_pendingPkce is null || _pendingState is null)
            throw new XidException(
                "没有待处理的授权请求,请先调用 SignInAsync 发起授权。",
                "no_pending_auth");

        // 解析回调参数
        string? code = GetQueryParam(callbackUrl, "code");
        string? state = GetQueryParam(callbackUrl, "state");
        string? error = GetQueryParam(callbackUrl, "error");

        if (error is not null)
            throw new CallbackException(
                GetQueryParam(callbackUrl, "error_description") ?? error, error);

        if (string.IsNullOrWhiteSpace(code))
            throw new CallbackException("回调 URL 缺少 code 参数。");

        if (state != _pendingState)
            throw new CallbackException("回调 state 不匹配,可能存在 CSRF 攻击。");

        OidcDiscoveryDocument doc = await _discovery!.GetAsync(ct).ConfigureAwait(false);
        XidSession session = await ExchangeCodeAsync(
            doc, code, _pendingPkce, ct).ConfigureAwait(false);

        ClearPendingAuth();

        _session = session;
        await ActiveStorage.SaveAsync(SessionToStored(session), ct).ConfigureAwait(false);

        return session;
    }

    // -- GetSession --

    /// <summary>
    /// 获取当前有效会话。
    /// 内存缓存无效时从持久存储恢复;access token 过期后清除并要求重新授权。
    /// </summary>
    /// <param name="ct">取消令牌。</param>
    /// <returns>有效会话,或 null(未登录)。</returns>
    public async Task<XidSession?> GetSession(CancellationToken ct = default)
    {
        RequireConfigured();

        // 1. 优先内存缓存
        if (_session is not null && !_session.IsExpired)
            return _session;

        // 2. 尝试从持久存储恢复
        if (_session is null)
        {
            StoredTokenSet? stored = await ActiveStorage.LoadAsync(ct).ConfigureAwait(false);
            if (stored is null) return null;

            _session = StoredToSession(stored);
            // 记录损坏(既非 token 会话也非 guest 会话)视为未登录
            if (_session is null) return null;
        }

        // 3. 当前 SDK 尚未实现 DPoP refresh,过期 token 不可继续使用
        if (_session.IsExpired)
        {
            _session = null;
            await ActiveStorage.ClearAsync(ct).ConfigureAwait(false);
            return null;
        }

        return _session;
    }

    // -- GetAccessToken --

    /// <summary>
    /// 获取有效的 access token 字符串。
    /// </summary>
    /// <param name="options">可选强制刷新选项。</param>
    /// <param name="ct">取消令牌。</param>
    /// <returns>access token,或 null(未登录)。</returns>
    public async Task<string?> GetAccessToken(
        GetAccessTokenOptions? options = null,
        CancellationToken ct = default)
    {
        RequireConfigured();

        XidSession? session = await GetSession(ct).ConfigureAwait(false);
        if (session is null) return null;

        if (options?.ForceRefresh == true && session.AccessToken is not null)
        {
            _session = null;
            await ActiveStorage.ClearAsync(ct).ConfigureAwait(false);
            throw new XidException(
                "当前 Windows SDK 尚未实现 DPoP refresh,请重新授权。",
                "reauthorization_required");
        }

        return session?.AccessToken;
    }

    // -- SignOut --

    /// <summary>
    /// 登出:可选调用 /end_session,然后清除本地 token。
    /// </summary>
    /// <param name="callEndSession">是否 POST /end_session(RP-initiated logout)。</param>
    /// <param name="ct">取消令牌。</param>
    public async Task SignOut(bool callEndSession = false, CancellationToken ct = default)
    {
        RequireConfigured();

        if (callEndSession)
        {
            StoredTokenSet? stored = _session is not null
                ? SessionToStored(_session)
                : await ActiveStorage.LoadAsync(ct).ConfigureAwait(false);

            if (!string.IsNullOrEmpty(stored?.IdToken))
            {
                try
                {
                    OidcDiscoveryDocument doc = await _discovery!.GetAsync(ct).ConfigureAwait(false);
                    if (!string.IsNullOrEmpty(doc.EndSessionEndpoint))
                    {
                        await EndSessionClient.EndSessionAsync(
                            _http!,
                            new Uri(doc.EndSessionEndpoint),
                            stored.IdToken,
                            _config!.PostLogoutRedirectUri,
                            ct).ConfigureAwait(false);
                    }
                }
                catch (XidException)
                {
                    // best-effort:本地登出仍继续
                }
            }
        }

        _session = null;
        ClearPendingAuth();
        await ActiveStorage.ClearAsync(ct).ConfigureAwait(false);
    }

    // -- 内部:构造 authorize URL --

    private string BuildAuthorizeUrl(
        string authorizationEndpoint,
        PkceParameters pkce,
        string state,
        string nonce,
        SignInOptions? options)
    {
        var scopes = new List<string>(_config!.Scopes);
        if (options?.AdditionalScopes is not null)
            scopes.AddRange(options.AdditionalScopes);

        // 手动构造查询字符串,避免引入 System.Web 依赖
        var query = new List<(string, string)>
        {
            ("response_type", "code"),
            ("client_id", _config.ClientId),
            ("redirect_uri", _config.RedirectUri),
            ("scope", string.Join(" ", scopes)),
            ("state", state),
            ("code_challenge", pkce.Challenge),
            ("code_challenge_method", pkce.Method),
            ("nonce", nonce),
        };

        if (options?.ExtraParams is not null)
        {
            var reservedParameters = new HashSet<string>(StringComparer.Ordinal)
            {
                "response_type",
                "client_id",
                "redirect_uri",
                "scope",
                "state",
                "nonce",
                "code_challenge",
                "code_challenge_method",
            };
            foreach (var kv in options.ExtraParams)
            {
                if (!reservedParameters.Contains(kv.Key))
                    query.Add((kv.Key, kv.Value));
            }
        }

        var sb = new System.Text.StringBuilder(authorizationEndpoint);
        sb.Append('?');
        for (int i = 0; i < query.Count; i++)
        {
            if (i > 0) sb.Append('&');
            sb.Append(Uri.EscapeDataString(query[i].Item1));
            sb.Append('=');
            sb.Append(Uri.EscapeDataString(query[i].Item2));
        }
        return sb.ToString();
    }

    // -- 内部:token 交换 --

    private async Task<XidSession> ExchangeCodeAsync(
        OidcDiscoveryDocument doc,
        string code,
        PkceParameters pkce,
        CancellationToken ct)
    {
        TokenResponse tokenResp = await _tokenClient!.ExchangeCodeAsync(
            new Uri(doc.TokenEndpoint),
            code,
            _config!.RedirectUri,
            pkce.Verifier,
            ct).ConfigureAwait(false);

        return await BuildSessionAsync(doc, tokenResp, _pendingNonce, ct).ConfigureAwait(false);
    }

    // -- 内部:会话构建与转换 --

    private async Task<XidSession> BuildSessionAsync(
        OidcDiscoveryDocument doc,
        TokenResponse tokenResp,
        string? expectedNonce,
        CancellationToken ct)
    {
        string idToken = tokenResp.IdToken
            ?? throw new TokenExchangeException("token 响应缺少 id_token。");

        IdTokenClaims claims = await IdTokenVerifier.VerifyAsync(
            idToken,
            _jwksCache!,
            doc.Issuer,
            _config!.ClientId,
            expectedNonce,
            ct).ConfigureAwait(false);

        DateTimeOffset expiresAt = DateTimeOffset.UtcNow.AddSeconds(tokenResp.ExpiresIn);

        XidUser user = new(
            claims.Sub,
            claims.Email,
            claims.EmailVerified,
            claims.Name,
            claims.Picture);

        return new XidSession(
            tokenResp.AccessToken,
            refreshToken: null,
            idToken,
            expiresAt,
            user);
    }

    private void ClearPendingAuth()
    {
        _pendingPkce = null;
        _pendingState = null;
        _pendingNonce = null;
    }

    private static StoredTokenSet SessionToStored(XidSession s) => new()
    {
        AccessToken = s.AccessToken,
        RefreshToken = null,
        IdToken = s.IdToken,
        ExpiresAt = s.ExpiresAt,
        Guest = s.SessionId is null || s.SessionCookie is null
            ? null
            : new StoredGuestSession
            {
                SessionId = s.SessionId,
                SessionCookie = s.SessionCookie,
                Sub = s.User.Sub,
                Email = s.User.Email,
                Name = s.User.Name,
                Picture = s.User.Picture,
                ProvisionedBy = s.User.ProvisionedBy,
            },
    };

    private XidSession? StoredToSession(StoredTokenSet stored)
    {
        // guest 会话:凭证是 cookie,无 id token 可解码
        if (stored.Guest is not null)
        {
            XidUser guestUser = new(
                stored.Guest.Sub,
                stored.Guest.Email,
                emailVerified: null,
                stored.Guest.Name,
                stored.Guest.Picture,
                stored.Guest.ProvisionedBy);
            return new XidSession(
                accessToken: null,
                refreshToken: null,
                idToken: null,
                expiresAt: null,
                guestUser,
                stored.Guest.SessionId,
                stored.Guest.SessionCookie);
        }

        if (stored.IdToken is null)
            return null;

        // 恢复会话时仅解码 claims(签名已在首次登录时验证)
        IdTokenClaims claims = IdTokenDecoder.Decode(stored.IdToken);
        XidUser user = new(
            claims.Sub,
            claims.Email,
            claims.EmailVerified,
            claims.Name,
            claims.Picture);

        return new XidSession(
            stored.AccessToken,
            refreshToken: null,
            stored.IdToken,
            stored.ExpiresAt,
            user);
    }

    // -- 工具方法 --

    private void RequireConfigured()
    {
        if (_config is null) throw new XidNotConfiguredException();
    }

    private void RequireBrowserSession()
    {
        if (ActiveBrowser is null)
            throw new XidException(
                "未配置 IBrowserSession 实现。非 Windows 平台请调用 SetBrowserSession() 注入实现。",
                "no_browser_session");
    }

    private static void ValidatePublicClientScopes(IEnumerable<string> scopes)
    {
        if (scopes.Contains("offline_access", StringComparer.Ordinal))
        {
            throw new XidException(
                "offline_access 需要 DPoP,当前 Windows SDK 尚未实现 DPoP。",
                "unsupported_scope");
        }
    }

    private static string GenerateState()
    {
        byte[] bytes = RandomNumberGenerator.GetBytes(16);
        return Convert.ToBase64String(bytes)
            .Replace('+', '-').Replace('/', '_').TrimEnd('=');
    }

    private static string GenerateNonce()
    {
        byte[] bytes = RandomNumberGenerator.GetBytes(16);
        return Convert.ToBase64String(bytes)
            .Replace('+', '-').Replace('/', '_').TrimEnd('=');
    }

    private static string? GetQueryParam(Uri uri, string key)
    {
        string query = uri.Query.TrimStart('?');
        foreach (string part in query.Split('&'))
        {
            int eq = part.IndexOf('=');
            if (eq < 0) continue;
            string k = Uri.UnescapeDataString(part[..eq]);
            string v = Uri.UnescapeDataString(part[(eq + 1)..]);
            if (k == key) return v;
        }
        return null;
    }
}
