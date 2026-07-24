// OIDCDiscovery.swift
// XID macOS Swift SDK
// MIT
//
// Fetches the OIDC Discovery document from {issuer}/.well-known/openid-configuration.

import Foundation

/// Minimal OIDC Discovery document subset - only fields the SDK uses.
struct OIDCDiscoveryDocument: Decodable, Sendable {
    let issuer: String
    let authorizationEndpoint: URL
    let tokenEndpoint: URL
    let jwksUri: URL
    let userinfoEndpoint: URL?
    let endSessionEndpoint: URL?

    private enum CodingKeys: String, CodingKey {
        case issuer
        case authorizationEndpoint = "authorization_endpoint"
        case tokenEndpoint = "token_endpoint"
        case jwksUri = "jwks_uri"
        case userinfoEndpoint = "userinfo_endpoint"
        case endSessionEndpoint = "end_session_endpoint"
    }
}

/// Fetches and caches the OIDC Discovery document.
actor OIDCDiscoveryLoader {
    private var cached: OIDCDiscoveryDocument?
    private let issuer: URL

    init(issuer: URL) {
        self.issuer = issuer
    }

    func load() async throws -> OIDCDiscoveryDocument {
        if let doc = cached {
            return doc
        }
        let discoveryURL = issuer.appendingPathComponent("/.well-known/openid-configuration")
        let (data, response) = try await URLSession.shared.data(from: discoveryURL)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw XidError.discoveryFailed("Non-200 response from \(discoveryURL)")
        }
        let doc = try JSONDecoder().decode(OIDCDiscoveryDocument.self, from: data)
        cached = doc
        return doc
    }

    /// Invalidates the cached discovery document (forces re-fetch on next load).
    func invalidate() {
        cached = nil
    }
}
