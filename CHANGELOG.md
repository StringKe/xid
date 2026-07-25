# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

The repository has no release tags yet. The root `package.json` version is `0.0.0`. Until a `0.x`
tag is published, `main` is the only reference point and the public API is unstable.

## [Unreleased]

### Changed

- **License changed from Elastic License 2.0 to the MIT License.** XID is now open source under an
  OSI-approved license. The Elastic License restrictions (no hosted service offering, no license key
  circumvention, no removal of license notices) no longer apply. The only remaining obligation is to
  retain the copyright and permission notice.

### Added

- Open source governance files: `CONTRIBUTING.md` (with DCO 1.1 sign-off), `CODE_OF_CONDUCT.md`
  (Contributor Covenant 2.1), `SECURITY.md`, `SUPPORT.md`, issue and pull request templates,
  `CODEOWNERS`, and Dependabot configuration.

### Capability snapshot at first public commit

Not a release entry. Recorded so that later changelog entries have a baseline. Every item below is
implemented and verified locally (evidence tiers L1-L3). L4 verification against real external
identity providers, downstream SaaS, social providers, and SMS or WhatsApp delivery is not complete
for any capability, so nothing here is production-supported.

- Worker: 12 core OIDC/OAuth endpoints (the full route surface under `oidc/` and `oauth/` is larger
  and includes 501 stubs), CIBA, federation, SAML inbound and outbound, SCIM 2.0 (Bulk,
  ETag), legacy LDAP / WS-Fed / SWA / header auth, Management API under `/v1/*`
- Hosted UI: 12 auth page types, account portal (5 pages), organization console, platform console
- Kernel libraries: protocol, webauthn, crypto, saml, db, i18n, types
- 15 TypeScript SDKs: core, backend, react, nextjs, vue, nuxt, svelte, solid, angular, astro, remix,
  react-native, expo, electron, tauri
- 13 native SDKs: Go, Rust, Python, Ruby, PHP, Java, .NET, iOS, macOS, Windows, Linux, Android,
  Flutter. These are not published to any package registry. CI runs no language toolchain and none
  of their test suites; `tests/native-sdk-contract.test.mjs` only asserts that every platform in the
  contract matrix points at a directory that exists.
- i18n: 8 locales (en, zh-Hans, ja, ko, fr, de, es, pt-BR), catalogs fully translated

[Unreleased]: https://github.com/StringKe/xid/commits/main
