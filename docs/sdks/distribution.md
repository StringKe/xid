# SDK Distribution

Chinese version: [../zh-Hans/sdks/distribution.md](../zh-Hans/sdks/distribution.md)

This page separates a buildable release artifact from an artifact that has actually been published.
The repository currently authorizes the former only.

## TypeScript package graph

The npm release candidate version is `0.1.0-alpha.0`. The publishable graph contains:

- Public SDKs: `@xid-kit/core`, `backend`, `react`, `nextjs`, `vue`, `nuxt`, `svelte`, `angular`,
  `remix`, `astro`, `solid`, `react-native`, `expo`, `electron`, and `tauri`.
- Publishable runtime kernels: `@xid-kit/types`, `crypto`, and `protocol`.

The three kernels are included because public SDK artifacts import them at runtime or in their type
surface. Leaving those imports pointed at a private workspace package would produce an uninstallable
npm release. `@xid-kit/db`, `i18n`, `saml`, `webauthn`, and `web-ui` remain private implementation
packages and are not part of this graph.

Every publishable manifest has `private: false`, an MIT license, explicit `files`, dist-only
`main`/`module`/`types` and conditional exports, and `publishConfig.access: public`. Source manifests
use `workspace:^` for internal release edges. `pnpm pack` rewrites those edges to
`^0.1.0-alpha.0`; a packed manifest containing `workspace:`, `catalog:`, or a dependency on a
private `@xid-kit/*` package fails the gate.

Each manifest also carries its exact canonical documentation homepage under `https://xid.dev/sdks`.
The source contract rejects credentials, ports, query strings, fragments, non-HTTPS URLs, and a
homepage that does not match the package's canonical SDK page.

## Reproducible release artifact gate

Run the source-only contract check:

```bash
pnpm run sdk:distribution:contract
```

Run the full release artifact check:

```bash
pnpm run sdk:distribution:verify
# equivalent root entry
pnpm run pack
```

The full gate performs the following operations without publishing:

1. Builds every package with `vp pack`, including all documented subpath entries.
2. Creates 18 npm tarballs with `pnpm pack`.
3. Audits each tarball for its README, MIT license, canonical homepage, runtime entry, declaration
   entry, declared export targets, dependency versions, and the absence of source or test files.
4. Runs `node --check` against every emitted `.mjs` file.
5. Creates fresh temporary consumers outside the workspace. Their `@xid-kit` registry is pointed at
   an unreachable address so every installed XID package must come from one of the generated
   tarballs.
6. Installs representative dependency closures with normal npm peer resolution, without
   `--legacy-peer-deps`, resolves real public types with TypeScript using `skipLibCheck: false`, and
   runtime imports the host-independent entries. All 18 tarballs are still built and audited;
   framework-host-only packages are not installed together into one artificial application.
7. Verifies a browser consumer can use `@xid-kit/types` without installing Cloudflare ambient
   types. A separate Worker fixture imports `Env` from the type-only
   `@xid-kit/types/cloudflare` subpath with an explicit `@cloudflare/workers-types` dependency.
8. Verifies the React Native and Expo dependency graph resolves on React 19 without installing
   `react-dom` for the React Native-only fixture.

The source-only contract also keeps package versions aligned with `0.1.0-alpha.0`, including Nuxt's
runtime `moduleMetadata.version`, so framework tooling does not report a stale module version.

The temporary artifacts are deleted after the gate. To inspect one package manually:

```bash
pnpm --filter @xid-kit/core build
pnpm --dir packages/core pack --pack-destination /tmp/xid-sdk-packs
npm install /tmp/xid-sdk-packs/xid-kit-core-0.1.0-alpha.0.tgz
```

## Publication boundary

Passing the gate means the local tarballs are installable. It does not mean any package exists on
npm. No npm publish, dist-tag mutation, release tag, registry credential use, or provenance
attestation is performed by these scripts.

An external release still requires explicit authorization and a release owner to verify the npm
organization, package-name availability, version and dist-tag, credentials, provenance settings,
release notes, and the exact tarball digests. Until that happens, registry availability is
`UNKNOWN`, and README install commands that use package names describe the post-publication path.

## Native SDKs

The 13 SDKs under `sdk/` remain source-only. Their manifests contain package-format identity,
license, repository, and README metadata where the format supports it, and
`pnpm run native:verify` checks that metadata plus an explicit `Registry status: UNPUBLISHED`
statement in every README.

No crates.io, PyPI, Maven Central, RubyGems, Packagist, NuGet, CocoaPods, Swift Package Registry, or
pub.dev publication is claimed. Each README now gives a real VCS or local-path installation path.
Actual registry publication and registry name ownership remain `UNKNOWN` until separately
authorized and verified.

One coordinate has a confirmed conflict: `flutter pub publish --dry-run` reported an existing
pub.dev package named `xid` at `1.2.1`. This repository does not establish ownership of that package,
so the Flutter registry name is blocked until an explicit rename or ownership decision.
