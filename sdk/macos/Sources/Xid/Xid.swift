// Xid.swift
// XID macOS Swift SDK
// MIT
//
// Main entry point. Provides configure / signIn / handleRedirect / getSession /
// getAccessToken / signOut / setTokenStorage, aligned with the platform matrix
// Shared native contract.

import AuthenticationServices
import Foundation

// MARK: - Xid main class

/// XID SDK main class. Access via Xid.shared singleton.
/// All public methods are thread-safe (internal state protected by NSLock).
public final class Xid: @unchecked Sendable {
    // MARK: - Singleton

    public static let shared = Xid()
    private init() {}

    // MARK: - Internal state (protected by stateLock)

    private let stateLock = NSLock()
    private var _config: XidConfiguration?
    private var _discoveryLoader: OIDCDiscoveryLoader?
    private let userInfoClient = UserInfoClient()
    private let endSessionClient = EndSessionClient()

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

    // MARK: - Active authorization session

    @MainActor private var activeAuthSession: AuthorizationSession?

    // MARK: - Public API

    /// Initializes the SDK configuration. Must be called before any other method.
    ///
    /// Example:
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

    /// Replaces the token persistence adapter. Can be called any time after configure.
    public func setTokenStorage(_ adapter: TokenStorageAdapter) throws {
        _ = try config
        stateLock.lock()
        defer { stateLock.unlock() }
        _config?.tokenStorage = adapter
    }

    /// Starts the Hosted Auth sign-in flow.
    /// Opens a system browser session (/authorize). After completion, calls handleRedirect(url:).
    ///
    /// - Parameter options: Extra parameters, e.g. ["prompt": "login"] to force re-authentication.
    @MainActor
    public func signIn(options: [String: String] = [:]) async throws {
        let c = try config
        let discovery = try await discoveryLoader.load()

        // Generate PKCE pair
        let pkce = try PKCE()

        // Generate random state for CSRF protection
        var stateBytes = [UInt8](repeating: 0, count: 16)
        let stateStatus = SecRandomCopyBytes(kSecRandomDefault, stateBytes.count, &stateBytes)
        guard stateStatus == errSecSuccess else {
            throw XidError.pkceGenerationFailed("SecRandomCopyBytes state failed: OSStatus \(stateStatus)")
        }
        let state = Data(stateBytes).base64URLEncodedString()

        // Persist verifier and state in Keychain for the duration of the flow
        try c.tokenStorage.save(key: StorageKey.pkceVerifier, value: pkce.verifier)
        try c.tokenStorage.save(key: StorageKey.oauthState, value: state)

        // Build /authorize URL
        guard let authURL = AuthorizationURLBuilder.build(
            authorizationEndpoint: discovery.authorizationEndpoint,
            clientId: c.clientId,
            redirectUri: c.redirectUri,
            scopes: c.scopes,
            pkce: pkce,
            state: state,
            additionalParams: options
        ) else {
            throw XidError.discoveryFailed("Could not build authorization URL")
        }

        // Extract custom URL scheme, or nil for universal links
        let scheme: String? = {
            let s = c.redirectUri.scheme ?? ""
            return s.hasPrefix("http") ? nil : s
        }()

        let session = AuthorizationSession()
        activeAuthSession = session

        let callbackURL = try await session.start(
            authorizationURL: authURL,
            callbackScheme: scheme,
            prefersEphemeral: c.prefersEphemeralWebBrowserSession
        )
        activeAuthSession = nil

        _ = try await handleRedirect(url: callbackURL)
    }

    /// Handles a universal link or custom scheme callback URL.
    ///
    /// Call from the app's URL handling delegate:
    /// ```swift
    /// func application(_ app: NSApplication, open urls: [URL]) {
    ///     if let url = urls.first {
    ///         Task { try await Xid.shared.handleRedirect(url: url) }
    ///     }
    /// }
    /// ```
    ///
    /// - Returns: The XidSession built from the exchanged tokens.
    @discardableResult
    public func handleRedirect(url: URL) async throws -> XidSession {
        let c = try config
        let discovery = try await discoveryLoader.load()

        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: true),
              let queryItems = components.queryItems
        else {
            throw XidError.invalidCallbackURL("Cannot parse callback URL: \(url)")
        }

        // Check for OAuth error response
        if let errorCode = queryItems.first(where: { $0.name == "error" })?.value {
            let desc = queryItems.first(where: { $0.name == "error_description" })?.value
            throw XidError.oauthError(errorCode, desc)
        }

        guard let code = queryItems.first(where: { $0.name == "code" })?.value else {
            throw XidError.invalidCallbackURL("Callback URL missing 'code' parameter")
        }
        guard let returnedState = queryItems.first(where: { $0.name == "state" })?.value else {
            throw XidError.invalidCallbackURL("Callback URL missing 'state' parameter")
        }

        // Validate state (CSRF protection)
        guard let savedState = try c.tokenStorage.load(key: StorageKey.oauthState),
              savedState == returnedState
        else {
            throw XidError.stateMismatch
        }
        try c.tokenStorage.delete(key: StorageKey.oauthState)

        // Retrieve code_verifier
        guard let verifier = try c.tokenStorage.load(key: StorageKey.pkceVerifier) else {
            throw XidError.invalidCallbackURL("PKCE verifier not found; flow may have expired")
        }
        try c.tokenStorage.delete(key: StorageKey.pkceVerifier)

        // Exchange code for tokens
        let tokenClient = TokenEndpointClient(
            tokenEndpoint: discovery.tokenEndpoint,
            clientId: c.clientId
        )
        let tokenResponse = try await tokenClient.exchangeCode(
            code: code,
            redirectUri: c.redirectUri,
            codeVerifier: verifier
        )

        return try await persistAndBuildSession(
            tokenResponse: tokenResponse,
            storage: c.tokenStorage,
            discovery: discovery
        )
    }

    /// Returns the current session, refreshing the access token if it is near expiry.
    /// Returns nil if the user is not signed in.
    public func getSession() async throws -> XidSession? {
        let c = try config
        return try await loadSession(storage: c.tokenStorage)
    }

    /// Returns a valid access token, refreshing it if expired.
    ///
    /// - Parameter forceRefresh: Forces a refresh even if the current token is still valid.
    public func getAccessToken(forceRefresh: Bool = false) async throws -> String {
        let c = try config
        let discovery = try await discoveryLoader.load()

        if let session = try await loadSession(storage: c.tokenStorage),
           !session.isNearExpiry,
           !forceRefresh
        {
            return session.accessToken
        }

        guard let refreshToken = try c.tokenStorage.load(key: StorageKey.refreshToken) else {
            throw XidError.noActiveSession
        }

        let tokenClient = TokenEndpointClient(
            tokenEndpoint: discovery.tokenEndpoint,
            clientId: c.clientId
        )
        let tokenResponse: TokenResponse
        do {
            tokenResponse = try await tokenClient.refreshTokens(refreshToken: refreshToken)
        } catch {
            try clearStoredTokens(storage: c.tokenStorage)
            throw XidError.tokenRefreshFailed(error.localizedDescription)
        }

        let newSession = try await persistAndBuildSession(
            tokenResponse: tokenResponse,
            storage: c.tokenStorage,
            discovery: discovery
        )
        return newSession.accessToken
    }

    /// Signs out: clears local tokens, optionally calls /end_session for server-side logout.
    ///
    /// - Parameter callEndSession: Whether to call /end_session (RP-initiated logout).
    public func signOut(callEndSession: Bool = true) async throws {
        let c = try config

        if callEndSession {
            let idToken = try c.tokenStorage.load(key: StorageKey.idToken)
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
    }

    // MARK: - Internal helpers

    private func persistAndBuildSession(
        tokenResponse: TokenResponse,
        storage: TokenStorageAdapter,
        discovery: OIDCDiscoveryDocument
    ) async throws -> XidSession {
        let expiresAt = Date().addingTimeInterval(TimeInterval(tokenResponse.expiresIn))

        try storage.save(key: StorageKey.accessToken, value: tokenResponse.accessToken)
        if let refreshToken = tokenResponse.refreshToken {
            try storage.save(key: StorageKey.refreshToken, value: refreshToken)
        }
        if let idToken = tokenResponse.idToken {
            try storage.save(key: StorageKey.idToken, value: idToken)
        }
        let isoFormatter = ISO8601DateFormatter()
        try storage.save(key: StorageKey.expiresAt, value: isoFormatter.string(from: expiresAt))

        let storedIdToken = try storage.load(key: StorageKey.idToken)
        let idTokenStr = tokenResponse.idToken ?? storedIdToken ?? ""
        let user = try await resolveUser(
            idToken: idTokenStr.isEmpty ? nil : idTokenStr,
            accessToken: tokenResponse.accessToken,
            discovery: discovery
        )

        let storedRefreshToken = try storage.load(key: StorageKey.refreshToken)
        return XidSession(
            accessToken: tokenResponse.accessToken,
            refreshToken: tokenResponse.refreshToken ?? storedRefreshToken,
            idToken: idTokenStr,
            expiresAt: expiresAt,
            user: user
        )
    }

    private func resolveUser(
        idToken: String?,
        accessToken: String,
        discovery: OIDCDiscoveryDocument
    ) async throws -> XidUser {
        if let idToken, !idToken.isEmpty {
            let c = try config
            let verifier = IDTokenVerifier(
                issuer: c.issuer,
                clientId: c.clientId,
                jwksUri: discovery.jwksUri
            )
            return try await verifier.verifyAndDecodeUser(idToken)
        }

        guard let endpoint = discovery.userinfoEndpoint ?? URL(string: discovery.issuer)?
            .appendingPathComponent("userinfo")
        else {
            throw XidError.userInfoFetchFailed("No id_token and discovery has no userinfo_endpoint")
        }

        return try await userInfoClient.fetchUser(
            accessToken: accessToken,
            userinfoEndpoint: endpoint
        )
    }

    private func loadSession(storage: TokenStorageAdapter) async throws -> XidSession? {
        guard let accessToken = try storage.load(key: StorageKey.accessToken),
              let expiresAtStr = try storage.load(key: StorageKey.expiresAt)
        else {
            return nil
        }

        let isoFormatter = ISO8601DateFormatter()
        guard let expiresAt = isoFormatter.date(from: expiresAtStr) else {
            return nil
        }

        let idTokenStr = (try? storage.load(key: StorageKey.idToken)) ?? ""
        let refreshToken = try? storage.load(key: StorageKey.refreshToken)

        let user: XidUser
        if idTokenStr.isEmpty {
            user = XidUser(sub: "unknown", email: nil, emailVerified: nil, name: nil, picture: nil)
        } else {
            user = (try? IDTokenDecoder.decodeUser(idTokenStr)) ?? XidUser(
                sub: "unknown", email: nil, emailVerified: nil, name: nil, picture: nil
            )
        }

        return XidSession(
            accessToken: accessToken,
            refreshToken: refreshToken,
            idToken: idTokenStr,
            expiresAt: expiresAt,
            user: user
        )
    }

    private func clearStoredTokens(storage: TokenStorageAdapter) throws {
        try? storage.delete(key: StorageKey.accessToken)
        try? storage.delete(key: StorageKey.refreshToken)
        try? storage.delete(key: StorageKey.idToken)
        try? storage.delete(key: StorageKey.expiresAt)
        try? storage.delete(key: StorageKey.pkceVerifier)
        try? storage.delete(key: StorageKey.oauthState)
    }
}
