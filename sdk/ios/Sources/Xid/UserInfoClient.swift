// UserInfoClient.swift
// XID iOS Swift SDK
//
// OIDC /userinfo endpoint client (Bearer access_token).

import Foundation

struct UserInfoClient: Sendable {
    private let urlSession: URLSession

    init(urlSession: URLSession = .shared) {
        self.urlSession = urlSession
    }

    func fetchUser(accessToken: String, userinfoEndpoint: URL) async throws -> XidUser {
        var request = URLRequest(url: userinfoEndpoint)
        request.httpMethod = "GET"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await urlSession.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw XidError.userInfoFetchFailed("无效响应类型")
        }
        guard httpResponse.statusCode == 200 else {
            throw XidError.userInfoFetchFailed("HTTP \(httpResponse.statusCode)")
        }

        guard
            let json = try? JSONSerialization.jsonObject(with: data),
            let claims = json as? [String: Any]
        else {
            throw XidError.userInfoFetchFailed("userinfo JSON 解析失败")
        }

        return try IDTokenDecoder.user(from: claims)
    }
}