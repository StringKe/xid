// GuestAuthClient.swift
// XID iOS Swift SDK
//
// Firebase 式匿名登录 (GET /auth/config?intent=sign-up +
// POST /auth/guest + GET /v1/me)。
// guest 会话没有 access token,会话凭证是服务端 Set-Cookie 的 session cookie:
// 原生端没有浏览器 cookie jar,必须自行捕获、持久化并在后续请求上回放。

import Foundation

/// /auth/guest 的响应:sessionId + 捕获到的会话 cookie。
struct GuestAuthResult: Sendable {
    let sessionId: String
    let cookies: [StoredGuestCookie]
}

struct GuestAuthClient: Sendable {
    private let urlSession: URLSession

    init(urlSession: URLSession = .shared) {
        self.urlSession = urlSession
    }

    /// 获取一次性 capability 后创建或续期 guest 会话。capability 不缓存,
    /// 服务端 200 续期、201 新建,本地无需区分。
    func createGuestSession(issuer: URL, turnstileToken: String?) async throws -> GuestAuthResult {
        let capabilityToken = try await fetchGuestCapability(issuer: issuer)
        let url = issuer.appendingPathComponent("auth").appendingPathComponent("guest")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // turnstileToken 仅当服务端启用 Turnstile 时才需要,native 端通常为 nil
        var body = ["capabilityToken": capabilityToken]
        if let turnstileToken {
            body["turnstileToken"] = turnstileToken
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await urlSession.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw XidError.guestSignInFailed("无效响应类型")
        }
        guard httpResponse.statusCode == 200 || httpResponse.statusCode == 201 else {
            throw XidError.guestSignInFailed("HTTP \(httpResponse.statusCode)")
        }

        guard
            let json = try? JSONSerialization.jsonObject(with: data),
            let object = json as? [String: Any],
            let sessionId = object["sessionId"] as? String
        else {
            throw XidError.guestSignInFailed("响应缺少 sessionId")
        }

        return GuestAuthResult(
            sessionId: sessionId,
            cookies: Self.captureCookies(from: httpResponse)
        )
    }

    private func fetchGuestCapability(issuer: URL) async throws -> String {
        var components = URLComponents(
            url: issuer.appendingPathComponent("auth").appendingPathComponent("config"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "intent", value: "sign-up")]
        guard let url = components?.url else {
            throw XidError.guestSignInFailed("无法构造访客登录能力 URL")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await urlSession.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw XidError.guestSignInFailed("无效响应类型")
        }
        guard httpResponse.statusCode == 200 else {
            throw XidError.guestSignInFailed("/auth/config HTTP \(httpResponse.statusCode)")
        }
        guard
            let json = try? JSONSerialization.jsonObject(with: data),
            let object = json as? [String: Any],
            let guest = object["guest"] as? [String: Any],
            let rawToken = guest["capabilityToken"] as? String,
            !rawToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            throw XidError.guestSignInFailed("访客登录能力不可用")
        }
        return rawToken
    }

    /// 用 guest 会话 cookie 调 /v1/me,响应的 user 对象含 provisioned_by。
    func fetchCurrentUser(issuer: URL, cookies: [StoredGuestCookie]) async throws -> XidUser {
        let url = issuer.appendingPathComponent("v1").appendingPathComponent("me")
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let cookieHeader = Self.cookieHeader(for: cookies)
        if !cookieHeader.isEmpty {
            request.setValue(cookieHeader, forHTTPHeaderField: "Cookie")
        }

        let (data, response) = try await urlSession.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw XidError.guestSignInFailed("无效响应类型")
        }
        guard httpResponse.statusCode == 200 else {
            throw XidError.guestSignInFailed("/v1/me HTTP \(httpResponse.statusCode)")
        }

        guard
            let json = try? JSONSerialization.jsonObject(with: data),
            let object = json as? [String: Any],
            let user = object["user"] as? [String: Any]
        else {
            throw XidError.guestSignInFailed("/v1/me 响应缺少 user 对象")
        }
        return try IDTokenDecoder.user(from: user)
    }

    /// 从未过期的 cookie 构造 Cookie 请求头;空字符串表示没有可回放的 cookie。
    static func cookieHeader(for cookies: [StoredGuestCookie]) -> String {
        let now = Date()
        return cookies
            .filter { cookie in
                guard let expiresAt = cookie.expiresAt else { return true }
                return expiresAt > now
            }
            .map { "\($0.name)=\($0.value)" }
            .joined(separator: "; ")
    }

    // MARK: - Set-Cookie 捕获

    private static func captureCookies(from response: HTTPURLResponse) -> [StoredGuestCookie] {
        guard let setCookie = response.value(forHTTPHeaderField: "Set-Cookie") else {
            return []
        }
        return splitSetCookieHeader(setCookie).compactMap { parseCookie($0) }
    }

    /// Foundation 会把多个 Set-Cookie 合并成一个逗号分隔字符串,而 Expires 日期本身含逗号,
    /// 不能直接按逗号切:逗号后若是一段「不含 = 的片段」则仍属于上一个 cookie 的日期。
    static func splitSetCookieHeader(_ header: String) -> [String] {
        var cookies: [String] = []
        var current = ""
        for segment in header.components(separatedBy: ",") {
            let head = segment.prefix(while: { $0 != ";" })
            if head.contains("="), !current.isEmpty {
                cookies.append(current.trimmingCharacters(in: .whitespaces))
                current = segment
            } else {
                current += current.isEmpty ? segment : "," + segment
            }
        }
        if !current.isEmpty {
            cookies.append(current.trimmingCharacters(in: .whitespaces))
        }
        return cookies
    }

    private static func parseCookie(_ string: String) -> StoredGuestCookie? {
        let parts = string.components(separatedBy: ";")
        guard let first = parts.first else { return nil }
        let pair = first.split(separator: "=", maxSplits: 1)
        guard pair.count == 2 else { return nil }
        let name = pair[0].trimmingCharacters(in: .whitespaces)
        let value = pair[1].trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return nil }

        var expiresAt: Date?
        for attribute in parts.dropFirst() {
            let kv = attribute.split(separator: "=", maxSplits: 1)
            guard kv.count == 2 else { continue }
            let key = kv[0].trimmingCharacters(in: .whitespaces).lowercased()
            let raw = kv[1].trimmingCharacters(in: .whitespaces)
            if key == "expires" {
                expiresAt = parseCookieDate(raw)
            } else if key == "max-age", let seconds = TimeInterval(raw) {
                expiresAt = Date().addingTimeInterval(seconds)
            }
        }
        return StoredGuestCookie(name: name, value: value, expiresAt: expiresAt)
    }

    private static func parseCookieDate(_ string: String) -> Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        // RFC 1123 是标准格式,RFC 850 与 asctime 是历史兼容格式
        let formats = [
            "EEE, dd MMM yyyy HH:mm:ss zzz",
            "EEEE, dd-MMM-yy HH:mm:ss zzz",
            "EEE MMM d HH:mm:ss yyyy",
        ]
        for format in formats {
            formatter.dateFormat = format
            if let date = formatter.date(from: string) {
                return date
            }
        }
        return nil
    }
}

// MARK: - Guest 会话持久化

struct StoredGuestCookie: Codable, Sendable {
    let name: String
    let value: String
    let expiresAt: Date?
}

struct StoredGuestSession: Codable, Sendable {
    let sessionId: String
    let cookies: [StoredGuestCookie]
    let user: XidUser
    /// 会话过期时间,取 cookie 中最早的过期时间。session cookie(无过期时间)时为 nil,
    /// 惰性复用视为有效:真实生命周期由服务端控制,本地不猜。
    let expiresAt: Date?
}

enum GuestSessionStorage {
    static func load(storage: TokenStorageAdapter) throws -> StoredGuestSession? {
        guard let value = try storage.load(key: StorageKey.guestSession) else {
            return nil
        }
        guard
            let data = value.data(using: .utf8),
            let session = try? JSONDecoder().decode(StoredGuestSession.self, from: data)
        else {
            try clear(storage: storage)
            return nil
        }
        if let expiresAt = session.expiresAt, expiresAt <= Date() {
            try clear(storage: storage)
            return nil
        }
        return session
    }

    static func save(_ session: StoredGuestSession, storage: TokenStorageAdapter) throws {
        let data = try JSONEncoder().encode(session)
        guard let value = String(data: data, encoding: .utf8) else {
            throw XidError.tokenStorageError("无法将 guest 会话转换为 UTF-8 数据")
        }
        try storage.save(key: StorageKey.guestSession, value: value)
    }

    static func clear(storage: TokenStorageAdapter) throws {
        try storage.delete(key: StorageKey.guestSession)
    }
}
