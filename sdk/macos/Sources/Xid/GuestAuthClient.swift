// GuestAuthClient.swift
// XID macOS Swift SDK
// MIT
//
// Anonymous (guest) sign-in: POST {issuer}/auth/guest, then GET {issuer}/v1/me.
// Guests hold no tokens; the session credential is the worker-issued cookie,
// so the client captures Set-Cookie and replays it as a Cookie header.

import Foundation

struct GuestAuthClient: Sendable {
    private let urlSession: URLSession

    init(urlSession: URLSession = .shared) {
        self.urlSession = urlSession
    }

    /// POST /auth/guest. Returns the session cookies as a Cookie header value.
    /// 200 renews an existing guest session, 201 mints a new one; both establish
    /// the session via Set-Cookie, so the status code is not branched on.
    func signIn(issuer: URL, turnstileToken: String?) async throws -> String {
        let guestURL = issuer.appendingPathComponent("/auth/guest")
        var request = URLRequest(url: guestURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(GuestRequestBody(turnstileToken: turnstileToken))

        let (data, response) = try await urlSession.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw XidError.anonymousSignInFailed("Invalid response type")
        }
        guard httpResponse.statusCode == 200 || httpResponse.statusCode == 201 else {
            throw XidError.anonymousSignInFailed("HTTP \(httpResponse.statusCode)")
        }
        _ = data

        guard let cookieHeader = sessionCookieHeader(for: guestURL, response: httpResponse) else {
            throw XidError.anonymousSignInFailed("Response carried no session cookie")
        }
        return cookieHeader
    }

    /// GET /v1/me with the captured session cookie. Maps the wire `user` object
    /// onto XidUser; `id` becomes `sub`, `imageUrl` becomes `picture`.
    func fetchUser(issuer: URL, sessionCookie: String) async throws -> XidUser {
        var request = URLRequest(url: issuer.appendingPathComponent("/v1/me"))
        request.httpMethod = "GET"
        request.setValue(sessionCookie, forHTTPHeaderField: "Cookie")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await urlSession.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw XidError.anonymousSignInFailed("Invalid response type")
        }
        guard httpResponse.statusCode == 200 else {
            throw XidError.anonymousSignInFailed("/v1/me HTTP \(httpResponse.statusCode)")
        }

        guard let me = try? JSONDecoder().decode(MeResponse.self, from: data), let wire = me.user else {
            throw XidError.anonymousSignInFailed("/v1/me carried no user")
        }
        return XidUser(
            sub: wire.id,
            email: wire.email,
            emailVerified: wire.emailVerified,
            name: wire.name,
            picture: wire.imageUrl,
            provisionedBy: wire.provisionedBy
        )
    }

    /// Removes cookies the URLSession jar holds for the issuer domain, so a later
    /// guest sign-in cannot silently renew the signed-out session.
    func clearCookies(for issuer: URL) {
        guard let storage = urlSession.configuration.httpCookieStorage,
              let host = issuer.host
        else { return }
        for cookie in storage.cookies ?? [] where cookie.domain.hasSuffix(host) {
            storage.deleteCookie(cookie)
        }
    }

    // Prefers the URLSession cookie jar (correct multi-cookie parsing); falls back to
    // the raw Set-Cookie header for sessions whose protocol classes bypass the jar.
    private func sessionCookieHeader(for url: URL, response: HTTPURLResponse) -> String? {
        if let cookies = urlSession.configuration.httpCookieStorage?.cookies(for: url),
           !cookies.isEmpty
        {
            return cookies.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
        }
        guard let setCookie = response.allHeaderFields["Set-Cookie"] as? String else {
            return nil
        }
        return setCookie
            .split(separator: ";")
            .first
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .flatMap { $0.isEmpty ? nil : $0 }
    }
}

private struct GuestRequestBody: Encodable {
    let turnstileToken: String?

    // Synthesized Encodable drops nil optionals; the /auth/guest contract expects
    // an explicit `"turnstileToken": null` (same wire shape as the web client).
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(turnstileToken, forKey: .turnstileToken)
    }

    private enum CodingKeys: String, CodingKey {
        case turnstileToken
    }
}

private struct MeResponse: Decodable {
    let user: MeUser?
}

private struct MeUser: Decodable {
    let id: String
    let email: String?
    let emailVerified: Bool?
    let name: String?
    let imageUrl: String?
    let provisionedBy: String?

    private enum CodingKeys: String, CodingKey {
        case id
        case email
        case emailVerified
        case name
        case imageUrl
        case provisionedBy = "provisioned_by"
    }
}
