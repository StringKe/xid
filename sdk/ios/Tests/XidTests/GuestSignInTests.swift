import Foundation
import XCTest
@testable import Xid

final class GuestSignInTests: XCTestCase {
    private let issuer = URL(string: "https://xid.example")!

    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        super.tearDown()
    }

    // MARK: - 建号

    func testSignInAnonymouslyCreatesGuestPersistsSessionAndExposesIsAnonymous() async throws {
        let recorder = RequestRecorder()
        let session = Self.mockSession(recorder: recorder) { request in
            let url = try XCTUnwrap(request.url)
            switch (request.httpMethod, url.path) {
            case ("POST", "/auth/guest"):
                return (
                    Self.jsonResponse(url: url, statusCode: 201, headers: [
                        "Set-Cookie": "__Host-xid.session=cookie_value; Path=/; HttpOnly; Secure; Expires=Wed, 01 Jan 2031 00:00:00 GMT",
                    ]),
                    Data(#"{"sessionId":"sess_123"}"#.utf8)
                )
            case ("GET", "/v1/me"):
                return (
                    Self.jsonResponse(url: url, statusCode: 200),
                    Data(#"{"user":{"sub":"user_guest_1","provisioned_by":"anonymous"}}"#.utf8)
                )
            default:
                throw MockError.unexpectedRequest
            }
        }

        let storage = InMemoryTokenStorage()
        let xid = Self.makeXid(issuer: issuer, storage: storage, urlSession: session)

        let result = try await xid.signInAnonymously()

        let requests = recorder.requests
        XCTAssertEqual(requests.count, 2)

        // /auth/guest 请求形状
        XCTAssertEqual(requests[0].httpMethod, "POST")
        XCTAssertEqual(requests[0].url?.absoluteString, "https://xid.example/auth/guest")
        XCTAssertEqual(requests[0].value(forHTTPHeaderField: "Content-Type"), "application/json")
        let guestBody = try XCTUnwrap(recorder.bodies[0])
        let guestBodyObject = try XCTUnwrap(JSONSerialization.jsonObject(with: guestBody) as? [String: String])
        XCTAssertEqual(guestBodyObject, [:])

        // /v1/me 回放捕获到的会话 cookie
        XCTAssertEqual(requests[1].httpMethod, "GET")
        XCTAssertEqual(requests[1].url?.absoluteString, "https://xid.example/v1/me")
        XCTAssertEqual(requests[1].value(forHTTPHeaderField: "Cookie"), "__Host-xid.session=cookie_value")

        // 会话已持久化
        let stored = try XCTUnwrap(GuestSessionStorage.load(storage: storage))
        XCTAssertEqual(stored.sessionId, "sess_123")
        XCTAssertEqual(stored.cookies.first?.name, "__Host-xid.session")
        XCTAssertEqual(stored.cookies.first?.value, "cookie_value")
        XCTAssertNotNil(stored.expiresAt)

        // 返回的 session 暴露 guest 判定,且没有 access token
        XCTAssertTrue(result.isAnonymous)
        XCTAssertTrue(result.user.isAnonymous)
        XCTAssertEqual(result.user.sub, "user_guest_1")
        XCTAssertNil(result.accessToken)

        // getSession 也能看到 guest 会话
        let current = try await xid.getSession()
        XCTAssertEqual(current?.user.sub, "user_guest_1")
        XCTAssertEqual(current?.isAnonymous, true)
    }

    func testCreateGuestSessionSendsTurnstileTokenWhenProvided() async throws {
        let recorder = RequestRecorder()
        let session = Self.mockSession(recorder: recorder) { request in
            let url = try XCTUnwrap(request.url)
            return (
                Self.jsonResponse(url: url, statusCode: 200),
                Data(#"{"sessionId":"sess_ts"}"#.utf8)
            )
        }
        let client = GuestAuthClient(urlSession: session)

        let result = try await client.createGuestSession(issuer: issuer, turnstileToken: "ts_token")

        XCTAssertEqual(result.sessionId, "sess_ts")
        let body = try XCTUnwrap(recorder.bodies.first)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(object, ["turnstileToken": "ts_token"])
    }

    // MARK: - 惰性复用

    func testSignInAnonymouslyReusesStoredGuestSessionWithoutNetwork() async throws {
        let recorder = RequestRecorder()
        let session = Self.mockSession(recorder: recorder) { _ in
            throw MockError.unexpectedRequest
        }
        let storage = InMemoryTokenStorage()
        try GuestSessionStorage.save(
            StoredGuestSession(
                sessionId: "sess_existing",
                cookies: [StoredGuestCookie(name: "__Host-xid.session", value: "cookie_value", expiresAt: nil)],
                user: XidUser(sub: "user_guest_1", email: nil, emailVerified: nil, name: nil, picture: nil, provisionedBy: "anonymous"),
                expiresAt: Date().addingTimeInterval(3600)
            ),
            storage: storage
        )
        let xid = Self.makeXid(issuer: issuer, storage: storage, urlSession: session)

        let result = try await xid.signInAnonymously()

        XCTAssertEqual(recorder.requests.count, 0)
        XCTAssertEqual(result.user.sub, "user_guest_1")
        XCTAssertTrue(result.isAnonymous)
    }

    func testSignInAnonymouslyReusesExistingTokenSessionWithoutNetwork() async throws {
        let recorder = RequestRecorder()
        let session = Self.mockSession(recorder: recorder) { _ in
            throw MockError.unexpectedRequest
        }
        let storage = InMemoryTokenStorage()
        try TokenSessionStorage.save(
            StoredTokenSet(
                accessToken: "access_existing",
                refreshToken: "refresh_existing",
                idToken: nil,
                expiresAt: Date().addingTimeInterval(3600)
            ),
            storage: storage
        )
        let xid = Self.makeXid(issuer: issuer, storage: storage, urlSession: session)

        let result = try await xid.signInAnonymously()

        XCTAssertEqual(recorder.requests.count, 0)
        XCTAssertEqual(result.accessToken, "access_existing")
        XCTAssertFalse(result.isAnonymous)
    }

    // MARK: - 失败路径

    func testSignInAnonymouslyPropagatesGuestEndpointErrorAndPersistsNothing() async throws {
        let recorder = RequestRecorder()
        let session = Self.mockSession(recorder: recorder) { request in
            let url = try XCTUnwrap(request.url)
            return (Self.jsonResponse(url: url, statusCode: 500), Data())
        }
        let storage = InMemoryTokenStorage()
        let xid = Self.makeXid(issuer: issuer, storage: storage, urlSession: session)

        do {
            _ = try await xid.signInAnonymously()
            XCTFail("服务端 500 应抛出错误")
        } catch let XidError.guestSignInFailed(reason) {
            XCTAssertEqual(reason, "HTTP 500")
        }

        XCTAssertNil(try GuestSessionStorage.load(storage: storage))
    }

    func testSignInAnonymouslyPropagatesMeEndpointErrorAndPersistsNothing() async throws {
        let recorder = RequestRecorder()
        let session = Self.mockSession(recorder: recorder) { request in
            let url = try XCTUnwrap(request.url)
            switch (request.httpMethod, url.path) {
            case ("POST", "/auth/guest"):
                return (
                    Self.jsonResponse(url: url, statusCode: 201),
                    Data(#"{"sessionId":"sess_123"}"#.utf8)
                )
            case ("GET", "/v1/me"):
                return (Self.jsonResponse(url: url, statusCode: 401), Data())
            default:
                throw MockError.unexpectedRequest
            }
        }
        let storage = InMemoryTokenStorage()
        let xid = Self.makeXid(issuer: issuer, storage: storage, urlSession: session)

        do {
            _ = try await xid.signInAnonymously()
            XCTFail("/v1/me 401 应抛出错误")
        } catch let XidError.guestSignInFailed(reason) {
            XCTAssertEqual(reason, "/v1/me HTTP 401")
        }

        XCTAssertNil(try GuestSessionStorage.load(storage: storage))
    }

    // MARK: - Set-Cookie 拆分

    func testSplitSetCookieHeaderKeepsExpiresCommaIntact() {
        let header = "a=1; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Path=/, b=2; Path=/"
        XCTAssertEqual(
            GuestAuthClient.splitSetCookieHeader(header),
            ["a=1; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Path=/", "b=2; Path=/"]
        )
    }

    // MARK: - 工具

    private static func makeXid(
        issuer: URL,
        storage: TokenStorageAdapter,
        urlSession: URLSession
    ) -> Xid {
        let xid = Xid()
        xid.configure(options: XidConfiguration(
            issuer: issuer,
            clientId: "client_id",
            redirectUri: URL(string: "com.example.app://auth/callback")!,
            tokenStorage: storage
        ))
        xid.guestAuthClient = GuestAuthClient(urlSession: urlSession)
        return xid
    }

    private static func mockSession(
        recorder: RequestRecorder,
        handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)
    ) -> URLSession {
        MockURLProtocol.requestHandler = { request in
            recorder.record(request)
            return try handler(request)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    private static func jsonResponse(
        url: URL,
        statusCode: Int,
        headers: [String: String] = [:]
    ) -> HTTPURLResponse {
        var fields = ["Content-Type": "application/json"]
        for (key, value) in headers {
            fields[key] = value
        }
        return HTTPURLResponse(url: url, statusCode: statusCode, httpVersion: "HTTP/1.1", headerFields: fields)!
    }
}

// MARK: - Mock URLProtocol

private enum MockError: Error {
    case noHandler
    case unexpectedRequest
}

private final class MockURLProtocol: URLProtocol {
    static var requestHandler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with _: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = MockURLProtocol.requestHandler else {
            client?.urlProtocol(self, didFailWithError: MockError.noHandler)
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

private final class RequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [(URLRequest, Data)] = []

    var requests: [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return recorded.map(\.0)
    }

    var bodies: [Data] {
        lock.lock()
        defer { lock.unlock() }
        return recorded.map(\.1)
    }

    func record(_ request: URLRequest) {
        lock.lock()
        recorded.append((request, Self.readBody(of: request)))
        lock.unlock()
    }

    // URLProtocol 收到的 request 通常把 body 挪进 httpBodyStream,需要手动排空
    private static func readBody(of request: URLRequest) -> Data {
        if let body = request.httpBody {
            return body
        }
        guard let stream = request.httpBodyStream else {
            return Data()
        }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 1024)
        defer { buffer.deallocate() }
        while stream.hasBytesAvailable {
            let count = stream.read(buffer, maxLength: 1024)
            if count <= 0 {
                break
            }
            data.append(buffer, count: count)
        }
        return data
    }
}

private final class InMemoryTokenStorage: TokenStorageAdapter, @unchecked Sendable {
    private var values: [String: String] = [:]

    func save(key: String, value: String) throws {
        values[key] = value
    }

    func load(key: String) throws -> String? {
        values[key]
    }

    func delete(key: String) throws {
        values.removeValue(forKey: key)
    }
}
