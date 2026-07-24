// AuthorizationURLBuilderTests.swift
// XID macOS Swift SDK Tests
// MIT

import XCTest

@testable import Xid

final class AuthorizationURLBuilderTests: XCTestCase {
    private let authEndpoint = URL(string: "https://xid.dev/authorize")!
    private let redirectUri = URL(string: "com.example.app://auth/callback")!

    private func makePKCE() throws -> PKCE { try PKCE() }

    func testBuildsValidURL() throws {
        let pkce = try makePKCE()
        let url = AuthorizationURLBuilder.build(
            authorizationEndpoint: authEndpoint,
            clientId: "client_abc",
            redirectUri: redirectUri,
            scopes: ["openid", "profile"],
            pkce: pkce,
            state: "random_state"
        )
        XCTAssertNotNil(url)
    }

    func testURLContainsRequiredParameters() throws {
        let pkce = try makePKCE()
        let url = try XCTUnwrap(AuthorizationURLBuilder.build(
            authorizationEndpoint: authEndpoint,
            clientId: "client_abc",
            redirectUri: redirectUri,
            scopes: ["openid"],
            pkce: pkce,
            state: "test_state"
        ))
        let components = URLComponents(url: url, resolvingAgainstBaseURL: true)
        let items = components?.queryItems ?? []

        func value(for name: String) -> String? {
            items.first(where: { $0.name == name })?.value
        }

        XCTAssertEqual(value(for: "response_type"), "code")
        XCTAssertEqual(value(for: "client_id"), "client_abc")
        XCTAssertEqual(value(for: "state"), "test_state")
        XCTAssertEqual(value(for: "code_challenge_method"), "S256")
        XCTAssertEqual(value(for: "code_challenge"), pkce.challenge)
        XCTAssertEqual(value(for: "scope"), "openid")
    }

    func testAdditionalParamsArePropagated() throws {
        let pkce = try makePKCE()
        let url = try XCTUnwrap(AuthorizationURLBuilder.build(
            authorizationEndpoint: authEndpoint,
            clientId: "c",
            redirectUri: redirectUri,
            scopes: ["openid"],
            pkce: pkce,
            state: "s",
            additionalParams: ["prompt": "login"]
        ))
        let components = URLComponents(url: url, resolvingAgainstBaseURL: true)
        let promptValue = components?.queryItems?.first(where: { $0.name == "prompt" })?.value
        XCTAssertEqual(promptValue, "login")
    }
}
