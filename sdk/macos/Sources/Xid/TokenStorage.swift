// TokenStorage.swift
// XID macOS Swift SDK
// MIT

import Foundation
import Security

// MARK: - TokenStorageAdapter protocol

/// Token persistence adapter. Implement to plug in custom Keychain policy or storage.
public protocol TokenStorageAdapter: Sendable {
    func save(key: String, value: String) throws
    func load(key: String) throws -> String?
    func delete(key: String) throws
}

// MARK: - KeychainTokenStorage (default)

/// macOS Keychain-backed token storage.
/// Uses kSecClassGenericPassword + kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly.
public struct KeychainTokenStorage: TokenStorageAdapter {
    private let service: String

    public init(service: String = "dev.xid.sdk.tokens") {
        self.service = service
    }

    public func save(key: String, value: String) throws {
        guard let data = value.data(using: .utf8) else {
            throw XidError.tokenStorageError("Cannot encode token as UTF-8")
        }

        let query = baseQuery(key: key)
        let updateAttrs: [CFString: Any] = [kSecValueData: data]

        let updateStatus = SecItemUpdate(query as CFDictionary, updateAttrs as CFDictionary)
        if updateStatus == errSecItemNotFound {
            var addQuery = query
            addQuery[kSecValueData as String] = data
            addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw XidError.tokenStorageError("Keychain add failed: OSStatus \(addStatus)")
            }
        } else if updateStatus != errSecSuccess {
            throw XidError.tokenStorageError("Keychain update failed: OSStatus \(updateStatus)")
        }
    }

    public func load(key: String) throws -> String? {
        var query = baseQuery(key: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw XidError.tokenStorageError("Keychain read failed: OSStatus \(status)")
        }
        guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            throw XidError.tokenStorageError("Keychain data decode failed")
        }
        return value
    }

    public func delete(key: String) throws {
        let query = baseQuery(key: key)
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw XidError.tokenStorageError("Keychain delete failed: OSStatus \(status)")
        }
    }

    private func baseQuery(key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }
}

// MARK: - Storage key constants

enum StorageKey {
    static let accessToken = "xid.access_token"
    static let refreshToken = "xid.refresh_token"
    static let idToken = "xid.id_token"
    static let expiresAt = "xid.expires_at"
    // code_verifier is stored only during the PKCE flow; deleted immediately after the callback
    static let pkceVerifier = "xid.pkce_verifier"
    static let oauthState = "xid.oauth_state"
}
