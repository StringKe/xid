# SDK Distribution

Chinese version: [../zh-Hans/sdks/distribution.md](../zh-Hans/sdks/distribution.md)

XID publishes no packages to npm or to any other package registry. Every SDK, the TypeScript
`@xid-kit/*` packages under `packages/` and the 13 native SDKs under `sdk/`, is distributed as source
in the XID repository. Applications use an SDK from a checkout of the repository: through the pnpm
workspace, by vendoring locally built tarballs, or through the native toolchain's Git or local-path
dependency.

Every `packages/*/package.json` is `"private": true` and has no `publishConfig`, so `npm publish` and
`pnpm publish` refuse to run. `pnpm run sdk:distribution:contract`, the first step of `pnpm check`,
fails if any package drops either guard. No CI workflow or script publishes to a registry.

## TypeScript packages

The source version of every TypeScript SDK is `0.1.0-alpha.0`. Pin the repository commit you build
from; the version string alone does not identify a build.

| Package                                              | Purpose                                    |
| ---------------------------------------------------- | ------------------------------------------ |
| `@xid-kit/core`                                      | Browser client                             |
| `@xid-kit/backend`                                   | Server-side token and request verification |
| `@xid-kit/react`, `nextjs`, `vue`, `nuxt`, `svelte`  | Web framework bindings                     |
| `@xid-kit/angular`, `remix`, `astro`, `solid`        | Web framework bindings                     |
| `@xid-kit/react-native`, `expo`, `electron`, `tauri` | Mobile and desktop bindings                |
| `@xid-kit/types`, `crypto`, `protocol`               | Runtime kernels the SDKs above import      |

`@xid-kit/db`, `i18n`, `saml`, `webauthn`, and `web-ui` are internal to the XID Core and Console and
are not meant for application use.

Each SDK `package.json` points `main`, `module`, `types`, and `exports` at `dist/`. `dist/` is not
committed, so every consumption path below builds the package first with `vp pack` through the
package's `build` script.

### Inside the XID workspace

An application or example that lives in this repository depends on the SDK through the workspace
protocol:

```json
{
  "dependencies": {
    "@xid-kit/core": "workspace:^"
  }
}
```

Build the consumer together with its SDK dependencies. turbo builds each dependency first:

```bash
pnpm install
pnpm --filter <your-app>... build
```

### Outside the XID workspace: vendored tarballs

An application in another repository vendors tarballs built from a pinned XID commit.

1. Build the SDK and pack its dependency closure from a checkout:

   ```bash
   git clone https://github.com/StringKe/xid.git
   cd xid
   git checkout <commit>
   pnpm install --frozen-lockfile
   pnpm --filter @xid-kit/backend... build
   for pkg in types crypto backend; do
     pnpm --dir "packages/$pkg" pack --pack-destination /path/to/your-app/vendor/xid
   done
   ```

   `pnpm pack` rewrites internal `workspace:^` dependencies to `^0.1.0-alpha.0` and keeps only
   `dist/`, `README.md`, and `package.json` in each tarball.

2. Reference every tarball of the closure from the application's `package.json`:

   ```json
   {
     "dependencies": {
       "@xid-kit/types": "file:vendor/xid/xid-kit-types-0.1.0-alpha.0.tgz",
       "@xid-kit/crypto": "file:vendor/xid/xid-kit-crypto-0.1.0-alpha.0.tgz",
       "@xid-kit/backend": "file:vendor/xid/xid-kit-backend-0.1.0-alpha.0.tgz"
     }
   }
   ```

3. Install with your package manager (`npm install`, `pnpm install`, or `yarn install`) and commit the
   tarballs with the application.

List the whole closure. The `^0.1.0-alpha.0` ranges inside each tarball resolve to the tarballs
listed in your `package.json`; a missing entry makes the package manager look for it in a registry,
where it does not exist.

| SDK                     | Tarballs to vendor (`packages/<dir>`)                               |
| ----------------------- | ------------------------------------------------------------------- |
| `@xid-kit/types`        | `types`                                                             |
| `@xid-kit/crypto`       | `types`, `crypto`                                                   |
| `@xid-kit/protocol`     | `types`, `crypto`, `protocol`                                       |
| `@xid-kit/core`         | `types`, `crypto`, `protocol`, `core`                               |
| `@xid-kit/backend`      | `types`, `crypto`, `backend`                                        |
| `@xid-kit/react`        | `types`, `crypto`, `protocol`, `core`, `react`                      |
| `@xid-kit/vue`          | `types`, `crypto`, `protocol`, `core`, `vue`                        |
| `@xid-kit/angular`      | `types`, `crypto`, `protocol`, `core`, `angular`                    |
| `@xid-kit/solid`        | `types`, `crypto`, `protocol`, `core`, `solid`                      |
| `@xid-kit/electron`     | `types`, `crypto`, `protocol`, `core`, `electron`                   |
| `@xid-kit/tauri`        | `types`, `crypto`, `protocol`, `core`, `tauri`                      |
| `@xid-kit/svelte`       | `types`, `crypto`, `protocol`, `core`, `backend`, `svelte`          |
| `@xid-kit/astro`        | `types`, `crypto`, `protocol`, `core`, `backend`, `astro`           |
| `@xid-kit/nextjs`       | `types`, `crypto`, `protocol`, `core`, `backend`, `react`, `nextjs` |
| `@xid-kit/remix`        | `types`, `crypto`, `protocol`, `core`, `backend`, `react`, `remix`  |
| `@xid-kit/nuxt`         | `types`, `crypto`, `protocol`, `core`, `backend`, `vue`, `nuxt`     |
| `@xid-kit/react-native` | `types`, `crypto`, `protocol`, `react-native`                       |
| `@xid-kit/expo`         | `types`, `crypto`, `protocol`, `react-native`, `expo`               |

Framework peers such as `react`, `vue`, or `expo` come from your normal registry as usual.

### Vendoring verification

Run the manifest check:

```bash
pnpm run sdk:distribution:contract
```

Run the full vendoring check:

```bash
pnpm run sdk:distribution:verify
# equivalent root entry
pnpm run pack
```

The full check performs these steps and contacts no XID package registry:

1. Builds every SDK with `vp pack`, including all documented subpath entries.
2. Creates 18 tarballs with `pnpm pack`.
3. Audits each tarball for its README, MIT license, canonical homepage, runtime entry, declaration
   entry, declared export targets, `"private": true`, dependency versions, and the absence of source
   or test files.
4. Runs `node --check` against every emitted `.mjs` file.
5. Creates fresh temporary consumers outside the workspace that depend on the tarballs through
   `file:` references. Their `@xid-kit` scope points at an unreachable address, so every installed
   XID package must come from a tarball.
6. Installs representative dependency closures with normal npm peer resolution, without
   `--legacy-peer-deps`, resolves the public types with TypeScript using `skipLibCheck: false`, and
   runtime imports the host-independent entries. Framework-host-only packages are built and audited
   but not installed together into one artificial application.
7. Verifies a browser consumer can use `@xid-kit/types` without installing Cloudflare ambient types.
   A separate Worker fixture imports `Env` from the type-only `@xid-kit/types/cloudflare` subpath with
   an explicit `@cloudflare/workers-types` dependency.
8. Verifies the React Native and Expo dependency graph resolves on React 19 without installing
   `react-dom` for the React Native-only fixture.

The manifest check also keeps package versions aligned with `0.1.0-alpha.0`, including Nuxt's runtime
`moduleMetadata.version`, so framework tooling does not report a stale module version. The temporary
consumers and tarballs are deleted after the check.

## Native SDKs

The 13 SDKs under `sdk/` use their own toolchain's source dependency mechanism. Each README gives the
exact command.

| SDK           | How an application consumes it                                                           |
| ------------- | ---------------------------------------------------------------------------------------- |
| Go            | Go module from the Git repository: `go get github.com/StringKe/xid/sdk/go@<commit>`      |
| Rust, Linux   | Cargo `path` dependency on `sdk/rust` or `sdk/linux` in a checkout                       |
| Python        | `pip install` from the Git repository with `#subdirectory=sdk/python`                    |
| Ruby          | Gemfile `path` dependency, or `gem build` and `gem install` from a checkout              |
| PHP           | Composer `path` repository pointing at `sdk/php`                                         |
| Java          | `mvn install` in `sdk/java`, then the `dev.xid:xid-sdk-java` coordinate from local Maven |
| Android       | Gradle project included from `sdk/android`                                               |
| .NET, Windows | `ProjectReference` to the `.csproj` in a checkout                                        |
| iOS, macOS    | Swift Package Manager local package path                                                 |
| Flutter       | pub `git` dependency with `path: sdk/flutter`                                            |

Each manifest carries package-format identity, MIT license, repository, and README metadata where the
format supports it. `pnpm run native:verify` checks that metadata and the source-distribution
statement at the top of every native README.
