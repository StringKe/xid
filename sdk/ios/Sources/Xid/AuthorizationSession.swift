// AuthorizationSession.swift
// XID iOS Swift SDK
//
// 封装 ASWebAuthenticationSession,启动系统浏览器完成 OIDC Authorization Code 流程。

import AuthenticationServices
import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// 封装 ASWebAuthenticationSession 的 async/await 接口。
@MainActor
final class AuthorizationSession: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    /// 启动授权会话,返回回调 URL。
    /// - Parameters:
    ///   - authorizationURL: /authorize 端点 URL(含所有 query 参数)
    ///   - callbackScheme: redirect URI 的 scheme (custom scheme) 或 nil (universal link)
    ///   - prefersEphemeral: 是否使用独立浏览器会话(false 时共享 cookie 以支持 SSO)
    func start(
        authorizationURL: URL,
        callbackScheme: String?,
        prefersEphemeral: Bool = true
    ) async throws -> URL {
        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: authorizationURL,
                callbackURLScheme: callbackScheme
            ) { callbackURL, error in
                if let error = error {
                    if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
                        continuation.resume(throwing: XidError.authSessionCancelled)
                    } else {
                        continuation.resume(throwing: XidError.tokenExchangeFailed(error.localizedDescription))
                    }
                    return
                }
                guard let callbackURL else {
                    continuation.resume(throwing: XidError.invalidCallbackURL("回调 URL 为空"))
                    return
                }
                continuation.resume(returning: callbackURL)
            }
            session.prefersEphemeralWebBrowserSession = prefersEphemeral
            session.presentationContextProvider = self
            self.session = session
            session.start()
        }
    }

    func cancel() {
        session?.cancel()
        session = nil
    }

    // MARK: - ASWebAuthenticationPresentationContextProviding

    @MainActor
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if canImport(UIKit)
        return Self.resolvePresentationAnchor()
        #else
        return ASPresentationAnchor()
        #endif
    }

    #if canImport(UIKit)
    /// 在 multiple scene / SwiftUI 场景下查找当前前台 window。
    static func resolvePresentationAnchor() -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .sorted { lhs, rhs in
                lhs.activationState == .foregroundActive && rhs.activationState != .foregroundActive
            }

        for scene in scenes {
            if let keyWindow = scene.windows.first(where: { $0.isKeyWindow }) {
                return keyWindow
            }
            if let visibleWindow = scene.windows.first(where: { !$0.isHidden && $0.alpha > 0 }) {
                return visibleWindow
            }
        }

        return ASPresentationAnchor()
    }
    #endif
}

// MARK: - Authorization URL 构造

struct AuthorizationURLBuilder {
    static func build(
        authorizationEndpoint: URL,
        clientId: String,
        redirectUri: URL,
        scopes: [String],
        pkce: PKCE,
        state: String,
        additionalParams: [String: String] = [:]
    ) -> URL? {
        var components = URLComponents(url: authorizationEndpoint, resolvingAgainstBaseURL: true)

        var queryItems: [URLQueryItem] = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "redirect_uri", value: redirectUri.absoluteString),
            URLQueryItem(name: "scope", value: scopes.joined(separator: " ")),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: pkce.challenge),
            URLQueryItem(name: "code_challenge_method", value: pkce.method),
        ]

        for (key, value) in additionalParams {
            queryItems.append(URLQueryItem(name: key, value: value))
        }

        components?.queryItems = queryItems
        return components?.url
    }
}