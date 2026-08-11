# OpenSSF Best Practices Badge (Passing)

This document is the project’s self-certification pack for
[OpenSSF Best Practices project 13783](https://www.bestpractices.dev/projects/13783).

Use it to:

1. Paste **Met / N/A** answers and justifications into the badge form.
2. Keep evidence URLs stable when reviewers re-check the entry.
3. Track residual gaps that need process (not code) follow-up.

**Scope here:** Passing (tier 0). Silver and Gold are listed only as later work.

**Badge entry (2026-08-11 baseline):** `badge_level=in_progress`,
`badge_percentage_0=19`. Most Passing criteria were unanswered (`?`), not failed.
Repository practice already covers nearly all MUST criteria; the remaining work is
form completion plus the versioning notes below.

## How to apply

1. Sign in at [https://www.bestpractices.dev/projects/13783/edit](https://www.bestpractices.dev/projects/13783/edit)
   as the project entry owner.
2. For each criterion below, set status to **Met** or **N/A** and paste the
   justification (include the URL).
3. Save. Confirm the Passing percentage reaches 100% and the badge shows **passing**.
4. When practice changes, update this file in the same PR as the practice change.

## Project basics (form header)

| Field | Value |
| ----- | ----- |
| Name | xid |
| Description | Edge-native identity platform on Cloudflare Workers. One TypeScript codebase runs as an OIDC/OAuth provider, multi-tenant RBAC engine, enterprise SSO federation gateway (SAML and SCIM), and passkey-first hosted auth UI. MIT licensed and self-hostable on your own Cloudflare account. |
| Homepage URL | https://xid.dev |
| Repository URL | https://github.com/StringKe/xid |
| License (SPDX) | MIT |
| Implementation languages | TypeScript, JavaScript, Swift, C#, Rust, Java, PHP, Dart, Kotlin, Ruby, Python, Go, Shell |
| CPE | (leave empty; no CPE assigned) |

---

## Passing criteria

Status values: **Met**, **N/A**, or **Unmet** (must not remain for Passing MUST/SHOULD without justification).

### Basics

| ID | Status | Justification (paste) |
| -- | ------ | --------------------- |
| description_good | Met | Project homepage and README describe XID in plain language: an edge-native identity platform on Cloudflare Workers that provides Hosted Auth, OIDC/OAuth, multi-tenant organizations/RBAC, enterprise SSO federation, and self-hosting under MIT. See https://xid.dev and https://github.com/StringKe/xid/blob/main/README.md |
| interact | Met | Feedback and contribution paths are published in SUPPORT.md (bugs, features, discussions), CONTRIBUTING.md (how to contribute), and SECURITY.md (vulnerabilities). Homepage footer links to documentation, GitHub, support, security, and contributing. See https://github.com/StringKe/xid/blob/main/SUPPORT.md and https://xid.dev |
| contribution | Met | CONTRIBUTING.md explains pull requests, DCO sign-off, toolchain, and review flow. https://github.com/StringKe/xid/blob/main/CONTRIBUTING.md |
| contribution_requirements | Met | CONTRIBUTING.md states coding standards (TypeScript/Oxlint rules, no `any`, tenant isolation, crypto boundary), required local gates (`pnpm run check`, `pnpm test`), DCO, and Conventional Commits. https://github.com/StringKe/xid/blob/main/CONTRIBUTING.md |
| floss_license | Met | MIT License (OSI-approved). https://github.com/StringKe/xid/blob/main/LICENSE |
| floss_license_osi | Met | MIT is OSI-approved. https://opensource.org/licenses/MIT |
| license_location | Met | Top-level LICENSE file. https://github.com/StringKe/xid/blob/main/LICENSE |
| documentation_basics | Met | README quickstart, docs/deployment.md for install/run, docs/design and docs/protocols for use and security posture. https://github.com/StringKe/xid/blob/main/README.md https://github.com/StringKe/xid/blob/main/docs/deployment.md |
| documentation_interface | Met | External HTTP contracts are documented in docs/api-contracts.md; protocol surfaces in docs/protocols/; SDK surfaces in docs/sdks/. https://github.com/StringKe/xid/blob/main/docs/api-contracts.md |
| sites_https | Met | Homepage, repository, and distribution use HTTPS only (https://xid.dev, https://github.com/StringKe/xid). |
| discussion | Met | GitHub Issues, Pull Requests, and Discussions provide searchable, URL-addressable discussion without proprietary clients. https://github.com/StringKe/xid/issues https://github.com/StringKe/xid/discussions |
| english | Met | Default documentation, issue templates, and contribution docs are English; English bug reports and comments are accepted. Localized README and Site content exist in addition, not instead. https://github.com/StringKe/xid/blob/main/README.md |
| maintained | Met | Project is actively maintained on main (recent commits and pull requests). Maintainers respond to security reports per SECURITY.md. Repository is not archived. https://github.com/StringKe/xid |

### Change control

| ID | Status | Justification (paste) |
| -- | ------ | --------------------- |
| repo_public | Met | Public git repository on GitHub. https://github.com/StringKe/xid |
| repo_track | Met | git tracks who changed what and when. |
| repo_interim | Met | Full commit history and pull requests are published for collaborative review; intermediate commits are not limited to final tarballs. https://github.com/StringKe/xid/commits/main |
| repo_distributed | Met | Distributed VCS: git. |
| version_unique | Met | Every user-consumable revision is uniquely identified by git commit SHA on main. The project adheres to Semantic Versioning for tagged releases when published; until the first tag, main tip + SHA is the identifier (documented in CHANGELOG.md). https://github.com/StringKe/xid/blob/main/CHANGELOG.md |
| version_semver | Met | CHANGELOG states adherence to Semantic Versioning 2.0.0 for releases. https://github.com/StringKe/xid/blob/main/CHANGELOG.md |
| version_tags | Met | Policy: each published release is identified with an annotated git tag matching SemVer (for example `v0.1.0`). Until the first tagged release, consumers use commit SHAs; tags will mark each release as they ship. See CHANGELOG.md versioning section. https://github.com/StringKe/xid/blob/main/CHANGELOG.md |
| release_notes | Met | Human-readable CHANGELOG (Keep a Changelog), not raw git log. https://github.com/StringKe/xid/blob/main/CHANGELOG.md |
| release_notes_vulns | N/A | No public vulnerability has been fixed in a release yet. When a publicly known vulnerability is fixed, CHANGELOG lists it under a Security section (policy in CHANGELOG.md and SECURITY.md). |

### Reporting

| ID | Status | Justification (paste) |
| -- | ------ | --------------------- |
| report_process | Met | Bug reports via GitHub Issues using the bug template; process summarized in SUPPORT.md. https://github.com/StringKe/xid/blob/main/SUPPORT.md https://github.com/StringKe/xid/issues/new/choose |
| report_tracker | Met | GitHub Issues tracks bugs and enhancement requests with templates. https://github.com/StringKe/xid/issues |
| report_responses | Met | Maintainers respond to valid bug reports. In the current 2–12 month window there have been few or no public bug issues; the project is actively maintained and will respond to reports (no SLA for community support, but security acknowledgements target 5 business days). Issue archive: https://github.com/StringKe/xid/issues |
| enhancement_responses | Met | Enhancement requests use the feature template and Discussions. Maintainers respond to most valid enhancement requests (>50% target) when volume is within capacity; answers may be “no” with rationale. https://github.com/StringKe/xid/issues https://github.com/StringKe/xid/discussions |
| report_archive | Met | Public searchable archive of issues and discussions. https://github.com/StringKe/xid/issues |
| vulnerability_report_process | Met | SECURITY.md on the repository (and linked from README and the site footer). https://github.com/StringKe/xid/blob/main/SECURITY.md |
| vulnerability_report_private | Met | Private channel: GitHub private vulnerability reporting (HTTPS). SECURITY.md forbids public issues for vulnerabilities. https://github.com/StringKe/xid/security/advisories/new https://github.com/StringKe/xid/blob/main/SECURITY.md |
| vulnerability_report_response | N/A | No vulnerability reports received in the past 6 months. Policy targets acknowledgement within 5 business days (≤14 days required by the badge). https://github.com/StringKe/xid/blob/main/SECURITY.md |

### Quality

| ID | Status | Justification (paste) |
| -- | ------ | --------------------- |
| build | Met | Working FLOSS build from source: `pnpm install` then `pnpm build` (turborepo + Vite / Vite+). Documented in CONTRIBUTING.md and README. https://github.com/StringKe/xid/blob/main/CONTRIBUTING.md |
| build_common_tools | Met | Common tools: pnpm, turborepo, Vite, TypeScript compiler. |
| build_floss_tools | Met | Build tools used are FLOSS. |
| test | Met | Automated FLOSS test suite: Vitest across apps and packages; additional Node test scripts for repo gates. https://github.com/StringKe/xid/blob/main/package.json |
| test_invocation | Met | Standard invocation: `pnpm test` (and `pnpm run check` for full gates). |
| test_most | Met | Tests cover protocol correctness, tenant isolation, crypto paths, enumeration resistance, and coverage gates (`test:coverage-gate`, `test:worker-coverage-gate`). https://github.com/StringKe/xid/blob/main/CONTRIBUTING.md#testing-policy |
| test_continuous_integration | Met | GitHub Actions CI on pull_request and push to main runs check, test, and build. https://github.com/StringKe/xid/blob/main/.github/workflows/ci.yml |
| test_policy | Met | Policy: major new features must add automated tests. Written in CONTRIBUTING.md Testing policy and enforced by PR template checklist. https://github.com/StringKe/xid/blob/main/CONTRIBUTING.md#testing-policy |
| tests_are_added | Met | Recent feature work includes co-located `*.test.ts` files and repo-level gates; PR template requires tests for protocol, isolation, and crypto changes. Evidence in git history and https://github.com/StringKe/xid/blob/main/.github/PULL_REQUEST_TEMPLATE.md |
| tests_documented_added | Met | PR template documents the testing requirement. https://github.com/StringKe/xid/blob/main/.github/PULL_REQUEST_TEMPLATE.md |
| warnings | Met | Oxlint and TypeScript `tsc --noEmit` (strict) run in CI via `pnpm run check`. https://github.com/StringKe/xid/blob/main/vite.config.ts https://github.com/StringKe/xid/blob/main/.github/workflows/ci.yml |
| warnings_fixed | Met | CI fails on lint and typecheck failures; warnings treated as defects. Misreports are fixed or narrowly justified in config, not ignored in application code. |
| warnings_strict | Met | Strict TypeScript and Oxlint rules (for example `no-explicit-any` as error) are enforced in the default check path. |

### Security

| ID | Status | Justification (paste) |
| -- | ------ | --------------------- |
| know_secure_design | Met | At least one primary developer designs with secure design principles (economy of mechanism, fail-safe defaults, complete mediation, open design, separation of privilege, least privilege, least common mechanism, psychological acceptability, limited attack surface, input validation/whitelisting). Design sources: docs/design/00-overview.md and SECURITY.md cryptography and isolation sections. https://github.com/StringKe/xid/blob/main/docs/design/00-overview.md |
| know_common_errors | Met | Primary developers know common identity-platform failures (injection, XSS, authz bypass, crypto misuse, account enumeration) and mitigations (tenant-scoped queries, valibot boundary validation, constant-time compares, Argon2id, Web Crypto only). https://github.com/StringKe/xid/blob/main/SECURITY.md |
| crypto_published | Met | Defaults use publicly reviewed algorithms: ES256 (P-256), AES-256-GCM envelope encryption, SHA-256, Argon2id, TLS 1.2+ at the edge. https://github.com/StringKe/xid/blob/main/SECURITY.md#cryptography |
| crypto_call | Met | Application code calls platform Web Crypto and approved libraries; it does not reimplement AES/RSA/ECDSA/SHA. Argon2id via @noble/hashes only for password hashing. https://github.com/StringKe/xid/blob/main/SECURITY.md#cryptography |
| crypto_floss | Met | Cryptographic functionality uses FLOSS implementations (Web Crypto in the Workers runtime; @noble/hashes for Argon2id). |
| crypto_keylength | Met | Defaults meet NIST 2030 floors: AES-256, P-256 (ES256), SHA-256. Weaker lengths are not offered as defaults. https://github.com/StringKe/xid/blob/main/SECURITY.md#cryptography |
| crypto_working | Met | Defaults do not use broken algorithms (MD4/MD5, single DES, RC4) or ECB. Envelope encryption uses AES-GCM. |
| crypto_weaknesses | Met | Defaults do not rely on SHA-1 for security or other known-weak constructions; signing defaults to ES256. |
| crypto_pfs | Met | Network transport is HTTPS/TLS terminated on Cloudflare with modern cipher suites providing forward secrecy. Application-layer OIDC tokens are short-lived signed JWTs (ES256); long-term signing keys are envelope-encrypted and rotatable. https://developers.cloudflare.com/ssl/ |
| crypto_password_storage | Met | User passwords stored as Argon2id hashes with unique salts and a server-side pepper (Workers Secret), never plaintext. https://github.com/StringKe/xid/blob/main/SECURITY.md#cryptography |
| crypto_random | Met | Cryptographic randomness from `crypto.getRandomValues` / Web Crypto; `Math.random` is forbidden for secrets. https://github.com/StringKe/xid/blob/main/SECURITY.md#cryptography |
| delivery_mitm | Met | Distribution over HTTPS (GitHub, npm-bound packages when published, documentation site). |
| delivery_unsigned | Met | Project does not instruct users to fetch integrity hashes over plain HTTP and trust them without signatures. Delivery is HTTPS. |
| vulnerabilities_fixed_60_days | Met | Policy: medium or higher publicly known vulnerabilities are fixed within 60 days of public knowledge. No such open vulnerabilities are known at this writing. https://github.com/StringKe/xid/blob/main/SECURITY.md#fix-timelines |
| vulnerabilities_critical_fixed | Met | Critical vulnerabilities are prioritized for rapid fix after report; timeline communicated during assessment. https://github.com/StringKe/xid/blob/main/SECURITY.md#fix-timelines |
| no_leaked_credentials | Met | Public repo must not contain live private credentials. Enforced by GitHub secret scanning, push protection, and `pnpm run security:secret-scan` in contributor workflow. Sample env files use placeholders only. https://github.com/StringKe/xid/blob/main/SECURITY.md |

### Analysis

| ID | Status | Justification (paste) |
| -- | ------ | --------------------- |
| static_analysis | Met | CodeQL runs on pull requests, pushes to main, and weekly schedule for javascript-typescript (and other configured languages). https://github.com/StringKe/xid/blob/main/.github/workflows/codeql.yml |
| static_analysis_common_vulnerabilities | Met | CodeQL includes security queries for common vulnerability classes in the analyzed languages. |
| static_analysis_fixed | Met | Confirmed medium/high severity exploitable findings from static analysis are fixed promptly; CI and security alerts track them. |
| static_analysis_often | Met | Static analysis runs on every PR/push to main and on a weekly cron. https://github.com/StringKe/xid/blob/main/.github/workflows/codeql.yml |
| dynamic_analysis | Met | Dynamic analysis via the automated test suite under Workers/jsdom/browser smoke paths (`pnpm test`, CI smoke on main) exercising protocol and auth flows with varied inputs. https://github.com/StringKe/xid/blob/main/.github/workflows/ci.yml |
| dynamic_analysis_unsafe | N/A | Primary delivered software is TypeScript/JavaScript on Cloudflare Workers (memory-safe managed runtime). Native SDK sources exist for verification but are not the production Worker runtime path. |
| dynamic_analysis_enable_assertions | Met | Tests and runtime Result/invariant checks assert security and protocol properties during dynamic test runs. |
| dynamic_analysis_fixed | N/A | No medium/high exploitable vulnerabilities currently tracked from dynamic analysis requiring fix; when found, fix policy matches SECURITY.md. |

---

## Residual process notes

| Topic | Status | Action |
| ----- | ------ | ------ |
| First SemVer git tag | Not published yet | On first release: tag `vX.Y.Z`, cut CHANGELOG section, GitHub Release. |
| Public bug volume | Low | Keep responding to issues; preserve `report_responses` evidence. |
| Vulnerability reports | None in last 6 months | Keep private reporting enabled; meet 5 business day ack. |
| Silver / Gold | Not claimed | Governance, 2FA enforcement evidence, signed releases, higher coverage thresholds, external review. |

## Related files

| File | Role |
| ---- | ---- |
| [SECURITY.md](../SECURITY.md) | Vulnerability process, crypto summary, fix timelines |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Contribution requirements, testing policy |
| [SUPPORT.md](../SUPPORT.md) | Bug/enhancement channels |
| [CHANGELOG.md](../CHANGELOG.md) | Release notes and versioning |
| [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | Community standards (also Silver) |
| [.github/workflows/ci.yml](../.github/workflows/ci.yml) | Continuous integration |
| [.github/workflows/codeql.yml](../.github/workflows/codeql.yml) | Static analysis |
| [docs/api-contracts.md](./api-contracts.md) | External interface documentation |
