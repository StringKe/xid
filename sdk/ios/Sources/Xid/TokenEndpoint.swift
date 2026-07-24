// TokenEndpoint.swift
// XID iOS Swift SDK
// Status: implemented; compiled and unit-tested locally, real IdP round-trip pending
//
// /token 端点交互:authorization_code 换 token 以及 refresh_token 轮换。

import Foundation

// MARK: - Token 响应

struct TokenResponse: Decodable, Sendable {
    let accessToken: String
    let tokenType: String
    let expiresIn: Int
    let refreshToken: String?
    let idToken: String?
    let scope: String?

    private enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case tokenType = "token_type"
        case expiresIn = "expires_in"
        case refreshToken = "refresh_token"
        case idToken = "id_token"
        case scope
    }
}

// MARK: - Token 端点客户端

struct TokenEndpointClient: Sendable {
    private let tokenEndpoint: URL
    private let clientId: String

    init(tokenEndpoint: URL, clientId: String) {
        self.tokenEndpoint = tokenEndpoint
        self.clientId = clientId
    }

    /// authorization_code grant (PKCE)。
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

    /// refresh_token grant。XID 服务端执行轮换:旧 token 立即作废,返回新 token。
    func refreshTokens(refreshToken: String) async throws -> TokenResponse {
        let params: [String: String] = [
            "grant_type": "refresh_token",
            "client_id": clientId,
            "refresh_token": refreshToken,
        ]
        return try await post(params: params)
    }

    private func post(params: [String: String]) async throws -> TokenResponse {
        var request = URLRequest(url: tokenEndpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        // 安全要求: token 端点响应不应被缓存 (RFC 6749 Section 5.1)
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.httpBody = params
            .map { "\($0.key)=\(urlEncode($0.value))" }
            .joined(separator: "&")
            .data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw XidError.tokenExchangeFailed("无效响应类型")
        }
        guard httpResponse.statusCode == 200 else {
            // 尝试解析 OAuth 错误响应
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

// MARK: - OAuth 错误响应

private struct OAuthErrorResponse: Decodable {
    let error: String
    let errorDescription: String?

    private enum CodingKeys: String, CodingKey {
        case error
        case errorDescription = "error_description"
    }
}
