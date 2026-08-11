# Contributing to XID

XID is an edge-native identity platform deployed as three Cloudflare Workers from one codebase.
Nimbus Site serves the complete localized docs from the apex, Console serves the isolated management UI,
and Core serves OIDC/OAuth, multi-tenant RBAC, enterprise SSO federation, Hosted Auth, and account
pages. Contributions are judged on protocol correctness, tenant isolation, and cryptographic
discipline before anything else.

Read [`SECURITY.md`](SECURITY.md) first if you found a vulnerability. Do not open a public issue for
security problems.

## License and contributor sign-off

The project is licensed under the MIT License. Contributions are accepted under the same terms
(inbound = outbound): by submitting a pull request you license your contribution under MIT. There is
no copyright assignment and no CLA.

Instead of a CLA, this project uses the **Developer Certificate of Origin (DCO) 1.1**. Every commit
must carry a `Signed-off-by` trailer certifying that you have the right to submit the code.

Sign off automatically when committing:

```bash
git commit -s -m "fix(protocol): reject plain PKCE challenge at token endpoint"
```

That appends a trailer built from your configured `user.name` and `user.email`:

```
Signed-off-by: Jane Doe <jane@example.com>
```

Rules:

- The sign-off name and email must match the commit author. Pseudonyms are acceptable if you use
  them consistently; fully anonymous sign-offs are not.
- To sign off a series you already wrote: `git rebase --signoff <base>`, then force-push. This is
  allowed only on a pull request branch that is solely yours, has not been reviewed yet, and has no
  other contributor's commits on it. Once review has started, rule 7 under "Pull request flow"
  applies instead: add new commits, never rewrite. `main` is never force-pushed.
- Pull requests with unsigned commits will be asked to amend before merge.

The full DCO text is reproduced at the end of this file.

## Prerequisites

Toolchain versions are pinned in `.mise.toml`:

| Tool | Pinned version | Minimum declared in `package.json` |
| ---- | -------------- | ---------------------------------- |
| Node | 24.15.0        | `engines.node >= 22.12.0`          |
| pnpm | 10.33.4        | `packageManager` pnpm@10.33.4      |

CI runs Node 24 with pnpm 10.33.4. If you use [mise](https://mise.jdx.dev/), `mise install` in the
repository root gives you the exact versions. Otherwise install Node and pnpm yourself and match the
pinned versions.

Native SDK work needs the corresponding toolchain installed locally (Go, Rust/cargo, Python, Ruby +
bundler, PHP + composer, JDK 17, .NET, Swift, Flutter, Gradle). You only need the one you are
touching.

## Getting started

```bash
pnpm install
pnpm run dev                         # Core, Console, and Nimbus Site in parallel
pnpm smoke:three-workers             # route ownership and cross-Worker smoke test
```

Common tasks (all defined in the root `package.json`):

```bash
pnpm run check      # full gate: turbo check + typecheck + native/i18n/protocol/coverage gates
pnpm test           # turbo run test (Vitest across the workspace)
pnpm run build      # turbo run build
pnpm run typecheck  # turbo run typecheck (tsc)
pnpm run fmt        # Oxfmt across the repository
pnpm run lint       # Oxlint
```

`pnpm run check` is the expensive one. It chains, in order:

1. `turbo run check` and `turbo run typecheck`
2. `pnpm run native:verify` (native SDK contract matrix only, no language toolchain)
3. `pnpm run i18n:audit` (catalog and hardcoded-string audit)
4. `pnpm run protocols:source-map` (protocol documentation to source mapping)
5. `pnpm run docs:translations` (Chinese mirror drift gate, see "Design and documentation changes")
6. `pnpm run test:key-paths`, `test:quality-gate`, `test:release-contracts`
7. `pnpm run test:coverage-gate` and `test:worker-coverage-gate`

Run it before pushing. Failing any of these turns CI red, and several of the gates are not obvious
from the diff alone.

Two security scripts exist and also run in CI:

```bash
pnpm run security:dependencies   # pnpm audit --prod --audit-level high
pnpm run security:secret-scan    # apps/server/scripts/check-repository-secrets.mjs
```

## Repository map

```
apps/site/       Nimbus docs Site: apex hub, 8-locale docs, SEO, Pagefind, agent surfaces, www 308.
apps/console/    Binding-free static management SPA for /console and /console/*.
apps/server/     Identity Core. worker/ is Hono (protocols, Management API, bindings);
                 src/ is the React 19 SPA for Hosted Auth and account pages.
packages/        22 @xid-kit/* packages: 7 kernel libraries (protocol, crypto, webauthn, saml,
                 db, i18n, types) and 15 TypeScript SDKs.
sdk/             13 native SDKs (go, rust, python, ruby, php, java, dotnet, ios, macos,
                 windows, linux, android, flutter).
docs/design/     Product design truth source. Change the design here before changing behavior.
docs/protocols/  Protocol matrices, gap audit, conformance plan.
tests/           Repository-level gates (native SDK contract, key paths, quality gate).
```

Toolchain ownership does not overlap:

- **pnpm** installs dependencies and resolves `workspace:*` links.
- **turborepo** is the only cross-package orchestrator (`turbo run <task>`).
- **vite-plus (`vp`)** provides lint (Oxlint), format (Oxfmt), test (Vitest), and library packaging
  (`vp pack`). Configured in the root `vite.config.ts`. There is no ESLint or Prettier.
- **Astro plus Nimbus** builds `apps/site`, including localized docs, Pagefind, SEO, Markdown and
  MDX twins, and LLM indexes. Configured in `apps/site/astro.config.ts`.
- **Standard Vite** builds `apps/console` and `apps/server`; Core also uses
  `@cloudflare/vite-plugin`. Configured in each app's `vite.config.ts`.

The root `vite.config.ts` configures code quality. The app-level build configurations are
independent.

## Contributing to the native SDKs

The 13 SDKs under `sdk/` are **not published to any package registry**. They exist so that server
and client integrations in each language can be verified against the same protocol contract. You do
not need to prepare release metadata (keywords, homepage, full descriptions) for them. Their
`license` field is MIT to stay consistent with the repository.

Verification is driven by `tests/native-sdk-contract.test.mjs`, which holds the per-platform command
matrix and asserts that every platform in it points at a directory that exists. CI installs no
language toolchain and runs none of these suites: `pnpm check` calls `native:verify`, which checks
the matrix only. Running a platform for real is a local, opt-in action. Check the matrix without
executing any language toolchain:

```bash
pnpm run native:verify
```

Run the actual test suite for one platform by setting `XID_NATIVE_SDK_PLATFORM`:

```bash
XID_NATIVE_SDK_PLATFORM=go node --test tests/native-sdk-contract.test.mjs
XID_NATIVE_SDK_PLATFORM=rust node --test tests/native-sdk-contract.test.mjs
```

Valid platform values, and what each one runs (from the matrix in that file):

| Platform  | Commands executed in the SDK directory                                       |
| --------- | ---------------------------------------------------------------------------- |
| `go`      | `go test ./...`                                                              |
| `rust`    | `cargo test`                                                                 |
| `linux`   | `cargo test`                                                                 |
| `python`  | `python -m pip install -e .[dev]` then `pytest`                              |
| `ruby`    | `bundle exec ruby -Itest` for the token, request, and webhook verifier tests |
| `php`     | `composer install` then `php run-tests.php` then `vendor/bin/phpunit`        |
| `java`    | `bash compile.sh`                                                            |
| `dotnet`  | `dotnet test tests`                                                          |
| `windows` | `dotnet test tests`                                                          |
| `ios`     | `swift test`                                                                 |
| `macos`   | `swift test`                                                                 |
| `android` | `gradle testDebugUnitTest`                                                   |
| `flutter` | `flutter pub get` then `flutter test`                                        |

If you change a platform's commands or move its directory, update the matrix in that file --
`native:verify` fails when a platform points at a directory that no longer exists. Nothing in
`.github/workflows/ci.yml` mirrors this matrix, so there is no second copy to keep in sync.

## Internationalization

All user-visible strings go through lingui macros. Hardcoded UI text fails `pnpm run i18n:audit`.

- JSX: `<Trans>Sign in to {tenant}</Trans>` from `@lingui/react/macro`
- Imperative strings: `const { t } = useLingui()` then `` t`Email is required` ``
- Non-component code (Worker handlers, API errors): define with `msg` from `@lingui/core/macro`,
  render with `i18n._()`
- Plurals and selects use ICU (`plural`, `select`), never hand-written branching

After changing any string:

```bash
pnpm run i18n:extract
pnpm run i18n:compile
```

Commit the updated catalogs in `packages/i18n/locales/`. There are 8 locales (en, zh-Hans, ja, ko,
fr, de, es, pt-BR). Transactional email templates are not part of lingui; they use a Mustache subset
with language packs in R2.

## Code conventions

TypeScript, enforced partly by Oxlint and partly by review.

Enforced by the linter (root `vite.config.ts`):

- `no-explicit-any`: error. Use `unknown` plus narrowing.
- `no-console`: error, except `console.warn` and `console.error` (and off inside Worker and kernel
  packages).
- `max-params`: warning above 4. Use an options object instead.

Enforced by review, not by the linter:

- No `enum`. Use an `as const` object plus a union type.
- Use `type` aliases, not `interface`, for objects, unions, and intersections.
- Named exports. `export default` only where a framework requires it (Worker entry, route
  components, Vite configs).
- Files stay under roughly 300 lines, functions under 50, cyclomatic complexity under 10, nesting
  under 3 levels. Flatten with early returns and guard clauses.
- Explicit return types on exported functions.
- Comments explain why, not what. Do not leave changelog-style comments in code.
- File names are kebab-case; React component files may be PascalCase.

Runtime and architecture constraints:

- Web standard APIs first (`fetch`, `URL`, `crypto.subtle`). Node APIs only where `nodejs_compat`
  is already required.
- **Never implement cryptographic primitives.** ECDSA, RSA, AES, SHA, HKDF, and random number
  generation come from Web Crypto (`crypto.subtle`, `crypto.getRandomValues`). Protocol and business
  logic are written in-house; XML digital signatures use `xmldsigjs` and `@xmldom/xmldom`. Do not
  add a general-purpose crypto library for core signing or verification.
- Issuer, signing keys, RPID, and tenant policy come from `TenantContext`. A module-level constant
  holding any of these is a bug.
- Every D1 query goes through the tenant-scoped query layer in `@xid-kit/db`, which injects
  `tenant_id` (and `org_id` where applicable). D1 has no row-level security; the application layer is
  the only isolation boundary. No raw SQL bypasses.
- Cloudflare bindings (D1, KV, R2, Queues, Durable Objects) are accessed through typed wrappers, not
  called directly from feature code.

Reuse the existing kernel packages instead of reimplementing: `@xid-kit/crypto` for signing and
hashing, `@xid-kit/protocol` for OIDC/OAuth logic, `@xid-kit/webauthn` for assertion verification,
`@xid-kit/saml` for SAML.

## Testing policy

When a **major new feature** is added to software this project produces, automated tests for that
feature **must** be added in the same change set (or an immediately following commit in the same
pull request). This is a standing project policy, not optional guidance.

Vitest is the FLOSS automated test suite for TypeScript packages and apps. Files are named
`<name>.test.ts` next to the code under test. Arrange, Act, Assert, separated by blank lines. Test
names describe the scenario and expectation, for example `it('rejects PKCE plain challenge', ...)`.

Invoke tests the standard way:

```bash
pnpm test           # turbo run test (Vitest across the workspace)
pnpm run check      # full gate including coverage and protocol gates
```

CI runs these on every pull request and on pushes to `main` (see `.github/workflows/ci.yml`).

A pull request **must** include tests when it touches:

- **Protocol correctness**: PKCE S256 enforcement, exact `redirect_uri` matching, refresh token
  rotation and family revocation, authorization code single use, `jti` replay protection, ID token
  and access token claims.
- **Tenant isolation**: any new entity or endpoint needs a cross-tenant test that accesses org B's
  resource with org A's context and asserts 403 or 404 without leaking existence.
- **Cryptographic paths**: password hashing and verification, envelope encryption, key rotation,
  signature verification, webhook HMAC validation.
- **Concurrency and replay semantics**: anything backed by a Durable Object (WebAuthn challenges,
  OAuth state, session revocation, rate limiting).
- **Enumeration protection**: authentication responses must stay uniform between "user does not
  exist" and "wrong credential".

Prefer boundary and failure paths: empty input, oversized input, expired tokens, clock skew, cloned
`sign_count`, malformed external IdP responses. Do not write tests for placeholders, pure types, or
third-party library behavior.

The pull request template repeats this policy under its checklist so reviewers can verify that tests
were considered. Evidence that the policy is followed appears in co-located `*.test.ts` files and
repository-level gates under `tests/`.

## Warnings, lint, and static analysis

Quality gates (not optional for merge):

| Tool | Role | How it runs |
| ---- | ---- | ----------- |
| Oxlint + Oxfmt | Lint and format (warnings treated as CI failures where configured as errors) | `pnpm run check` / `pnpm run lint` |
| TypeScript `tsc --noEmit` | Strict typecheck | `pnpm run typecheck` via turbo in `pnpm run check` |
| CodeQL | Static analysis for common vulnerability classes | `.github/workflows/codeql.yml` on PR, push to `main`, weekly cron |
| `pnpm audit` | Production dependency advisories | `pnpm run security:dependencies` |
| Secret scan script | Repo secret leak check | `pnpm run security:secret-scan` |

Do not disable lint or type rules to hide a defect. Fix the root cause or, for a true false positive,
narrow the exception with a documented reason next to the config change.

## Commits and pull requests

Commit messages follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<scope>): <description>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`.
Breaking changes append `!` to the type, for example `feat(api)!: remove legacy endpoint`.

Pull request flow:

1. Branch from `main`. Do not push directly to `main`.
2. Keep the change focused. Unrelated refactors belong in a separate pull request.
3. Sign off every commit (`git commit -s`).
4. Run `pnpm run check` and `pnpm test` locally.
5. Fill in the pull request template, including the checklist.
6. CI must be green. Review is required before merge.
7. Do not rewrite history on a branch that has been reviewed or that another contributor has pushed
   to; add commits instead. The one exception is the pre-review sign-off rebase described under
   "License and contributor sign-off".

Do not commit `.env` files, secrets, real tenant identifiers, tokens, client secrets, or private
keys. `pnpm run security:secret-scan` catches some of this, but it is not a substitute for care.

## Design and documentation changes

`docs/design/` is the truth source for product behavior, indexed by `docs/design/README.md`. A change
in behavior starts as a change there, then in the implementation. If a pull request contradicts a
documented design decision, say so explicitly and explain why the decision should change.

### Documents that have a Chinese mirror

Fourteen English documents are mirrored under `docs/zh-Hans/`, and every one of them is covered by
the `pnpm run docs:translations` gate inside `pnpm run check`. The English file is always
authoritative; the mirror follows it.

Each mirror sits at the same relative path under `docs/zh-Hans/`, so
`docs/design/03-oidc-oauth.md` is mirrored by `docs/zh-Hans/design/03-oidc-oauth.md`. The full list:

- `docs/README.md`
- `docs/deployment.md`
- `docs/soft-delete.md`
- `docs/sdks/platform-matrix.md`
- `docs/design/README.md`
- the nine design chapters, `docs/design/00-overview.md` through `docs/design/08-data-model.md`

Nothing else is mirrored. `docs/i18n.md`, everything under `docs/protocols/`, and this file are
English-only.

### How the drift gate works

Line 1 of each mirror is a machine-readable marker:

```
<!-- xid-translation source=docs/design/00-overview.md source-commit=<short sha> source-blob=<40 hex> -->
```

`tests/docs/translation-drift.test.mjs` recomputes the git blob sha of the English source in pure
Node and compares it against `source-blob`. So **editing an English source listed above and leaving
its mirror alone turns `pnpm run check` red**, even when the edit is a one-word typo fix. The test
also asserts that the set of mirrored sources matches its `EXPECTED_MIRRORS` list exactly, so adding
or deleting a mirror means editing that list in the same commit.

The gate's failure messages are written in Chinese. If you get an unexpected failure out of
`pnpm run docs:translations`, this section is the English explanation of it.

After changing an English source that has a mirror:

1. Update the Chinese text in the corresponding `docs/zh-Hans/` file so it still says the same thing.
2. Refresh the markers:

```bash
node scripts/refresh-translation-markers.mjs
```

3. Re-run the gate:

```bash
pnpm run docs:translations
```

Run the refresh script only **after** the translation is actually correct. Refreshing the sha is a
claim that the mirror is in sync; running it on an untranslated mirror silently erases the drift the
gate exists to catch.

### If you do not read Chinese

Do not machine-translate the mirror. A wrong Chinese design chapter is worse than a stale one,
because the marker will then claim it is current.

Instead:

1. Change the English source only, and leave the mirror untouched.
2. Say so in the pull request description: list the English files you changed and note that the
   `docs/zh-Hans/` mirrors need a maintainer translation.
3. Expect `pnpm run docs:translations` to fail locally and in CI. That is the intended signal, not
   something for you to work around.

A maintainer will translate the mirror and refresh the markers before merge. This is the only gate in
`pnpm run check` that a contributor is allowed to hand off rather than fix.

## AI assistant configuration files

Two targets are enabled in `.stdai/config.toml`, and each one generates its files mechanically from
the sources in `.stdai/standards/`:

- `claude-code` -> `CLAUDE.md`, `.claude/rules/`, `.claude/commands/`, `.claude/skills/`
- `codex` -> `AGENTS.md`, `.agents/`

Do not edit the generated files. Edit the source under `.stdai/standards/` and re-run
`stdagent sync`, and commit both. They are excluded from Oxfmt so formatting never fights the
generator.

## Getting help

See [`SUPPORT.md`](SUPPORT.md).

---

## Developer Certificate of Origin 1.1

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.
1 Letterman Drive
Suite D4700
San Francisco, CA, 94129

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

The canonical text is published at https://developercertificate.org/.
