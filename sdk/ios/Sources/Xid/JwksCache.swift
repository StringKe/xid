// JwksCache.swift
// XID iOS Swift SDK
//
// JWKS fetch and in-memory cache keyed by kid. Refreshes on TTL expiry or kid miss.

import CryptoKit
import Foundation
import Security

// MARK: - JWKS models

struct JwksDocument: Decodable, Sendable {
    let keys: [JwkEntry]
}

struct JwkEntry: Decodable, Sendable {
    let kid: String?
    let kty: String
    let alg: String?
    let use: String?
    let crv: String?
    let x: String?
    let y: String?
    let n: String?
    let e: String?
}

// MARK: - Verifying key handle

enum VerifyingPublicKey: Sendable {
    case ecP256(P256SigningPublicKeyHandle)
    case rsa(RSASigningPublicKeyHandle)
}

/// Type-erased P-256 public key for Sendable conformance across actor boundaries.
struct P256SigningPublicKeyHandle: Sendable {
    let x963Representation: Data

    func isValidSignature(_ signature: Data, for data: Data) -> Bool {
        guard let publicKey = try? P256SigningPublicKey(x963Representation: x963Representation),
              let ecdsaSignature = try? P256SigningECDSASignature(rawRepresentation: signature)
        else {
            return false
        }
        return publicKey.isValidSignature(ecdsaSignature, for: data)
    }
}

/// Type-erased RSA SecKey representation for Sendable conformance.
struct RSASigningPublicKeyHandle: Sendable {
    let keyData: Data

    func isValidSignature(_ signature: Data, for data: Data) -> Bool {
        var error: Unmanaged<CFError>?
        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
            kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
        ]
        guard let secKey = SecKeyCreateWithData(keyData as CFData, attributes as CFDictionary, &error) else {
            return false
        }
        return SecKeyVerifySignature(
            secKey,
            .rsaSignatureMessagePKCS1v15SHA256,
            data as CFData,
            signature as CFData,
            &error
        )
    }
}

// MARK: - CryptoKit typealiases (keeps JwksCache readable)

private typealias P256SigningPublicKey = P256.Signing.PublicKey
private typealias P256SigningECDSASignature = P256.Signing.ECDSASignature

// MARK: - JWKS cache

/// Fetches and caches JWKS public keys by `kid`.
/// Default TTL: 3600 seconds (aligned with server KV JWKS cache).
actor JwksCache {
    private var keys: [String: (VerifyingPublicKey, String)] = [:]
    private var fetchedAt: Date?
    private let jwksUri: URL
    private let ttl: TimeInterval
    private let urlSession: URLSession

    init(jwksUri: URL, ttl: TimeInterval = 3600, urlSession: URLSession = .shared) {
        self.jwksUri = jwksUri
        self.ttl = ttl
        self.urlSession = urlSession
    }

    /// Returns the verifying key and resolved algorithm for `kid`.
    /// Refreshes JWKS when stale or when `kid` is missing (key rotation).
    func publicKey(for kid: String) async throws -> (VerifyingPublicKey, String) {
        if !isStale, let cached = keys[kid] {
            return cached
        }

        try await refresh()

        if let cached = keys[kid] {
            return cached
        }

        // kid miss after refresh — force one more fetch (rotation race).
        try await refresh(force: true)

        guard let cached = keys[kid] else {
            throw XidError.jwksFetchFailed("JWKS 中未找到 kid=\(kid) 对应的公钥")
        }
        return cached
    }

    /// Test hook: inject keys without a network fetch.
    func replaceKeysForTesting(_ newKeys: [String: (VerifyingPublicKey, String)]) {
        keys = newKeys
        fetchedAt = Date()
    }

    func invalidate() {
        keys = [:]
        fetchedAt = nil
    }

    // MARK: - Private

    private var isStale: Bool {
        guard let fetchedAt else { return true }
        return Date().timeIntervalSince(fetchedAt) >= ttl
    }

    private func refresh(force: Bool = false) async throws {
        if !force, !isStale, !keys.isEmpty {
            return
        }

        let (data, response) = try await urlSession.data(from: jwksUri)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw XidError.jwksFetchFailed("JWKS 请求非 200: \(jwksUri)")
        }

        let document: JwksDocument
        do {
            document = try JSONDecoder().decode(JwksDocument.self, from: data)
        } catch {
            throw XidError.jwksFetchFailed("JWKS JSON 解析失败: \(error.localizedDescription)")
        }

        var parsed: [String: (VerifyingPublicKey, String)] = [:]
        for entry in document.keys {
            guard let kid = entry.kid, !kid.isEmpty else { continue }
            guard entry.use == nil || entry.use == "sig" else { continue }

            if let key = try? JwkParser.parse(entry) {
                parsed[kid] = key
            }
        }

        keys = parsed
        fetchedAt = Date()
    }
}

// MARK: - JWK parsing

private enum JwkParser {
    private static let supportedAlgorithms: Set<String> = ["ES256", "RS256", "PS256"]

    static func parse(_ entry: JwkEntry) throws -> (VerifyingPublicKey, String) {
        switch entry.kty {
        case "EC":
            return try parseEC(entry)
        case "RSA":
            return try parseRSA(entry)
        default:
            throw XidError.jwksFetchFailed("不支持的 JWK kty: \(entry.kty)")
        }
    }

    private static func parseEC(_ entry: JwkEntry) throws -> (VerifyingPublicKey, String) {
        guard entry.crv == "P-256",
              let xStr = entry.x,
              let yStr = entry.y,
              let x = JWTBase64.urlDecode(xStr),
              let y = JWTBase64.urlDecode(yStr)
        else {
            throw XidError.jwksFetchFailed("EC JWK 字段不完整")
        }

        var raw = Data([0x04])
        raw.append(x)
        raw.append(y)

        let alg = resolvedAlgorithm(entry.alg, defaultAlg: "ES256")
        let handle = P256SigningPublicKeyHandle(x963Representation: raw)
        return (.ecP256(handle), alg)
    }

    private static func parseRSA(_ entry: JwkEntry) throws -> (VerifyingPublicKey, String) {
        guard let nStr = entry.n,
              let eStr = entry.e,
              let modulus = JWTBase64.urlDecode(nStr),
              let exponent = JWTBase64.urlDecode(eStr)
        else {
            throw XidError.jwksFetchFailed("RSA JWK 字段不完整")
        }

        let der = try RSAPublicKeyDER.encode(modulus: modulus, exponent: exponent)
        let alg = resolvedAlgorithm(entry.alg, defaultAlg: "RS256")
        let handle = RSASigningPublicKeyHandle(keyData: der)
        return (.rsa(handle), alg)
    }

    private static func resolvedAlgorithm(_ alg: String?, defaultAlg: String) -> String {
        guard let alg, supportedAlgorithms.contains(alg) else { return defaultAlg }
        return alg
    }
}

// MARK: - RSA public key DER encoder

private enum RSAPublicKeyDER {
    static func encode(modulus: Data, exponent: Data) throws -> Data {
        let modulusInteger = asn1Integer(modulus)
        let exponentInteger = asn1Integer(exponent)
        let rsaPublicKey = asn1Sequence(modulusInteger + exponentInteger)
        let algorithmIdentifier = asn1Sequence(
            asn1ObjectIdentifier([1, 2, 840, 11_354, 1, 1, 1]) + asn1Null()
        )
        let bitString = asn1BitString(rsaPublicKey)
        return asn1Sequence(algorithmIdentifier + bitString)
    }

    private static func asn1Integer(_ value: Data) -> Data {
        var bytes = [UInt8](value)
        if bytes.isEmpty {
            bytes = [0]
        }
        if bytes[0] & 0x80 != 0 {
            bytes.insert(0, at: 0)
        }
        return Data([0x02]) + asn1Length(bytes.count) + Data(bytes)
    }

    private static func asn1Null() -> Data {
        Data([0x05, 0x00])
    }

    private static func asn1ObjectIdentifier(_ oid: [Int]) -> Data {
        guard oid.count >= 2 else { return Data() }
        var encoded = Data([UInt8(oid[0] * 40 + oid[1])])
        for component in oid.dropFirst(2) {
            encoded.append(contentsOf: encodeOIDComponent(component))
        }
        return Data([0x06]) + asn1Length(encoded.count) + encoded
    }

    private static func encodeOIDComponent(_ value: Int) -> [UInt8] {
        guard value != 0 else { return [0] }
        var result: [UInt8] = []
        var component = value
        var stack: [UInt8] = [UInt8(component & 0x7F)]
        component >>= 7
        while component > 0 {
            stack.insert(UInt8(0x80 | (component & 0x7F)), at: 0)
            component >>= 7
        }
        result.append(contentsOf: stack)
        return result
    }

    private static func asn1BitString(_ value: Data) -> Data {
        let contents = Data([0x00]) + value
        return Data([0x03]) + asn1Length(contents.count) + contents
    }

    private static func asn1Sequence(_ value: Data) -> Data {
        Data([0x30]) + asn1Length(value.count) + value
    }

    private static func asn1Length(_ length: Int) -> Data {
        guard length < 0x80 else {
            var len = length
            var bytes: [UInt8] = []
            while len > 0 {
                bytes.insert(UInt8(len & 0xFF), at: 0)
                len >>= 8
            }
            return Data([0x80 | UInt8(bytes.count)]) + Data(bytes)
        }
        return Data([UInt8(length)])
    }
}