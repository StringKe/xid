// swift-tools-version: 5.9
// XID iOS Swift SDK - Package.swift
// MIT
// Status: implemented; compiled and unit-tested locally, real IdP round-trip pending

import PackageDescription

let package = Package(
    name: "Xid",
    platforms: [
        .iOS(.v16),
        .macOS(.v13),
    ],
    products: [
        .library(
            name: "Xid",
            targets: ["Xid"]
        ),
    ],
    // 依赖说明:
    // - ASWebAuthenticationSession: Apple 系统框架,无需声明
    // - CryptoKit: Apple 系统框架,无需声明 (PKCE S256 via SHA256)
    // - Security framework: Apple 系统框架 (Keychain 操作)
    // 所有依赖均来自 Apple SDK,无第三方依赖
    dependencies: [],
    targets: [
        .target(
            name: "Xid",
            dependencies: [],
            path: "Sources/Xid",
            swiftSettings: [
                .enableExperimentalFeature("StrictConcurrency"),
            ]
        ),
        .testTarget(
            name: "XidTests",
            dependencies: ["Xid"],
            path: "Tests/XidTests"
        ),
    ]
)
