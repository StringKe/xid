// IDTokenDecoderTests.swift
// XID iOS Swift SDK Tests
// Status: implemented; compiled and unit-tested locally, real IdP round-trip pending

import XCTest
@testable import Xid

final class IDTokenDecoderTests: XCTestCase {
    // 测试用 JWT:header.payload.signature (签名段为占位符,不验签)
    // payload: {"sub":"user_123","email":"test@example.com","email_verified":true,"name":"Test User"}
    private let sampleIDToken = [
        "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9",
        "eyJzdWIiOiJ1c2VyXzEyMyIsImVtYWlsIjoidGVzdEBleGFtcGxlLmNvbSIsImVtYWlsX3ZlcmlmaWVkIjp0cnVlLCJuYW1lIjoiVGVzdCBVc2VyIn0",
        "placeholder_signature",
    ].joined(separator: ".")

    func testDecodeUserSub() throws {
        let user = try IDTokenDecoder.decodeUser(sampleIDToken)
        XCTAssertEqual(user.sub, "user_123")
    }

    func testDecodeUserEmail() throws {
        let user = try IDTokenDecoder.decodeUser(sampleIDToken)
        XCTAssertEqual(user.email, "test@example.com")
    }

    func testDecodeUserEmailVerified() throws {
        let user = try IDTokenDecoder.decodeUser(sampleIDToken)
        XCTAssertEqual(user.emailVerified, true)
    }

    func testDecodeUserName() throws {
        let user = try IDTokenDecoder.decodeUser(sampleIDToken)
        XCTAssertEqual(user.name, "Test User")
    }

    func testInvalidJWTFormatThrows() {
        XCTAssertThrowsError(try IDTokenDecoder.decodeUser("not.a.valid.jwt.format.extra")) { error in
            if case XidError.idTokenDecodeFailed = error {} else {
                XCTFail("期望 idTokenDecodeFailed,实际得到 \(error)")
            }
        }
    }

    func testMissingSubThrows() {
        // payload: {"email":"test@example.com"} (无 sub)
        let noSubToken = [
            "eyJhbGciOiJFUzI1NiJ9",
            "eyJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20ifQ",
            "sig",
        ].joined(separator: ".")
        XCTAssertThrowsError(try IDTokenDecoder.decodeUser(noSubToken)) { error in
            if case XidError.idTokenDecodeFailed = error {} else {
                XCTFail("期望 idTokenDecodeFailed,实际得到 \(error)")
            }
        }
    }

    func testExpectedNonceMustMatchExactly() throws {
        XCTAssertNoThrow(
            try IDTokenVerifier.validateNonce(
                claims: ["nonce": "nonce_expected"],
                expectedNonce: "nonce_expected"
            )
        )
        XCTAssertThrowsError(
            try IDTokenVerifier.validateNonce(
                claims: ["nonce": "nonce_other"],
                expectedNonce: "nonce_expected"
            )
        )
        XCTAssertThrowsError(
            try IDTokenVerifier.validateNonce(
                claims: [:],
                expectedNonce: "nonce_expected"
            )
        )
    }
}
