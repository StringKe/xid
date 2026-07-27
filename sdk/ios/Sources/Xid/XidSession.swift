// XidSession.swift
// XID iOS Swift SDK
// Status: implemented; compiled and unit-tested locally, real IdP round-trip pending

import Foundation

/// 用户会话快照。通过 Xid.shared.getSession() 获取。
public struct XidSession: Sendable, Codable {
    /// access token (JWT)。生命周期通常 1 小时。
    /// guest(匿名)会话没有 access token,为 nil;会话凭证由 SDK 持久化的 session cookie 承担。
    public let accessToken: String?

    /// refresh token。用于换取新 access token,生命周期由服务端配置(默认 7 天)。
    /// 存入 Keychain secure storage。
    public let refreshToken: String?

    /// id token (JWT)。包含用户身份声明。
    public let idToken: String

    /// access token 过期时间。
    public let expiresAt: Date

    /// 解码自 id token 的用户信息快照。
    public let user: XidUser

    /// access token 是否已过期。
    public var isExpired: Bool {
        expiresAt <= Date()
    }

    /// access token 是否即将过期(距过期不足 60 秒视为即将过期)。
    public var isNearExpiry: Bool {
        expiresAt <= Date().addingTimeInterval(60)
    }

    /// 是否匿名 guest 会话(provisioned_by == 'anonymous')。
    public var isAnonymous: Bool {
        user.isAnonymous
    }
}

/// 从 id token claims 或 /v1/me 解码的用户基础信息。
public struct XidUser: Sendable, Codable {
    public let sub: String
    public let email: String?
    public let emailVerified: Bool?
    public let name: String?
    public let picture: String?

    /// 用户来源。'anonymous' 表示匿名 guest 用户;正式用户为对应转正来源。
    public let provisionedBy: String?

    /// 是否匿名 guest 用户。guest 不可恢复(登出即丢失)、单设备,产品应引导转正。
    public var isAnonymous: Bool {
        provisionedBy == "anonymous"
    }

    private enum CodingKeys: String, CodingKey {
        case sub
        case email
        case emailVerified = "email_verified"
        case name
        case picture
        case provisionedBy = "provisioned_by"
    }
}
