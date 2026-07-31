import Foundation
import XCTest
@testable import Xid

final class TokenSessionStorageTests: XCTestCase {
    func testFailedReplacementKeepsPreviousSession() throws {
        let storage = FailingTokenStorage()
        let previous = makeSession(accessToken: "access_old")
        try TokenSessionStorage.save(previous, storage: storage)

        storage.failNextSave = true
        XCTAssertThrowsError(try TokenSessionStorage.save(makeSession(accessToken: "access_new"), storage: storage))

        XCTAssertEqual(try TokenSessionStorage.load(storage: storage)?.accessToken, "access_old")
    }

    func testLoadIdTokenReadsTheActiveSessionEnvelope() throws {
        let storage = FailingTokenStorage()
        try TokenSessionStorage.save(makeSession(accessToken: "access"), storage: storage)

        XCTAssertEqual(
            try TokenSessionStorage.loadIdToken(storage: storage),
            "id_token"
        )
        XCTAssertNil(try storage.load(key: StorageKey.idToken))
    }

    func testCorruptSessionIsClearedInsteadOfReturningMixedLegacyTokens() throws {
        let storage = FailingTokenStorage()
        try storage.save(key: StorageKey.session, value: "not-json")
        try storage.save(key: StorageKey.accessToken, value: "legacy_access")
        try storage.save(key: StorageKey.expiresAt, value: "invalid-date")

        XCTAssertNil(try TokenSessionStorage.load(storage: storage))
        XCTAssertTrue(try TokenSessionStorage.isCleared(storage: storage))
        XCTAssertNil(try storage.load(key: StorageKey.accessToken))
    }

    func testClearedTombstonePreventsPreviousSessionRestore() throws {
        let storage = FailingTokenStorage()
        try TokenSessionStorage.save(makeSession(accessToken: "access_old"), storage: storage)
        try TokenSessionStorage.markCleared(storage: storage)

        XCTAssertNil(try TokenSessionStorage.load(storage: storage))
        XCTAssertTrue(try TokenSessionStorage.isCleared(storage: storage))
    }

    func testClearFailureLeavesFailClosedMarkerAfterRestart() throws {
        let storage = FailingTokenStorage()
        try storage.save(key: StorageKey.accessToken, value: "legacy_access")
        try storage.save(key: StorageKey.refreshToken, value: "legacy_refresh")
        try storage.save(key: StorageKey.expiresAt, value: "2027-01-01T00:00:00Z")

        storage.failNextDelete = true
        XCTAssertThrowsError(try TokenSessionStorage.clear(storage: storage))

        XCTAssertNil(try TokenSessionStorage.load(storage: storage))
        XCTAssertTrue(try TokenSessionStorage.isCleared(storage: storage))
        XCTAssertEqual(try storage.load(key: StorageKey.refreshToken), "legacy_refresh")
    }

    func testTwoPendingAuthorizationsConsumeOwnVerifierOutOfOrderOnlyOnce() throws {
        let storage = FailingTokenStorage()
        try PendingAuthorizationStorage.save(
            state: "state_first",
            verifier: "verifier_first",
            nonce: "nonce_first",
            storage: storage
        )
        try PendingAuthorizationStorage.save(
            state: "state_second",
            verifier: "verifier_second",
            nonce: "nonce_second",
            storage: storage
        )

        let second = try PendingAuthorizationStorage.consume(
            state: "state_second",
            storage: storage
        )
        let first = try PendingAuthorizationStorage.consume(
            state: "state_first",
            storage: storage
        )
        let replay = try PendingAuthorizationStorage.consume(
            state: "state_first",
            storage: storage
        )

        XCTAssertEqual(
            second,
            PendingAuthorizationStorage.Record(
                verifier: "verifier_second",
                nonce: "nonce_second"
            )
        )
        XCTAssertEqual(
            first,
            PendingAuthorizationStorage.Record(
                verifier: "verifier_first",
                nonce: "nonce_first"
            )
        )
        XCTAssertNil(replay)
    }

    private func makeSession(accessToken: String) -> StoredTokenSet {
        StoredTokenSet(
            accessToken: accessToken,
            refreshToken: "refresh_token",
            idToken: "id_token",
            expiresAt: Date(timeIntervalSince1970: 1_800_000_000)
        )
    }
}

private final class FailingTokenStorage: TokenStorageAdapter, @unchecked Sendable {
    var failNextSave = false
    var failNextDelete = false
    private var values: [String: String] = [:]

    func save(key: String, value: String) throws {
        if failNextSave {
            failNextSave = false
            throw TokenStorageTestError.failed
        }
        values[key] = value
    }

    func load(key: String) throws -> String? {
        values[key]
    }

    func delete(key: String) throws {
        if failNextDelete {
            failNextDelete = false
            throw TokenStorageTestError.failed
        }
        values.removeValue(forKey: key)
    }
}

private enum TokenStorageTestError: Error {
    case failed
}
