// KeychainTokenStorageTests.swift
// XID iOS Swift SDK Tests
// Status: implemented; compiled and unit-tested locally, real IdP round-trip pending
// Note: Keychain 测试需要真实模拟器或设备运行环境,在 Linux CI 下跳过。

import XCTest
@testable import Xid

final class KeychainTokenStorageTests: XCTestCase {
    var storage: KeychainTokenStorage!
    let testKey = "xid.test.token"

    override func setUp() {
        super.setUp()
        storage = KeychainTokenStorage(service: "dev.xid.sdk.test")
        try? storage.delete(key: testKey)
    }

    override func tearDown() {
        try? storage.delete(key: testKey)
        super.tearDown()
    }

    func testSaveAndLoad() throws {
        try storage.save(key: testKey, value: "test_value_123")
        let loaded = try storage.load(key: testKey)
        XCTAssertEqual(loaded, "test_value_123")
    }

    func testLoadNonExistentKeyReturnsNil() throws {
        let result = try storage.load(key: "xid.test.nonexistent")
        XCTAssertNil(result)
    }

    func testDelete() throws {
        try storage.save(key: testKey, value: "to_delete")
        try storage.delete(key: testKey)
        let loaded = try storage.load(key: testKey)
        XCTAssertNil(loaded)
    }

    func testOverwrite() throws {
        try storage.save(key: testKey, value: "first")
        try storage.save(key: testKey, value: "second")
        let loaded = try storage.load(key: testKey)
        XCTAssertEqual(loaded, "second")
    }

    func testDeleteNonExistentDoesNotThrow() {
        XCTAssertNoThrow(try storage.delete(key: "xid.test.gone"))
    }
}
