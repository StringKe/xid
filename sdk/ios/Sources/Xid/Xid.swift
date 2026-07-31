// Xid.swift
// XID iOS Swift SDK
// Status: implemented; compiled and unit-tested locally, real IdP round-trip pending
//
// 主入口。提供 configure / signIn / signInAnonymously / handleRedirect / getSession /
// getAccessToken / signOut / setTokenStorage 接口,对齐平台矩阵
// Shared native contract。

import AuthenticationServices
import Foundation

// MARK: - Xid 主类

/// XID SDK 主类。使用 Xid.shared 单例访问。
/// 所有公开方法均线程安全(actor-isolated 内部状态)。
public final class Xid: @unchecked Sendable {
    // MARK: - 单例

    public static let shared = Xid()
    init() {}

    // MARK: - 内部状态(由 stateLock 保护)

    private let stateLock = NSLock()
    private var _config: XidConfiguration?
    private var _discoveryLoader: OIDCDiscoveryLoader?
    private let userInfoClient = UserInfoClient()
    private let endSessionClient = EndSessionClient()

    /// Test hook: 替换匿名登录的 HTTP 层。
    var guestAuthClient = GuestAuthClient()

    private var config: XidConfiguration {
        get throws {
            stateLock.lock()
            defer { stateLock.unlock() }
            guard let c = _config else { throw XidError.notConfigured }
            return c
        }
    }

    private var discoveryLoader: OIDCDiscoveryLoader {
        get throws {
            stateLock.lock()
            defer { stateLock.unlock() }
            guard let d = _discoveryLoader else { throw XidError.notConfigured }
            return d
        }
    }

    // MARK: - 进行中的授权会话

    @MainActor private var activeAuthSession: AuthorizationSession?

    // MARK: - Public API

    /// 初始化 SDK 配置。必须在调用其他方法前执行。
    ///
    /// 示例:
    /// ```swift
    /// Xid.shared.configure(options: XidConfiguration(
    ///     issuer: URL(string: "https://xid.dev")!,
    ///     clientId: "your_client_id",
    ///     redirectUri: URL(string: "com.example.app://auth/callback")!
    /// ))
    /// ```
    public func configure(options: XidConfiguration) {
        stateLock.lock()
        defer { stateLock.unlock() }
        _config = options
        _discoveryLoader = OIDCDiscoveryLoader(issuer: options.issuer)
    }

    /// 替换 token 持久化适配器。可在 configure 之后随时调用。
    public func setTokenStorage(_ adapter: TokenStorageAdapter) throws {
        _ = try config
        stateLock.lock()
        defer { stateLock.unlock() }
        _config?.tokenStorage = adapter
    }

    /// 启动 Hosted Auth 登录流程。
    /// 打开系统浏览器(/authorize),完成后通过 handleRedirect(url:) 继续。
    ///
    /// - Parameter options: 附加参数,例如 ["prompt": "login"] 强制重认证。
    @MainActor
    public func signIn(options: [String: String] = [:]) async throws {
        let c = try config
        try c.validatePublicClientScopes()
        let discovery = try await discoveryLoader.load()

        // 生成 PKCE
        let pkce = try PKCE()

        // state protects the callback; nonce independently binds the ID token to this request.
        let state = try Self.randomAuthorizationValue(label: "state")
        let nonce = try Self.randomAuthorizationValue(label: "nonce")

        try PendingAuthorizationStorage.save(
            state: state,
            verifier: pkce.verifier,
            nonce: nonce,
            storage: c.tokenStorage
        )

        // 构造 /authorize URL
        guard let authURL = AuthorizationURLBuilder.build(
            authorizationEndpoint: discovery.authorizationEndpoint,
            clientId: c.clientId,
            redirectUri: c.redirectUri,
            scopes: c.scopes,
            pkce: pkce,
            state: state,
            nonce: nonce,
            additionalParams: options
        ) else {
            throw XidError.discoveryFailed("无法构造 authorization URL")
        }

        // 提取 redirect URI scheme(custom scheme)或 nil(universal link)
        let scheme: String? = {
            let s = c.redirectUri.scheme ?? ""
            // https/http 视为 universal link,不传 callbackURLScheme
            return s.hasPrefix("http") ? nil : s
        }()

        let session = AuthorizationSession()
        activeAuthSession = session

        // 启动 ASWebAuthenticationSession
        // 注意:此调用阻塞直到用户完成或取消。
        // 若需要在 handleRedirect(url:) 外部处理回调(如 universal link Scene delegate),
        // 可忽略此返回值,直接在 handleRedirect 中处理。
        let callbackURL: URL
        do {
            callbackURL = try await session.start(
                authorizationURL: authURL,
                callbackScheme: scheme,
                prefersEphemeral: c.prefersEphemeralWebBrowserSession
            )
        } catch {
            activeAuthSession = nil
            try PendingAuthorizationStorage.clear(state: state, storage: c.tokenStorage)
            throw error
        }
        activeAuthSession = nil

        // 直接在此处理回调(custom scheme 场景)
        _ = try await handleRedirect(url: callbackURL)
    }

    /// 处理 universal link 或 custom scheme 回调 URL。
    ///
    /// 在 AppDelegate/SceneDelegate 的 openURL 回调中调用:
    /// ```swift
    /// func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
    ///     if let url = contexts.first?.url {
    ///         Task { try await Xid.shared.handleRedirect(url: url) }
    ///     }
    /// }
    /// ```
    ///
    /// - Returns: 换取成功后的 XidSession。
    @discardableResult
    public func handleRedirect(url: URL) async throws -> XidSession {
        let c = try config
        try c.validatePublicClientScopes()
        let discovery = try await discoveryLoader.load()

        // 解析回调参数
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: true),
              let queryItems = components.queryItems
        else {
            throw XidError.invalidCallbackURL("无法解析回调 URL: \(url)")
        }

        guard let returnedState = queryItems.first(where: { $0.name == "state" })?.value else {
            throw XidError.invalidCallbackURL("回调 URL 中缺少 state 参数")
        }

        guard let pending = try PendingAuthorizationStorage.consume(
            state: returnedState,
            storage: c.tokenStorage
        ) else {
            throw XidError.stateMismatch
        }

        // 检查 OAuth 错误
        if let errorCode = queryItems.first(where: { $0.name == "error" })?.value {
            let desc = queryItems.first(where: { $0.name == "error_description" })?.value
            throw XidError.oauthError(errorCode, desc)
        }

        guard let code = queryItems.first(where: { $0.name == "code" })?.value else {
            throw XidError.invalidCallbackURL("回调 URL 中缺少 code 参数")
        }

        // 换取 token
        let tokenClient = TokenEndpointClient(
            tokenEndpoint: discovery.tokenEndpoint,
            clientId: c.clientId
        )
        let tokenResponse = try await tokenClient.exchangeCode(
            code: code,
            redirectUri: c.redirectUri,
            codeVerifier: pending.verifier
        )

        return try await persistAndBuildSession(
            tokenResponse: tokenResponse,
            storage: c.tokenStorage,
            discovery: discovery,
            expectedNonce: pending.nonce
        )
    }

    /// Firebase 式匿名登录:创建或续期一个 guest(匿名)会话。
    ///
    /// 惰性语义:本地已有任何有效会话(token 或 guest)时不发请求,直接返回该会话。
    /// 真正建号时先从 /auth/config?intent=sign-up 获取一次性 capability,
    /// 再随 POST /auth/guest 提交;capability 不缓存或复用。
    /// guest 没有 access token:返回的 XidSession.accessToken 为 nil,
    /// 会话凭证是服务端 session cookie,由 SDK 持久化并在 /v1/me 请求上回放。
    ///
    /// guest 不可恢复(登出即丢失)、单设备,产品应引导用户转正。
    /// 转正(在 guest 会话内完成任一正式登录)后 sub 不变;
    /// 若转而登入另一个既有账号则 sub 会变,调用方可对比新旧 session.user.sub。
    ///
    /// - Parameter turnstileToken: 服务端启用 Turnstile 时才需要,native 端通常为 nil。
    @discardableResult
    public func signInAnonymously(turnstileToken: String? = nil) async throws -> XidSession {
        let c = try config

        if let existing = try await getSession() {
            return existing
        }

        let result = try await guestAuthClient.createGuestSession(
            issuer: c.issuer,
            turnstileToken: turnstileToken
        )
        let user = try await guestAuthClient.fetchCurrentUser(
            issuer: c.issuer,
            cookies: result.cookies
        )

        let stored = StoredGuestSession(
            sessionId: result.sessionId,
            cookies: result.cookies,
            user: user,
            expiresAt: result.cookies.compactMap(\.expiresAt).min()
        )
        do {
            try GuestSessionStorage.save(stored, storage: c.tokenStorage)
        } catch {
            do {
                try GuestSessionStorage.clear(storage: c.tokenStorage)
            } catch let cleanupError {
                throw XidError.tokenStorageError(
                    "guest 会话持久化失败且清理失败: \(cleanupError)"
                )
            }
            throw error
        }
        return Self.guestSession(from: stored)
    }

    /// 获取当前会话。access token 过期后清除本地 token 并返回 nil,调用方需重新授权。
    /// 若未登录返回 nil。
    public func getSession() async throws -> XidSession? {
        let c = try config
        guard let session = try await loadSession(storage: c.tokenStorage, discovery: nil) else {
            // guest 会话没有 token 凭证,token 会话缺失时用它兜底
            if let guest = try GuestSessionStorage.load(storage: c.tokenStorage) {
                return Self.guestSession(from: guest)
            }
            return nil
        }
        if session.accessToken != nil && session.isExpired {
            try clearStoredTokens(storage: c.tokenStorage)
            return nil
        }
        return session
    }

    /// 获取尚未过期的 access token。过期后需重新授权。
    ///
    /// - Parameter forceRefresh: 当前不支持 DPoP refresh;设为 true 时清除会话并要求重新授权。
    public func getAccessToken(forceRefresh: Bool = false) async throws -> String {
        let c = try config

        if !forceRefresh,
           let session = try await loadSession(storage: c.tokenStorage, discovery: nil),
           !session.isExpired,
           let accessToken = session.accessToken
        {
            return accessToken
        }

        try clearStoredTokens(storage: c.tokenStorage)
        throw XidError.noActiveSession
    }

    /// 登出:清除本地 token,可选调用 /end_session 端点触发服务端 logout。
    ///
    /// - Parameter callEndSession: 是否调用 /end_session (RP-initiated logout)。
    public func signOut(callEndSession: Bool = true) async throws {
        let c = try config

        if callEndSession {
            let idToken = try TokenSessionStorage.loadIdToken(storage: c.tokenStorage)
            if let idToken, let discovery = try? await discoveryLoader.load(),
               let endSessionEndpoint = discovery.endSessionEndpoint
            {
                try? await endSessionClient.endSession(
                    endSessionEndpoint: endSessionEndpoint,
                    idTokenHint: idToken,
                    postLogoutRedirectUri: c.postLogoutRedirectUri
                )
            }
        }

        try clearStoredTokens(storage: c.tokenStorage)
        try GuestSessionStorage.clear(storage: c.tokenStorage)
    }

    // MARK: - 内部辅助

    private func persistAndBuildSession(
        tokenResponse: TokenResponse,
        storage: TokenStorageAdapter,
        discovery: OIDCDiscoveryDocument,
        expectedNonce: String? = nil
    ) async throws -> XidSession {
        let expiresAt = Date().addingTimeInterval(TimeInterval(tokenResponse.expiresIn))
        let previous = try TokenSessionStorage.load(storage: storage)
        let storedTokens = StoredTokenSet(
            accessToken: tokenResponse.accessToken,
            refreshToken: nil,
            idToken: tokenResponse.idToken ?? previous?.idToken,
            expiresAt: expiresAt
        )
        let idTokenStr = storedTokens.idToken ?? ""
        if expectedNonce != nil && idTokenStr.isEmpty {
            throw XidError.idTokenVerificationFailed("授权响应缺少 id_token,无法验证 nonce")
        }
        let user = try await resolveUser(
            idToken: idTokenStr.isEmpty ? nil : idTokenStr,
            accessToken: tokenResponse.accessToken,
            discovery: discovery,
            expectedNonce: expectedNonce
        )
        // Verify first, then persist. An invalid ID token must never become restart state.
        try TokenSessionStorage.save(storedTokens, storage: storage)

        // 正式登录成功即转正或换账号,本地 guest 凭证作废;清理失败不阻断登录
        try? GuestSessionStorage.clear(storage: storage)

        return XidSession(
            accessToken: tokenResponse.accessToken,
            refreshToken: nil,
            idToken: idTokenStr,
            expiresAt: expiresAt,
            user: user
        )
    }

    private func resolveUser(
        idToken: String?,
        accessToken: String,
        discovery: OIDCDiscoveryDocument,
        expectedNonce: String? = nil
    ) async throws -> XidUser {
        if let idToken, !idToken.isEmpty {
            let c = try config
            let verifier = IDTokenVerifier(
                issuer: c.issuer,
                clientId: c.clientId,
                jwksUri: discovery.jwksUri
            )
            return try await verifier.verifyAndDecodeUser(
                idToken,
                expectedNonce: expectedNonce
            )
        }

        guard let endpoint = discovery.userinfoEndpoint ?? URL(string: discovery.issuer)?
            .appendingPathComponent("userinfo")
        else {
            throw XidError.userInfoFetchFailed("无 id_token 且 discovery 未提供 userinfo_endpoint")
        }

        return try await userInfoClient.fetchUser(
            accessToken: accessToken,
            userinfoEndpoint: endpoint
        )
    }

    private func loadSession(
        storage: TokenStorageAdapter,
        discovery: OIDCDiscoveryDocument?
    ) async throws -> XidSession? {
        guard let storedTokens = try TokenSessionStorage.load(storage: storage) else {
            return nil
        }

        let idTokenStr = storedTokens.idToken ?? ""

        let user: XidUser
        if idTokenStr.isEmpty {
            user = XidUser(sub: "unknown", email: nil, emailVerified: nil, name: nil, picture: nil, provisionedBy: nil)
        } else {
            user = (try? IDTokenDecoder.decodeUser(idTokenStr)) ?? XidUser(
                sub: "unknown", email: nil, emailVerified: nil, name: nil, picture: nil, provisionedBy: nil
            )
        }

        return XidSession(
            accessToken: storedTokens.accessToken,
            refreshToken: nil,
            idToken: idTokenStr,
            expiresAt: storedTokens.expiresAt,
            user: user
        )
    }

    private static func guestSession(from stored: StoredGuestSession) -> XidSession {
        XidSession(
            accessToken: nil,
            refreshToken: nil,
            idToken: "",
            expiresAt: stored.expiresAt ?? .distantFuture,
            user: stored.user
        )
    }

    private func clearStoredTokens(storage: TokenStorageAdapter) throws {
        try TokenSessionStorage.clear(storage: storage)
    }

    private static func randomAuthorizationValue(label: String) throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            throw XidError.pkceGenerationFailed(
                "SecRandomCopyBytes \(label) 失败: OSStatus \(status)"
            )
        }
        return Data(bytes).base64URLEncodedString()
    }
}
