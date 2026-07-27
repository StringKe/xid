// GuestAuthTests.swift
// XID macOS Swift SDK Tests
// MIT
//
// Anonymous (guest) sign-in tests. HTTP is mocked via MockURLProtocol;
// token persistence uses an in-memory TokenStorageAdapter.

import Foundation
import XCTest

@testable import Xid

// MARK: - MockURLProtocol

final class MockURLProtocol: URLProtocol {
    typealias Handler = (URLRequest) throws -> (HTTPURLResponse, Data)

    private static let lock = NSLock()
    private static var _handler: Handler?

    static var handler: Handler? {
        get { lock.withLock { _handler } }
        set { lock.withLock { _handler = newValue } }
    }

    static func mockedSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: config)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.unknown))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

// MARK: - In-memory token storage

final class InMemoryTokenStorage: TokenStorageAdapter, @unchecked Sendable {
    private var values: [String: String] = [:]

    func save(key: String, value: String) throws { values[key] = value }
    func load(key: String) throws -> String? { values[key] }
    func delete(key: String) throws { values.removeValue(forKey: key) }
}

// MARK: - Shared helpers

private final class RequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var _requests: [URLRequest] = []

    var requests: [URLRequest] {
        lock.withLock { _requests }
    }

    func record(_ request: URLRequest) {
        lock.withLock { _requests.append(request) }
    }
}

private func bodyData(of request: URLRequest) -> Data? {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var data = Data()
    let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 1024)
    defer { buffer.deallocate() }
    while stream.hasBytesAvailable {
        let count = stream.read(buffer, maxLength: 1024)
        guard count > 0 else { break }
        data.append(buffer, count: count)
    }
    return data
}

private func httpResponse(
    url: URL,
    status: Int,
    headers: [String: String]? = nil,
    json: String
) -> (HTTPURLResponse, Data) {
    let response = HTTPURLResponse(
        url: url, statusCode: status, httpVersion: nil, headerFields: headers
    )!
    return (response, Data(json.utf8))
}

// MARK: - GuestAuthTests

final class GuestAuthTests: XCTestCase {
    private let issuer = URL(string: "https://xid.test")!
    private var storage: InMemoryTokenStorage!
    private var recorder: RequestRecorder!

    override func setUp() {
        super.setUp()
        storage = InMemoryTokenStorage()
        recorder = RequestRecorder()
        Xid.shared.configure(
            options: XidConfiguration(
                issuer: issuer,
                clientId: "test_client",
                redirectUri: URL(string: "dev.xid.test://callback")!,
                tokenStorage: storage
            )
        )
        Xid.shared.guestAuthClient = GuestAuthClient(urlSession: MockURLProtocol.mockedSession())
    }

    override func tearDown() {
        MockURLProtocol.handler = nil
        Xid.shared.guestAuthClient = GuestAuthClient()
        storage = nil
        recorder = nil
        super.tearDown()
    }

    private func installGuestFlowHandler(
        guestStatus: Int = 201,
        setCookie: String? = "xid_session=abc123; Path=/; HttpOnly",
        meStatus: Int = 200
    ) {
        MockURLProtocol.handler = { [recorder] request in
            recorder?.record(request)
            switch request.url?.path {
            case "/auth/guest":
                var headers: [String: String] = [:]
                if let setCookie { headers["Set-Cookie"] = setCookie }
                return httpResponse(
                    url: request.url!, status: guestStatus, headers: headers,
                    json: #"{"sessionId":"sess_1"}"#
                )
            case "/v1/me":
                return httpResponse(
                    url: request.url!, status: meStatus,
                    json: #"{"user":{"id":"guest_1","email":null,"name":null,"imageUrl":null,"provisioned_by":"anonymous"}}"#
                )
            default:
                return httpResponse(url: request.url!, status: 404, json: "{}")
            }
        }
    }

    func testSignInAnonymouslyCreatesGuestSession() async throws {
        installGuestFlowHandler()

        let session = try await Xid.shared.signInAnonymously()

        XCTAssertTrue(session.isAnonymous)
        XCTAssertTrue(session.user.isAnonymous)
        XCTAssertEqual(session.user.sub, "guest_1")
        XCTAssertEqual(session.user.provisionedBy, "anonymous")
        XCTAssertNil(session.accessToken)
        XCTAssertNil(session.idToken)

        // Guest request shape: POST /auth/guest with JSON body
        let guestRequest = recorder.requests.first { $0.url?.path == "/auth/guest" }
        XCTAssertNotNil(guestRequest)
        XCTAssertEqual(guestRequest?.httpMethod, "POST")
        XCTAssertEqual(
            guestRequest?.value(forHTTPHeaderField: "Content-Type"), "application/json"
        )
        let body = bodyData(of: guestRequest!)
        XCTAssertNotNil(body)
        let bodyObject = try JSONSerialization.jsonObject(with: body!) as? [String: Any]
        XCTAssertTrue(bodyObject?.keys.contains("turnstileToken") ?? false)

        // /v1/me must carry the captured session cookie
        let meRequest = recorder.requests.first { $0.url?.path == "/v1/me" }
        XCTAssertEqual(meRequest?.httpMethod, "GET")
        XCTAssertEqual(
            meRequest?.value(forHTTPHeaderField: "Cookie"), "xid_session=abc123"
        )

        // Session credential and user snapshot are persisted
        let storedCookie = try storage.load(key: StorageKey.guestSessionCookie)
        XCTAssertEqual(storedCookie, "xid_session=abc123")
        XCTAssertNotNil(try storage.load(key: StorageKey.guestUser))
    }

    func testSignInAnonymouslyForwardsTurnstileToken() async throws {
        installGuestFlowHandler()

        _ = try await Xid.shared.signInAnonymously(turnstileToken: "tok_123")

        let guestRequest = recorder.requests.first { $0.url?.path == "/auth/guest" }!
        let bodyObject = try JSONSerialization.jsonObject(with: bodyData(of: guestRequest)!)
            as? [String: Any]
        XCTAssertEqual(bodyObject?["turnstileToken"] as? String, "tok_123")
    }

    func testSignInAnonymouslyRenewStatus200Accepted() async throws {
        installGuestFlowHandler(guestStatus: 200)

        let session = try await Xid.shared.signInAnonymously()
        XCTAssertTrue(session.isAnonymous)
    }

    func testSignInAnonymouslyLazyReusesGuestSession() async throws {
        installGuestFlowHandler()

        let first = try await Xid.shared.signInAnonymously()
        let second = try await Xid.shared.signInAnonymously()

        XCTAssertEqual(first.user.sub, second.user.sub)
        // Only the first call hits the network: 1 guest POST + 1 /v1/me
        XCTAssertEqual(recorder.requests.count, 2)
    }

    func testSignInAnonymouslyLazyWhenTokenSessionExists() async throws {
        let future = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))
        try storage.save(key: StorageKey.accessToken, value: "existing_access_token")
        try storage.save(key: StorageKey.expiresAt, value: future)

        MockURLProtocol.handler = { request in
            XCTFail("No request expected when a token session exists: \(request)")
            return httpResponse(url: request.url!, status: 500, json: "{}")
        }

        let session = try await Xid.shared.signInAnonymously()
        XCTAssertEqual(session.accessToken, "existing_access_token")
        XCTAssertFalse(session.isAnonymous)
        XCTAssertEqual(recorder.requests.count, 0)
    }

    func testSignInAnonymouslyServerErrorThrows() async throws {
        installGuestFlowHandler(guestStatus: 500)

        await XCTAssertThrowsAnonymousError {
            try await Xid.shared.signInAnonymously()
        }
        XCTAssertNil(try storage.load(key: StorageKey.guestSessionCookie))
        XCTAssertNil(try storage.load(key: StorageKey.guestUser))
    }

    func testSignInAnonymouslyMissingSessionCookieThrows() async throws {
        installGuestFlowHandler(setCookie: nil)

        await XCTAssertThrowsAnonymousError {
            try await Xid.shared.signInAnonymously()
        }
    }

    func testSignInAnonymouslyMeFetchFailureThrows() async throws {
        installGuestFlowHandler(meStatus: 401)

        await XCTAssertThrowsAnonymousError {
            try await Xid.shared.signInAnonymously()
        }
        XCTAssertNil(try storage.load(key: StorageKey.guestSessionCookie))
        XCTAssertNil(try storage.load(key: StorageKey.guestUser))
    }

    func testSignOutClearsGuestSession() async throws {
        installGuestFlowHandler()
        _ = try await Xid.shared.signInAnonymously()

        try await Xid.shared.signOut(callEndSession: false)

        XCTAssertNil(try storage.load(key: StorageKey.guestSessionCookie))
        XCTAssertNil(try storage.load(key: StorageKey.guestUser))
        let sessionAfterSignOut = try await Xid.shared.getSession()
        XCTAssertNil(sessionAfterSignOut)
    }

    private func XCTAssertThrowsAnonymousError(
        _ expression: () async throws -> Void,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        do {
            try await expression()
            XCTFail("Expected anonymousSignInFailed", file: file, line: line)
        } catch let error as XidError {
            guard case .anonymousSignInFailed = error else {
                XCTFail("Expected anonymousSignInFailed, got \(error)", file: file, line: line)
                return
            }
        } catch {
            XCTFail("Expected XidError, got \(error)", file: file, line: line)
        }
    }
}
