// PKCETests.swift
// XID iOS Swift SDK Tests

import CryptoKit
import Foundation
import XCTest

@testable import Xid

final class PKCETests: XCTestCase {
    func testVerifierAndChallengeAreNotEmpty() throws {
        let pkce = try PKCE()
        XCTAssertFalse(pkce.verifier.isEmpty)
        XCTAssertFalse(pkce.challenge.isEmpty)
    }

    func testMethodIsS256() throws {
        let pkce = try PKCE()
        XCTAssertEqual(pkce.method, "S256")
    }

    func testVerifierIsBase64URL() throws {
        let pkce = try PKCE()
        // Base64URL charset: A-Z a-z 0-9 - _  (no + / =)
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        XCTAssertTrue(pkce.verifier.unicodeScalars.allSatisfy { allowed.contains($0) })
    }

    func testChallengeIsBase64URL() throws {
        let pkce = try PKCE()
        XCTAssertFalse(pkce.challenge.contains("="))
        XCTAssertFalse(pkce.challenge.contains("+"))
        XCTAssertFalse(pkce.challenge.contains("/"))
    }

    func testEachCallGeneratesUniquePair() throws {
        let a = try PKCE()
        let b = try PKCE()
        XCTAssertNotEqual(a.verifier, b.verifier)
        XCTAssertNotEqual(a.challenge, b.challenge)
    }

    // S256 algorithm correctness: challenge == BASE64URL(SHA256(verifier))
    func testChallengeMatchesSHA256OfVerifier() throws {
        let pkce = try PKCE()
        let digest = SHA256.hash(data: Data(pkce.verifier.utf8))
        let expected = Data(digest).base64URLEncodedString()
        XCTAssertEqual(pkce.challenge, expected)
    }

    // Known-vector test derived from RFC 7636 Appendix B
    // verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    // challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    func testKnownRFC7636Vector() throws {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        let digest = SHA256.hash(data: Data(verifier.utf8))
        let challenge = Data(digest).base64URLEncodedString()
        XCTAssertEqual(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    func testVerifierLength() throws {
        // RFC 7636 Section 4.1: verifier must be 43-128 chars
        let pkce = try PKCE()
        XCTAssertGreaterThanOrEqual(pkce.verifier.count, 43)
        XCTAssertLessThanOrEqual(pkce.verifier.count, 128)
    }
}
