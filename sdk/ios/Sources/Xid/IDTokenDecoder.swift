// IDTokenDecoder.swift
// XID iOS Swift SDK
//
// ID token decode with JWKS-backed ES256/RS256 signature verification.

import Foundation

struct JWTHeader: Decodable, Sendable {
    let alg: String
    let kid: String?
    let typ: String?
}

/// Verifies ID tokens against JWKS and decodes user claims.
actor IDTokenVerifier {
    private let issuer: URL
    private let clientId: String
    private let jwksCache: JwksCache
    private let clockLeeway: TimeInterval

    init(
        issuer: URL,
        clientId: String,
        jwksUri: URL? = nil,
        clockLeeway: TimeInterval = 60,
        urlSession: URLSession = .shared
    ) {
        self.issuer = issuer
        self.clientId = clientId
        self.clockLeeway = clockLeeway
        let resolvedJwksUri = jwksUri ?? issuer.appendingPathComponent("jwks")
        self.jwksCache = JwksCache(jwksUri: resolvedJwksUri, urlSession: urlSession)
    }

    /// Test hook: verifier backed by preloaded JWKS keys.
    init(
        issuer: URL,
        clientId: String,
        jwksCache: JwksCache,
        clockLeeway: TimeInterval = 60
    ) {
        self.issuer = issuer
        self.clientId = clientId
        self.jwksCache = jwksCache
        self.clockLeeway = clockLeeway
    }

    func verifyAndDecodeUser(_ idToken: String) async throws -> XidUser {
        let claims = try await verify(idToken)
        return try IDTokenDecoder.user(from: claims)
    }

    func verify(_ idToken: String) async throws -> [String: Any] {
        let parts = idToken.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else {
            throw XidError.idTokenVerificationFailed("JWT 格式错误: 应有 3 段")
        }

        let headerPart = String(parts[0])
        let payloadPart = String(parts[1])
        let signaturePart = String(parts[2])

        guard let headerData = JWTBase64.urlDecode(headerPart) else {
            throw XidError.idTokenVerificationFailed("header Base64 解码失败")
        }
        let header: JWTHeader
        do {
            header = try JSONDecoder().decode(JWTHeader.self, from: headerData)
        } catch {
            throw XidError.idTokenVerificationFailed("header JSON 解析失败")
        }

        guard Self.isSupportedAlgorithm(header.alg) else {
            throw XidError.idTokenVerificationFailed("不支持的算法: \(header.alg)")
        }

        guard let kid = header.kid, !kid.isEmpty else {
            throw XidError.idTokenVerificationFailed("JWT header 缺少 kid")
        }

        let (publicKey, jwkAlg) = try await jwksCache.publicKey(for: kid)
        guard header.alg == jwkAlg else {
            throw XidError.idTokenVerificationFailed("token alg 与 JWKS alg 不一致")
        }

        guard let signatureData = JWTBase64.urlDecode(signaturePart) else {
            throw XidError.idTokenVerificationFailed("signature Base64 解码失败")
        }

        let signingInput = Data("\(headerPart).\(payloadPart)".utf8)
        let valid = Self.verifySignature(
            publicKey: publicKey,
            algorithm: header.alg,
            signature: signatureData,
            signingInput: signingInput
        )
        guard valid else {
            throw XidError.idTokenVerificationFailed("签名验证失败")
        }

        let claims = try IDTokenDecoder.decodePayload(idToken)
        try validateClaims(claims)
        return claims
    }

    // MARK: - Claim validation

    private func validateClaims(_ claims: [String: Any]) throws {
        let expectedIssuer = issuer.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if let iss = claims["iss"] as? String {
            let normalizedIss = iss.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard normalizedIss == expectedIssuer else {
                throw XidError.idTokenVerificationFailed("iss 不匹配")
            }
        } else {
            throw XidError.idTokenVerificationFailed("缺少 iss claim")
        }

        if let aud = claims["aud"] as? String {
            guard aud == clientId else {
                throw XidError.idTokenVerificationFailed("aud 不匹配")
            }
        } else if let audList = claims["aud"] as? [String] {
            guard audList.contains(clientId) else {
                throw XidError.idTokenVerificationFailed("aud 不匹配")
            }
        } else {
            throw XidError.idTokenVerificationFailed("缺少 aud claim")
        }

        let now = Date().timeIntervalSince1970
        if let exp = claims["exp"] as? TimeInterval {
            guard now <= exp + clockLeeway else {
                throw XidError.idTokenVerificationFailed("token 已过期")
            }
        } else if let expInt = claims["exp"] as? Int {
            guard now <= TimeInterval(expInt) + clockLeeway else {
                throw XidError.idTokenVerificationFailed("token 已过期")
            }
        } else {
            throw XidError.idTokenVerificationFailed("缺少 exp claim")
        }
    }

    // MARK: - Signature verification

    private static let supportedAlgorithms: Set<String> = ["ES256", "RS256", "PS256"]

    private static func isSupportedAlgorithm(_ alg: String) -> Bool {
        supportedAlgorithms.contains(alg)
    }

    private static func verifySignature(
        publicKey: VerifyingPublicKey,
        algorithm: String,
        signature: Data,
        signingInput: Data
    ) -> Bool {
        switch (publicKey, algorithm) {
        case let (.ecP256(handle), "ES256"):
            return handle.isValidSignature(signature, for: signingInput)
        case let (.rsa(handle), "RS256"):
            return handle.isValidSignature(signature, for: signingInput)
        case let (.rsa(handle), "PS256"):
            return handle.isValidSignature(signature, for: signingInput)
        default:
            return false
        }
    }
}

struct IDTokenDecoder {
    /// 解码 id token 的 payload claims(不验签)。仅用于已验证 token 的本地读取。
    static func decodePayload(_ idToken: String) throws -> [String: Any] {
        let parts = idToken.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else {
            throw XidError.idTokenDecodeFailed("JWT 格式错误: 应有 3 段")
        }

        let payloadBase64 = String(parts[1])
        guard let data = JWTBase64.urlDecode(payloadBase64) else {
            throw XidError.idTokenDecodeFailed("payload Base64 解码失败")
        }
        guard
            let json = try? JSONSerialization.jsonObject(with: data),
            let claims = json as? [String: Any]
        else {
            throw XidError.idTokenDecodeFailed("payload JSON 解析失败")
        }
        return claims
    }

    static func decodeUser(_ idToken: String) throws -> XidUser {
        let claims = try decodePayload(idToken)
        return try user(from: claims)
    }

    static func user(from claims: [String: Any]) throws -> XidUser {
        guard let sub = claims["sub"] as? String else {
            throw XidError.idTokenDecodeFailed("缺少 sub claim")
        }
        return XidUser(
            sub: sub,
            email: claims["email"] as? String,
            emailVerified: claims["email_verified"] as? Bool,
            name: claims["name"] as? String,
            picture: claims["picture"] as? String
        )
    }
}