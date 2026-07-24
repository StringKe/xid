// XidConfiguration.swift
// XID iOS Swift SDK
// Status: implemented; compiled and unit-tested locally, real IdP round-trip pending

import Foundation

/// XID SDK 配置。调用 Xid.configure(options:) 传入此结构体。
public struct XidConfiguration: Sendable {
    /// XID issuer URL,例如 https://xid.dev 或自托管域名根地址。
    public let issuer: URL

    /// 在 XID console 注册的 OAuth 客户端 ID (public client,无 secret)。
    public let clientId: String

    /// 注册的 redirect URI。
    /// - Universal Link 示例: https://example.com/auth/callback
    /// - Custom Scheme 示例: com.example.app://auth/callback
    public let redirectUri: URL

    /// 请求的 OAuth scope 列表,默认包含 openid、profile、email、offline_access。
    public let scopes: [String]

    /// Token 持久化适配器,默认使用 KeychainTokenStorage。
    public var tokenStorage: TokenStorageAdapter

    /// ASWebAuthenticationSession 是否使用独立浏览器会话。
    /// `true`(默认): 不共享 cookie,每次登录独立会话。
    /// `false`: 共享浏览器 cookie,支持 SSO 单点登录。
    public let prefersEphemeralWebBrowserSession: Bool

    /// RP-initiated logout 回跳 URI(可选)。传给 /end_session 的 post_logout_redirect_uri。
    public let postLogoutRedirectUri: URL?

    public init(
        issuer: URL,
        clientId: String,
        redirectUri: URL,
        scopes: [String] = ["openid", "profile", "email", "offline_access"],
        tokenStorage: TokenStorageAdapter = KeychainTokenStorage(),
        prefersEphemeralWebBrowserSession: Bool = true,
        postLogoutRedirectUri: URL? = nil
    ) {
        self.issuer = issuer
        self.clientId = clientId
        self.redirectUri = redirectUri
        self.scopes = scopes
        self.tokenStorage = tokenStorage
        self.prefersEphemeralWebBrowserSession = prefersEphemeralWebBrowserSession
        self.postLogoutRedirectUri = postLogoutRedirectUri
    }
}
