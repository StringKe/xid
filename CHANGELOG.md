# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

## Versioning

| Situation | Identifier |
| --------- | ---------- |
| Pre-release development on `main` | Git **commit SHA** (unique per revision). Root `package.json` remains `0.0.0` until the first tagged release. |
| Published release | Annotated git tag `vMAJOR.MINOR.PATCH` (SemVer), matching a GitHub Release and a CHANGELOG section. |
| Public API stability | Unstable until 1.0.0; breaking changes may land without a long deprecation window while pre-1.0. |

When a release is cut: add a dated `## [X.Y.Z] - YYYY-MM-DD` section, move items out of
`[Unreleased]`, and tag the repository. Every published release is identified in version control by
that tag.

### Security entries

Every **publicly known** vulnerability fixed in a release **must** be listed under a `### Security`
heading in that release’s notes (CVE or advisory URL when available). If a release has no security
fixes, omit the heading. Private reports that never became public need not be listed until
disclosure.

OpenSSF Best Practices self-certification notes: [`docs/openssf-best-practices.md`](docs/openssf-best-practices.md).

## [Unreleased]

### Security

- No publicly disclosed vulnerability fixes in this period.
- Documented OpenSSF-aligned fix timelines (60-day public medium+ fixes, critical prioritization),
  cryptography defaults, and static/dynamic analysis practices in `SECURITY.md`.

### Changed

- **License changed from Elastic License 2.0 to the MIT License.** XID is now open source under an
  OSI-approved license. The Elastic License restrictions (no hosted service offering, no license key
  circumvention, no removal of license notices) no longer apply. The only remaining obligation is to
  retain the copyright and permission notice.
- Clarified versioning (commit SHA until first SemVer tag) and Security release-note rules in
  `CHANGELOG.md`.
- Homepage footer and README community tables now link Support, Security, and Contributing for
  feedback and contribution discovery.
- Project status copy no longer claims zero production evidence. It states pre-1.0 API instability,
  live first-party L4 on `https://xid.dev`, and that external IdP/SaaS/social/SMS paths stay
  non-production-supported until their L4 rows exist (`README*`, `SECURITY.md`, `SUPPORT.md`, site
  home evidence blurb).

### Added

- OpenSSF Best Practices Passing self-certification pack:
  [`docs/openssf-best-practices.md`](docs/openssf-best-practices.md) with paste-ready Met/N/A
  justifications for project 13783.
- Explicit Testing policy and warnings/static-analysis section in `CONTRIBUTING.md`.

- Enterprise org structure (OrgUnit): an in-org business tree with adjacency plus materialized path
  (depth cap 8), primary/secondary post placement, reporting-line manager resolution walking up the
  ancestor chain, and nine Management API endpoints under `/v1/organizations/:orgId/units` (tree
  CRUD, move, archive, members), guarded by the new `org-units` API key scope or an org manager
  cookie session. OrgUnit carries no tenant-boundary semantics and never enters token claims.
- Project access requests with approval: per-project `access_policy` (`open`/`restricted`/
  `approval_required`) gating the same-org `/authorize` and token-issuance paths, self-service
  `/auth/access-requests` and approver `/auth/access-approvals` session endpoints, approver
  resolution (OrgUnit reporting line -> `project_manager` -> `org_manager`, self-approval skipped),
  approval writing a `user_grants` row with `granted_via_request_id` and an optional `expires_at`
  JIT window, read-only `/v1` access-request listing with the new `access-requests` scope, and the
  audit events `access_request.created/approved/denied/cancelled/expired` plus
  `project.access_policy_changed`.
- Guest one-click passkey upgrade in the SDKs: `@xid-kit/core` `upgradeGuestWithPasskey()` and
  `@xid-kit/react` `useUpgradeGuest()` convert an anonymous (guest) session in place -- the passkey
  ceremony attaches to the existing user and `sub` is preserved. Same-origin mode only; non-guest
  callers and authenticator cancellation map to expected-failure Results.
- Silent re-authentication for OIDC browser applications: `@xid-kit/core` `signInSilent()` runs a
  best-effort hidden-iframe `prompt=none` attempt and `signInSilentWithRedirect()` is the reliable
  top-level redirect fallback. Silent authorization errors (`login_required`, `consent_required`,
  `interaction_required`) map to expected-failure Results instead of throwing.
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
