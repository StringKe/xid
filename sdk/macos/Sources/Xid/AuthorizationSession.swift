// AuthorizationSession.swift
// XID macOS Swift SDK
// MIT
//
// Wraps ASWebAuthenticationSession with an async/await interface for macOS.

import AppKit
import AuthenticationServices
import Foundation

/// Wraps ASWebAuthenticationSession for macOS with async/await.
@MainActor
final class AuthorizationSession: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    /// Launches the authorization session and returns the callback URL.
    /// - Parameters:
    ///   - authorizationURL: Full /authorize URL including all query parameters
    ///   - callbackScheme: Custom URL scheme (e.g. "com.example.app"), or nil for universal links
    func start(
        authorizationURL: URL,
        callbackScheme: String?,
        prefersEphemeral: Bool = true
    ) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: authorizationURL,
                callbackURLScheme: callbackScheme
            ) { callbackURL, error in
                if let error {
                    if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
                        continuation.resume(throwing: XidError.authSessionCancelled)
                    } else {
                        continuation.resume(throwing: XidError.tokenExchangeFailed(error.localizedDescription))
                    }
                    return
                }
                guard let callbackURL else {
                    continuation.resume(throwing: XidError.invalidCallbackURL("Callback URL is nil"))
                    return
                }
                continuation.resume(returning: callbackURL)
            }
            session.prefersEphemeralWebBrowserSession = prefersEphemeral
            session.presentationContextProvider = self
            self.session = session
            session.start()
        }
    }

    func cancel() {
        session?.cancel()
        session = nil
    }

    // MARK: - ASWebAuthenticationPresentationContextProviding

    @MainActor
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        // Return the key window as the presentation anchor for macOS.
        if let window = NSApp.keyWindow {
            return window
        }
        // Fallback: first ordered window
        return NSApp.windows.first ?? ASPresentationAnchor()
    }
}

// MARK: - Authorization URL builder

struct AuthorizationURLBuilder {
    static func build(
        authorizationEndpoint: URL,
        clientId: String,
        redirectUri: URL,
        scopes: [String],
        pkce: PKCE,
        state: String,
        additionalParams: [String: String] = [:]
    ) -> URL? {
        var components = URLComponents(url: authorizationEndpoint, resolvingAgainstBaseURL: true)

        var queryItems: [URLQueryItem] = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "redirect_uri", value: redirectUri.absoluteString),
            URLQueryItem(name: "scope", value: scopes.joined(separator: " ")),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: pkce.challenge),
            URLQueryItem(name: "code_challenge_method", value: pkce.method),
        ]

        for (key, value) in additionalParams {
            queryItems.append(URLQueryItem(name: key, value: value))
        }

        components?.queryItems = queryItems
        return components?.url
    }
}
