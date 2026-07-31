// TokenEndpoint.swift
// XID macOS Swift SDK
// MIT
//
// /token endpoint interaction: authorization_code + PKCE exchange.

import Foundation

// MARK: - Token response

struct TokenResponse: Decodable, Sendable {
    let accessToken: String
    let tokenType: String
    let expiresIn: Int
    let idToken: String?
    let scope: String?

    private enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case tokenType = "token_type"
        case expiresIn = "expires_in"
        case idToken = "id_token"
        case scope
    }
}

// MARK: - Token endpoint client

struct TokenEndpointClient: Sendable {
    private let tokenEndpoint: URL
    private let clientId: String

    init(tokenEndpoint: URL, clientId: String) {
        self.tokenEndpoint = tokenEndpoint
        self.clientId = clientId
    }

    /// authorization_code grant with PKCE.
    func exchangeCode(
        code: String,
        redirectUri: URL,
        codeVerifier: String
    ) async throws -> TokenResponse {
        let params: [String: String] = [
            "grant_type": "authorization_code",
            "client_id": clientId,
            "code": code,
            "redirect_uri": redirectUri.absoluteString,
            "code_verifier": codeVerifier,
        ]
        return try await post(params: params)
    }

    private func post(params: [String: String]) async throws -> TokenResponse {
        var request = URLRequest(url: tokenEndpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        // RFC 6749 Section 5.1: token endpoint responses must not be cached
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.httpBody = params
            .map { "\($0.key)=\(urlEncode($0.value))" }
            .joined(separator: "&")
            .data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw XidError.tokenExchangeFailed("Invalid response type")
        }
        guard httpResponse.statusCode == 200 else {
            if let errorBody = try? JSONDecoder().decode(OAuthErrorResponse.self, from: data) {
                throw XidError.oauthError(errorBody.error, errorBody.errorDescription)
            }
            throw XidError.tokenExchangeFailed("HTTP \(httpResponse.statusCode)")
        }
        return try JSONDecoder().decode(TokenResponse.self, from: data)
    }

    private func urlEncode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value
    }
}

// MARK: - OAuth error response

private struct OAuthErrorResponse: Decodable {
    let error: String
    let errorDescription: String?

    private enum CodingKeys: String, CodingKey {
        case error
        case errorDescription = "error_description"
    }
}
