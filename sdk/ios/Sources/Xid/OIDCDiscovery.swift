// OIDCDiscovery.swift
// XID iOS Swift SDK
// Status: implemented; compiled and unit-tested locally, real IdP round-trip pending
//
// 从 issuer/.well-known/openid-configuration 加载服务端 endpoint 列表。

import Foundation

/// OIDC Discovery 文档的最小子集。只取 SDK 需要的字段。
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

/// 负责拉取并缓存 OIDC Discovery 文档。
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
            throw XidError.discoveryFailed("非 200 响应: \(discoveryURL)")
        }
        let doc = try JSONDecoder().decode(OIDCDiscoveryDocument.self, from: data)
        cached = doc
        return doc
    }

    /// 强制刷新缓存(重新拉取 discovery 文档)。
    func invalidate() {
        cached = nil
    }
}
