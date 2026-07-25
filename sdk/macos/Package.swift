// swift-tools-version: 5.9
// XID macOS Swift SDK - Package.swift
// MIT

import PackageDescription

let package = Package(
    name: "Xid",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .library(
            name: "Xid",
            targets: ["Xid"]
        ),
    ],
    // All dependencies are Apple system frameworks - no third-party dependencies.
    // CryptoKit: PKCE S256 via SHA256
    // Security framework: Keychain operations
    // AuthenticationServices: ASWebAuthenticationSession
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
