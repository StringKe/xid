// TokenStorage.swift
// XID iOS Swift SDK
// Status: implemented; compiled and unit-tested locally, real IdP round-trip pending

import Foundation
import Security

// MARK: - TokenStorageAdapter 协议

/// Token 持久化适配器协议。实现此协议以接入企业自有 Keychain 策略或自定义存储。
public protocol TokenStorageAdapter: Sendable {
    func save(key: String, value: String) throws
    func load(key: String) throws -> String?
    func delete(key: String) throws
}

struct StoredTokenSet: Codable, Sendable {
    let accessToken: String
    let refreshToken: String?
    let idToken: String?
    let expiresAt: Date
}

enum TokenSessionStorage {
    private struct SessionRecord: Codable {
        let state: SessionState
        let session: StoredTokenSet?
    }

    private enum SessionState: String, Codable {
        case active
        case refreshPending = "refresh_pending"
    }

    static func load(storage: TokenStorageAdapter) throws -> StoredTokenSet? {
        guard let value = try storage.load(key: StorageKey.session) else {
            return try loadLegacy(storage: storage)
        }

        guard let data = value.data(using: .utf8) else {
            try clear(storage: storage)
            return nil
        }

        if let record = try? JSONDecoder().decode(SessionRecord.self, from: data) {
            guard record.state == .active else {
                return nil
            }
            guard let session = record.session else {
                try clear(storage: storage)
                return nil
            }
            return session
        }

        if let session = try? JSONDecoder().decode(StoredTokenSet.self, from: data) {
            return session
        }

        try clear(storage: storage)
        return nil
    }

    static func save(_ session: StoredTokenSet, storage: TokenStorageAdapter) throws {
        let record = SessionRecord(state: .active, session: session)
        let data = try JSONEncoder().encode(record)
        guard let value = String(data: data, encoding: .utf8) else {
            throw XidError.tokenStorageError("无法将会话转换为 UTF-8 数据")
        }
        try storage.save(key: StorageKey.session, value: value)
    }

    static func markRefreshPending(storage: TokenStorageAdapter) throws {
        let record = SessionRecord(state: .refreshPending, session: nil)
        let data = try JSONEncoder().encode(record)
        guard let value = String(data: data, encoding: .utf8) else {
            throw XidError.tokenStorageError("无法将刷新状态转换为 UTF-8 数据")
        }
        try storage.save(key: StorageKey.session, value: value)
    }

    static func isRefreshPending(storage: TokenStorageAdapter) throws -> Bool {
        guard let value = try storage.load(key: StorageKey.session),
              let data = value.data(using: .utf8),
              let record = try? JSONDecoder().decode(SessionRecord.self, from: data)
        else {
            return false
        }
        return record.state == .refreshPending
    }

    static func clear(storage: TokenStorageAdapter) throws {
        try markRefreshPending(storage: storage)
        for key in StorageKey.legacySessionKeys {
            try storage.delete(key: key)
        }
    }

    private static func loadLegacy(storage: TokenStorageAdapter) throws -> StoredTokenSet? {
        guard let accessToken = try storage.load(key: StorageKey.accessToken),
              let expiresAtValue = try storage.load(key: StorageKey.expiresAt)
        else {
            return nil
        }
        let formatter = ISO8601DateFormatter()
        guard let expiresAt = formatter.date(from: expiresAtValue) else {
            return nil
        }
        return StoredTokenSet(
            accessToken: accessToken,
            refreshToken: try storage.load(key: StorageKey.refreshToken),
            idToken: try storage.load(key: StorageKey.idToken),
            expiresAt: expiresAt
        )
    }
}

// MARK: - Keychain 存储(默认实现)

/// 基于 iOS Keychain 的 token 安全存储。
/// 使用 kSecClassGenericPassword + kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly。
public struct KeychainTokenStorage: TokenStorageAdapter {
    private let service: String

    public init(service: String = "dev.xid.sdk.tokens") {
        self.service = service
    }

    public func save(key: String, value: String) throws {
        guard let data = value.data(using: .utf8) else {
            throw XidError.tokenStorageError("无法将 token 转换为 UTF-8 数据")
        }

        // 先尝试更新,若不存在则添加
        let query = baseQuery(key: key)
        let updateAttributes: [CFString: Any] = [
            kSecValueData: data,
        ]

        let updateStatus = SecItemUpdate(query as CFDictionary, updateAttributes as CFDictionary)
        if updateStatus == errSecItemNotFound {
            var addQuery = query
            addQuery[kSecValueData as String] = data
            addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw XidError.tokenStorageError("Keychain add 失败: OSStatus \(addStatus)")
            }
        } else if updateStatus != errSecSuccess {
            throw XidError.tokenStorageError("Keychain update 失败: OSStatus \(updateStatus)")
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
            throw XidError.tokenStorageError("Keychain read 失败: OSStatus \(status)")
        }
        guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            throw XidError.tokenStorageError("Keychain 数据解码失败")
        }
        return value
    }

    public func delete(key: String) throws {
        let query = baseQuery(key: key)
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw XidError.tokenStorageError("Keychain delete 失败: OSStatus \(status)")
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

// MARK: - Storage Key 常量

enum StorageKey {
    static let session = "xid.session"
    static let guestSession = "xid.guest_session"
    static let accessToken = "xid.access_token"
    static let refreshToken = "xid.refresh_token"
    static let idToken = "xid.id_token"
    static let expiresAt = "xid.expires_at"
    static func pendingAuthorization(state: String) -> String {
        "xid.pending_authorization.\(state)"
    }
    static let legacySessionKeys = [accessToken, refreshToken, idToken, expiresAt]
}

enum PendingAuthorizationStorage {
    private static let lock = NSLock()

    static func save(
        state: String,
        verifier: String,
        storage: TokenStorageAdapter
    ) throws {
        lock.lock()
        defer { lock.unlock() }
        try storage.save(key: StorageKey.pendingAuthorization(state: state), value: verifier)
    }

    static func consume(
        state: String,
        storage: TokenStorageAdapter
    ) throws -> String? {
        lock.lock()
        defer { lock.unlock() }

        let key = StorageKey.pendingAuthorization(state: state)
        guard let verifier = try storage.load(key: key) else {
            return nil
        }
        try storage.delete(key: key)
        return verifier
    }

    static func clear(
        state: String,
        storage: TokenStorageAdapter
    ) throws {
        lock.lock()
        defer { lock.unlock() }
        try storage.delete(key: StorageKey.pendingAuthorization(state: state))
    }
}
