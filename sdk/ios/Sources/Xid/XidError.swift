// XidError.swift
// XID iOS Swift SDK
// Status: implemented; compiled and unit-tested locally, real IdP round-trip pending

import Foundation

/// SDK 统一错误类型。
public enum XidError: Error, LocalizedError, Sendable {
    /// SDK 未初始化,需要先调用 Xid.configure(options:)。
    case notConfigured

    /// PKCE code_verifier/code_challenge 生成失败。
    case pkceGenerationFailed(String)

    /// OIDC Discovery 文档加载失败。
    case discoveryFailed(String)

    /// authorization code 换 token 失败。
    case tokenExchangeFailed(String)

    /// 服务端返回 OAuth 错误响应 (RFC 6749 Section 5.2)。
    case oauthError(String, String?)

    /// ASWebAuthenticationSession 被用户取消或发生错误。
    case authSessionCancelled

    /// 回调 URL 格式错误或缺少必要参数。
    case invalidCallbackURL(String)

    /// state 参数不匹配 (CSRF 防护)。
    case stateMismatch

    /// id token 解码失败。
    case idTokenDecodeFailed(String)

    /// id token JWKS 验签失败。
    case idTokenVerificationFailed(String)

    /// JWKS 拉取或解析失败。
    case jwksFetchFailed(String)

    /// /userinfo 请求失败。
    case userInfoFetchFailed(String)

    /// /auth/guest 匿名登录或随后的 /v1/me 请求失败。
    case guestSignInFailed(String)

    /// /end_session 请求失败。
    case endSessionFailed(String)

    /// token 安全存储操作失败。
    case tokenStorageError(String)

    /// 当前无有效 session (未登录或 token 全部过期)。
    case noActiveSession

    public var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "XID SDK 未初始化。请先调用 Xid.configure(options:)。"
        case .pkceGenerationFailed(let reason):
            return "PKCE 生成失败: \(reason)"
        case .discoveryFailed(let reason):
            return "OIDC Discovery 加载失败: \(reason)"
        case .tokenExchangeFailed(let reason):
            return "Token 换取失败: \(reason)"
        case .oauthError(let code, let description):
            return "OAuth 错误 [\(code)]: \(description ?? "无详情")"
        case .authSessionCancelled:
            return "用户取消了登录。"
        case .invalidCallbackURL(let reason):
            return "回调 URL 无效: \(reason)"
        case .stateMismatch:
            return "OAuth state 不匹配,请求可能被篡改。"
        case .idTokenDecodeFailed(let reason):
            return "ID Token 解码失败: \(reason)"
        case .idTokenVerificationFailed(let reason):
            return "ID Token 验签失败: \(reason)"
        case .jwksFetchFailed(let reason):
            return "JWKS 拉取失败: \(reason)"
        case .userInfoFetchFailed(let reason):
            return "UserInfo 获取失败: \(reason)"
        case .guestSignInFailed(let reason):
            return "匿名登录失败: \(reason)"
        case .endSessionFailed(let reason):
            return "End Session 失败: \(reason)"
        case .tokenStorageError(let reason):
            return "Token 存储错误: \(reason)"
        case .noActiveSession:
            return "当前无有效会话,请重新登录。"
        }
    }
}
