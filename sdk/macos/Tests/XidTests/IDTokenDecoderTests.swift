// IDTokenDecoderTests.swift
// XID macOS Swift SDK Tests
// MIT

import XCTest

@testable import Xid

final class IDTokenDecoderTests: XCTestCase {
    // Test JWT: header.payload.signature (signature is a placeholder; no verification)
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
                XCTFail("Expected idTokenDecodeFailed, got \(error)")
            }
        }
    }

    func testMissingSubThrows() {
        // payload: {"email":"test@example.com"} (no sub)
        let noSubToken = [
            "eyJhbGciOiJFUzI1NiJ9",
            "eyJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20ifQ",
            "sig",
        ].joined(separator: ".")
        XCTAssertThrowsError(try IDTokenDecoder.decodeUser(noSubToken)) { error in
            if case XidError.idTokenDecodeFailed = error {} else {
                XCTFail("Expected idTokenDecodeFailed, got \(error)")
            }
        }
    }
}
