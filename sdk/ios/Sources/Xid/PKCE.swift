// PKCE.swift
// XID iOS Swift SDK
// Status: implemented; compiled and unit-tested locally, real IdP round-trip pending
//
// PKCE S256 实现 (RFC 7636)。
// 仅使用 CryptoKit (SHA256) + 系统 SecRandomCopyBytes,无第三方依赖。

import CryptoKit
import Foundation

/// PKCE code_verifier 与 code_challenge 生成。
/// 算法:S256 (SHA-256),为唯一支持的方式;XID 服务端拒绝 plain。
struct PKCE {
    let verifier: String
    let challenge: String
    let method = "S256"

    /// 生成随机 code_verifier (43-128 字符 Base64URL 编码,见 RFC 7636 Section 4.1)。
    init() throws {
        // 生成 32 字节随机数 -> 43 字符 Base64URL
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            throw XidError.pkceGenerationFailed("SecRandomCopyBytes 失败: OSStatus \(status)")
        }

        let verifierStr = Data(bytes).base64URLEncodedString()
        self.verifier = verifierStr

        // code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))
        let digest = SHA256.hash(data: Data(verifierStr.utf8))
        self.challenge = Data(digest).base64URLEncodedString()
    }
}

// MARK: - Data Base64URL 扩展

extension Data {
    /// Base64URL 编码 (无填充,见 RFC 4648 Section 5)。
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
