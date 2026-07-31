// XidSession.swift
// XID macOS Swift SDK
// MIT

import Foundation

/// User session snapshot. Obtain via Xid.shared.getSession().
public struct XidSession: Sendable, Codable {
    /// Access token (JWT). Lifetime is typically 1 hour.
    /// nil for anonymous (guest) sessions: guests are cookie-based and hold no tokens.
    public let accessToken: String?

    /// Reserved field. It is always nil until the SDK implements DPoP for public clients.
    public let refreshToken: String?

    /// ID token (JWT). Contains identity claims.
    /// nil for anonymous (guest) sessions: guests are cookie-based and hold no tokens.
    public let idToken: String?

    /// Access token expiry timestamp.
    /// Guest sessions have no client-side token expiry; the server-side cookie TTL applies,
    /// so this is Date.distantFuture for them.
    public let expiresAt: Date

    /// User info decoded from the ID token.
    public let user: XidUser

    /// Whether this is an anonymous (guest) session.
    public var isAnonymous: Bool {
        user.isAnonymous
    }

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

    /// How the user record was provisioned server-side (`provisioned_by` in /v1/me).
    /// "anonymous" means a guest account created by signInAnonymously.
    public let provisionedBy: String?

    /// Whether this user is an anonymous guest (provisioned_by == "anonymous").
    public var isAnonymous: Bool {
        provisionedBy == "anonymous"
    }

    private enum CodingKeys: String, CodingKey {
        case sub
        case email
        case emailVerified = "email_verified"
        case name
        case picture
        case provisionedBy = "provisioned_by"
    }
}
