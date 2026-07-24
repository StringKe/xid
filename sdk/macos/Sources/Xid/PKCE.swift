// PKCE.swift
// XID macOS Swift SDK
// MIT
//
// PKCE S256 implementation (RFC 7636).
// Uses CryptoKit (SHA256) + SecRandomCopyBytes only - no third-party dependencies.

import CryptoKit
import Foundation

/// PKCE code_verifier and code_challenge pair.
/// Only S256 is supported; XID server rejects `plain`.
struct PKCE {
    let verifier: String
    let challenge: String
    let method = "S256"

    /// Generates a random code_verifier (32 random bytes -> 43-char Base64URL, RFC 7636 Section 4.1).
    init() throws {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            throw XidError.pkceGenerationFailed("SecRandomCopyBytes failed: OSStatus \(status)")
        }

        let verifierStr = Data(bytes).base64URLEncodedString()
        self.verifier = verifierStr

        // code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))
        let digest = SHA256.hash(data: Data(verifierStr.utf8))
        self.challenge = Data(digest).base64URLEncodedString()
    }
}

// MARK: - Data Base64URL extension

extension Data {
    /// Base64URL encoding without padding (RFC 4648 Section 5).
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
