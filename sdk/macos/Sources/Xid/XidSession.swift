// XidSession.swift
// XID macOS Swift SDK
// MIT

import Foundation

/// User session snapshot. Obtain via Xid.shared.getSession().
public struct XidSession: Sendable, Codable {
    /// Access token (JWT). Lifetime is typically 1 hour.
    public let accessToken: String

    /// Refresh token. Used to rotate access tokens; lifetime is configured server-side (default 7 days).
    /// Persisted in Keychain secure storage.
    public let refreshToken: String?

    /// ID token (JWT). Contains identity claims.
    public let idToken: String

    /// Access token expiry timestamp.
    public let expiresAt: Date

    /// User info decoded from the ID token.
    public let user: XidUser

    /// Whether the access token is expired.
    public var isExpired: Bool {
        expiresAt <= Date()
    }

    /// Whether the access token will expire within 60 seconds.
    public var isNearExpiry: Bool {
        expiresAt <= Date().addingTimeInterval(60)
    }
}

/// Basic user information decoded from ID token claims.
public struct XidUser: Sendable, Codable {
    public let sub: String
    public let email: String?
    public let emailVerified: Bool?
    public let name: String?
    public let picture: String?

    private enum CodingKeys: String, CodingKey {
        case sub
        case email
        case emailVerified = "email_verified"
        case name
        case picture
    }
}
