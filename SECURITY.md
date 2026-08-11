# Security Policy

XID is identity infrastructure. A defect in this codebase can compromise authentication for every
tenant deployed on it. Security reports are handled with priority over feature work.

## Maturity statement

**XID is pre-1.0.** Public APIs and schema may still change before 1.0.0. The hosted deployment at
https://xid.dev is live, and first-party Hosted Auth, Console, and Management API paths have
production (L4) evidence against that instance. Capabilities that depend on **external** systems
(enterprise IdPs such as Okta, Microsoft Entra ID, and Google Workspace; downstream SaaS SSO/SCIM;
social login providers; SMS and WhatsApp delivery) are **not** production-supported until a real L4
row is recorded for that path. Local L0–L3 evidence is not a production-supported claim. Self-hosting
for real credentials where those external L4 rows are missing remains at your own risk.

This statement is not a reason to withhold a report. It is context for how findings are triaged.

## Supported versions

| Version                 | Supported |
| ----------------------- | --------- |
| Latest commit on `main` | Yes       |
| Anything else           | No        |

There are no releases, no long-term support branches, and no backports. Fixes land on `main`. If you
run a fork or a pinned commit, rebase onto `main` to receive fixes.

## Reporting a vulnerability

**Do not open a public issue, pull request, or discussion for a security problem.**

Preferred channel: **GitHub private vulnerability reporting**.

1. Go to https://github.com/StringKe/xid
2. Open the **Security** tab
3. Click **Report a vulnerability**
4. Fill in the advisory form

The report stays private between you and the maintainers until an advisory is published.

If you cannot use private vulnerability reporting, open a
[Discussion](https://github.com/StringKe/xid/discussions) that says only that you have a security
finding and asks for a private channel. **Put no details in it** -- not the component, not the
symptom. A maintainer will open a private advisory and invite you to it.

There is deliberately no email address here: an address that silently drops mail is worse than no
address at all, because you would believe the report had been delivered.

Include, as far as you can:

- Affected component and file paths or endpoints
- Version or commit SHA you tested
- A minimal reproduction: requests, tokens (redacted), configuration
- Impact: what an attacker gains, and what preconditions are required
- Any proposed fix

Do not test against `xid.dev` or any third party's deployment. Reproduce against a local or
self-hosted instance.

## Response process

| Stage                           | Target                                                       |
| ------------------------------- | ------------------------------------------------------------ |
| Acknowledgement of report       | 5 business days                                              |
| Initial assessment and severity | 10 business days                                             |
| Fix or documented mitigation    | Depends on severity, communicated after assessment           |
| Coordinated disclosure window   | 90 days from acknowledgement, or earlier by mutual agreement |

If a fix is not ready when the 90-day window closes, we will publish what is known along with
mitigations rather than extend silently. If a vulnerability is being exploited in the wild, the
window collapses to whatever is needed to ship a fix.

Reporters are credited in the published advisory unless they ask not to be. There is no bug bounty.

## Fix timelines

These targets align with OpenSSF Best Practices (Passing) expectations:

| Class | Target |
| ----- | ------ |
| Acknowledgement of a private report | 5 business days (badge maximum 14 days) |
| Medium or higher severity vulnerability that is **publicly known** | Fixed and available on `main` within **60 days** of public knowledge |
| Critical severity after private report | Prioritized for the fastest practical fix; timeline shared after assessment |
| Publicly disclosed fixed vulnerability | Listed under a `### Security` section in [`CHANGELOG.md`](CHANGELOG.md) when the fix ships |

Public knowledge means a published CVE/NVD entry, or the project publishes the issue. Severity for the 60-day rule follows CVSS 2.0 base score ≥ 4 (medium or higher), consistent with the badge criterion.

There are no long-term support branches. The fix lands on `main`; consumers track `main` or rebase onto it.

## Cryptography

XID is identity infrastructure and uses cryptography heavily. Defaults:

| Area | Practice |
| ---- | -------- |
| Primitives | Platform **Web Crypto** (`crypto.subtle`, `crypto.getRandomValues`) only. Application code does not implement AES, RSA, ECDSA, SHA, HKDF, or random generators. |
| Password hashing | **Argon2id** via `@noble/hashes`, unique per-user salt, server-side pepper in Workers Secrets (never in D1). |
| Token signing | Instance **ES256** (P-256) keys; private keys envelope-encrypted with **AES-256-GCM** under a KEK in Workers Secrets. Plaintext private keys are never persisted. |
| Hashing for integrity | SHA-256 (audit chain, digests). Not MD5/SHA-1 for security. |
| Transport | HTTPS/TLS at the edge (Cloudflare). No http distribution of the project site or repository. |
| Forbidden for secrets | `Math.random`, home-grown crypto, storing password or reset secrets in plaintext. |

Design detail: `docs/design/00-overview.md` (build-vs-buy and signing keys). Contributor rules: crypto boundary in project AI standards and `CONTRIBUTING.md`.

## Static and dynamic analysis

- **Static analysis:** GitHub CodeQL on pull requests, pushes to `main`, and a weekly schedule (`.github/workflows/codeql.yml`). Confirmed medium/high exploitable findings are fixed promptly.
- **Dependency review:** Dependabot and dependency-review workflow on pull requests.
- **Secret scanning:** GitHub secret scanning and push protection, plus `pnpm run security:secret-scan`.
- **Dynamic analysis:** Vitest unit/integration suites and Workers smoke tests exercise protocol and auth paths with varied inputs (`pnpm test`, CI).

## In scope

Vulnerabilities in the code in this repository, in particular:

**Signing key handling**

- Extraction or recovery of an instance signing private key
- Envelope encryption weaknesses (KEK handling, AES-256-GCM usage, key material reaching persistent
  storage in plaintext)
- Key rotation flaws that allow a revoked `kid` to remain trusted

**Tenant isolation**

- Reading or writing another tenant's or organization's data. D1 has no row-level security, so
  isolation depends entirely on the tenant-scoped query layer; any path that bypasses it is in scope.
- Cross-tenant leakage through error messages, timing, or existence oracles
- Privilege escalation from Org Admin to Instance Manager

**OIDC and OAuth correctness**

- PKCE bypass or downgrade, including acceptance of `plain` challenges
- `redirect_uri` matching flaws, open redirects, wildcard acceptance
- Authorization code reuse, refresh token replay without family revocation, `jti` replay
- Token substitution: wrong `aud`, wrong `iss`, missing `nonce` or `at_hash` binding, algorithm
  confusion, `alg: none` acceptance
- Client authentication bypass (`client_secret_basic`, `client_secret_post`, `private_key_jwt`)
- DPoP and PAR handling flaws

**Credential handling**

- Password hashing weaknesses (Argon2id parameters, pepper handling, salt reuse)
- Password reset token forgery, reuse, or predictability
- MFA bypass: TOTP replay, backup code reuse, step-up requirement bypass
- Account enumeration through response content or response timing

**WebAuthn and passkeys**

- Any path that skips one of the four verifications: challenge, origin, RP ID hash, signature
- Challenge reuse or replay
- RP ID scoping errors that expose one tenant's credentials on another tenant's login page

**Federation**

- SAML signature verification bypass, XML signature wrapping, XXE, canonicalization flaws
- SCIM authorization flaws allowing cross-directory access
- Social and enterprise IdP response handling that trusts unverified assertions

**Other**

- Server-side request forgery through configurable URLs (JWKS URIs, webhook targets, metadata URLs)
- Injection into D1 queries
- Webhook signature verification bypass
- Secret exposure in logs, audit records, or API responses

## Out of scope

- Misconfiguration of your own self-hosted deployment (permissive CORS you set, secrets committed to
  your own fork, a Worker deployed without required bindings)
- Operational issues of the hosted `xid.dev` service that do not stem from a code defect in this
  repository. Report those to the hosted service contact instead.
- Missing security headers, cookie flags, or TLS configuration with no demonstrated impact
- Vulnerabilities in third-party dependencies with no exploitable path through XID. Report those
  upstream; tell us if XID's usage makes them exploitable.
- Denial of service through raw request volume against a deployment you control
- Reports generated by automated scanners without a working reproduction or impact analysis
- Social engineering, phishing, or physical attacks
- Findings against the pre-1.0 completeness gaps already documented in `docs/protocols/gap-audit.md`.
  Read it first; unimplemented is not the same as vulnerable.

## Note on the license

XID is distributed under the MIT License, which disclaims all warranties. That disclaimer is a legal
statement about liability, not a statement of intent. Reported vulnerabilities are triaged and fixed.
The disclaimer does mean there is no contractual security guarantee and no service level agreement
for self-hosted deployments.
