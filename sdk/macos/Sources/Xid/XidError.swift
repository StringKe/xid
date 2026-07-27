// XidError.swift
// XID macOS Swift SDK
// MIT

import Foundation

/// SDK unified error type.
public enum XidError: Error, LocalizedError, Sendable {
    /// SDK not configured; call Xid.configure(options:) first.
    case notConfigured

    /// PKCE code_verifier/code_challenge generation failed.
    case pkceGenerationFailed(String)

    /// OIDC Discovery document load failed.
    case discoveryFailed(String)

    /// Authorization code -> token exchange failed.
    case tokenExchangeFailed(String)

    /// Refresh token rotation failed.
    case tokenRefreshFailed(String)

    /// Server returned an OAuth error response (RFC 6749 Section 5.2).
    case oauthError(String, String?)

    /// ASWebAuthenticationSession was cancelled by the user or failed.
    case authSessionCancelled

    /// Callback URL is malformed or missing required parameters.
    case invalidCallbackURL(String)

    /// State parameter mismatch (CSRF protection triggered).
    case stateMismatch

    /// ID token decode failed.
    case idTokenDecodeFailed(String)

    /// ID token JWKS signature verification failed.
    case idTokenVerificationFailed(String)

    /// JWKS fetch or parse failed.
    case jwksFetchFailed(String)

    /// /userinfo request failed.
    case userInfoFetchFailed(String)

    /// /end_session request failed.
    case endSessionFailed(String)

    /// Keychain / token storage operation failed.
    case tokenStorageError(String)

    /// /auth/guest sign-in or the follow-up /v1/me fetch failed.
    case anonymousSignInFailed(String)

    /// No active session (not signed in or all tokens expired).
    case noActiveSession

    public var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "XID SDK not configured. Call Xid.configure(options:) first."
        case .pkceGenerationFailed(let reason):
            return "PKCE generation failed: \(reason)"
        case .discoveryFailed(let reason):
            return "OIDC Discovery load failed: \(reason)"
        case .tokenExchangeFailed(let reason):
            return "Token exchange failed: \(reason)"
        case .tokenRefreshFailed(let reason):
            return "Token refresh failed: \(reason)"
        case .oauthError(let code, let description):
            return "OAuth error [\(code)]: \(description ?? "no detail")"
        case .authSessionCancelled:
            return "User cancelled sign-in."
        case .invalidCallbackURL(let reason):
            return "Invalid callback URL: \(reason)"
        case .stateMismatch:
            return "OAuth state mismatch; request may have been tampered with."
        case .idTokenDecodeFailed(let reason):
            return "ID token decode failed: \(reason)"
        case .idTokenVerificationFailed(let reason):
            return "ID token verification failed: \(reason)"
        case .jwksFetchFailed(let reason):
            return "JWKS fetch failed: \(reason)"
        case .userInfoFetchFailed(let reason):
            return "Userinfo fetch failed: \(reason)"
        case .endSessionFailed(let reason):
            return "End session failed: \(reason)"
        case .tokenStorageError(let reason):
            return "Token storage error: \(reason)"
        case .anonymousSignInFailed(let reason):
            return "Anonymous sign-in failed: \(reason)"
        case .noActiveSession:
            return "No active session. Please sign in again."
        }
    }
}
