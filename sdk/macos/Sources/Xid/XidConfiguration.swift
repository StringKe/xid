// XidConfiguration.swift
// XID macOS Swift SDK
// MIT

import Foundation

/// XID SDK configuration. Pass to Xid.configure(options:).
public struct XidConfiguration: Sendable {
    /// XID issuer URL, e.g. https://xid.dev or self-hosted root URL.
    public let issuer: URL

    /// OAuth client ID registered in XID console (public client; no secret).
    public let clientId: String

    /// Registered redirect URI.
    /// - Universal Link example: https://example.com/auth/callback
    /// - Custom scheme example:  com.example.app://auth/callback
    public let redirectUri: URL

    /// Requested OAuth scopes. Defaults include openid, profile, email, offline_access.
    public let scopes: [String]

    /// Token persistence adapter. Defaults to KeychainTokenStorage.
    public var tokenStorage: TokenStorageAdapter

    /// Whether ASWebAuthenticationSession uses an ephemeral browser session.
    /// `true` (default): no shared cookies. `false`: share cookies for SSO.
    public let prefersEphemeralWebBrowserSession: Bool

    /// Optional post-logout redirect URI for RP-initiated logout.
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
