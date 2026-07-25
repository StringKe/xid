// EndSessionClient.swift
// XID iOS Swift SDK
//
// OIDC RP-initiated logout via POST /end_session.

import Foundation

struct EndSessionClient: Sendable {
    private let urlSession: URLSession

    init(urlSession: URLSession = .shared) {
        self.urlSession = urlSession
    }

    /// POST id_token_hint (+ optional post_logout_redirect_uri) to /end_session.
    /// Best-effort: callers may ignore errors during sign-out.
    func endSession(
        endSessionEndpoint: URL,
        idTokenHint: String,
        postLogoutRedirectUri: URL? = nil
    ) async throws {
        var params: [String: String] = [
            "id_token_hint": idTokenHint,
        ]
        if let postLogoutRedirectUri {
            params["post_logout_redirect_uri"] = postLogoutRedirectUri.absoluteString
        }

        var request = URLRequest(url: endSessionEndpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = params
            .map { "\($0.key)=\(urlEncode($0.value))" }
            .joined(separator: "&")
            .data(using: .utf8)

        let (_, response) = try await urlSession.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw XidError.endSessionFailed("无效响应类型")
        }
        guard (200 ... 399).contains(httpResponse.statusCode) else {
            throw XidError.endSessionFailed("HTTP \(httpResponse.statusCode)")
        }
    }

    private func urlEncode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value
    }
}