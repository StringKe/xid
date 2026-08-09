---
type: references
name: toolchain-command-reference
description: Which command to run for install, dev, build, lint, typecheck, test, and deploy in each XID workspace, what pnpm check actually chains in CI, plus the pnpm-workspace.yaml and root vite.config.ts examples
---

# Toolchain Command Reference

Lookup material split out of the `monorepo-toolchain` rule. That rule states who owns what
(pnpm / turborepo / Vite+ / standard Vite); this file holds the concrete commands, the CI gate
composition, and the two configuration file examples. Read it when you need to run something in this
repo, when you are adding a workspace member, or when you are about to edit
`pnpm-workspace.yaml`, the root `package.json` `pnpm` key, or the root `vite.config.ts`.

## Command Reference

| Action      | apps/site                         | apps/console                        | apps/server                         | packages/\*                        | Whole repo                              |
| ----------- | --------------------------------- | ----------------------------------- | ----------------------------------- | ---------------------------------- | --------------------------------------- |
| Install     | `pnpm install`                    | `pnpm install`                      | `pnpm install`                      | --                                 | `pnpm install`                          |
| Dev         | `pnpm --filter @xid-kit/site dev` | `pnpm --filter @xid-kit/console dev`| `pnpm --filter @xid-kit/server dev` | --                                 | `pnpm dev`                              |
| Build       | `pnpm --filter @xid-kit/site build` | `pnpm --filter @xid-kit/console build` | `pnpm --filter @xid-kit/server build` | `vp pack`                       | `pnpm build`                            |
| Check       | package `check` script            | package `check` script              | zero-warning budget wrapper         | `vp check`                         | `turbo run check`                       |
| Type check  | package `typecheck` script        | `tsc --noEmit -p tsconfig.json`     | `tsc --noEmit -p tsconfig.json`     | `tsc --noEmit -p tsconfig.json`    | `pnpm typecheck`                        |
| Test        | package `test` plus route audit   | package `test`                      | Worker + SPA Vitest configs         | `vp test`                          | `pnpm test`                             |
| Format      | --                                | --                                  | --                                  | --                                 | `pnpm fmt`                              |
| Full gate   | --                                | --                                  | --                                  | --                                 | `pnpm check`                            |
| Release     | Workers Builds `wrangler deploy` | Workers Builds `wrangler deploy` | Workers Builds D1 migration plus `wrangler deploy` | -- | Cloudflare Workers Builds |

Notes that matter when you run these:

- `apps/server`'s `check` wraps `vp check` in `scripts/check-lint-warning-budget.mjs` with a budget
  of **zero warnings**, so an Oxlint warning fails the app build gate even though it is only a warn.
- `apps/server` does not use `vp test`: it runs two Vitest projects, one for the Worker
  (`vitest.worker.config.ts`) and one for the Hosted Auth/account SPA (`vitest.spa.config.ts`).
  Smoke tests use `vitest.smoke.config.ts`.
- `apps/site` build order is localized content generation -> Astro/Nimbus static build -> Pagefind
  -> complete `dist` route audit. A raw `astro build` is not the Site release artifact.
- `apps/console` uses standard Vite with base `/console/`; its tests cover the React SPA and the
  ASSETS-only Worker boundary.
- Root `pnpm check` is the real CI gate and is much wider than `turbo run check`: it chains
  `turbo run check`, `turbo run typecheck`, the native SDK contract test, the i18n audit, the
  protocol source map, and several coverage / quality / release-contract gates. CI
  (`.github/workflows/ci.yml`) runs `pnpm check`, `pnpm test`, `pnpm build`, and `pnpm smoke:l2-l3`.
- Site, Console, and Core deploy independently from the `main` branch through Cloudflare Workers
  Builds. Site and Console run `wrangler deploy`. Core applies remote D1 migrations and then runs
  `wrangler deploy`. Non-production branch builds are disabled.
  GitHub Actions verifies the repository and never deploys it. There is no direct `deploy` script in
  any `package.json` and no `deploy` task in `turbo.json`.

turbo `check` / `typecheck` / `test` **do not depend on build**: internal packages are consumed
straight from source (`main` points at `src/index.ts`), so type checking needs no prior build. Only
`build` and `pack` declare `dependsOn: ["^build"]`.

## Scaffolding

`apps/server` originally came from the Cloudflare C3 React template:

```bash
pnpm create cloudflare@latest <name> --framework=react   # SPA + Worker app
```

It has since diverged substantially (TanStack Router, lingui, StyleX, custom Vite plugins), so treat
that command as history, not as something to re-run against the existing app.

`apps/site` is generated once from `@cloudflare/create-nimbus-docs@0.6.3`, then owned by this
monorepo. `@cloudflare/nimbus-docs` is pinned exactly to `0.9.0`, Astro stays on compatible 7.x, and
the Site remains static output with no Cloudflare SSR adapter.

`apps/console` is a standard Vite React app extracted from the former Core SPA. It is not scaffolded
by rerunning C3 against the repository.

New library packages, including private `@xid-kit/web-ui`, get a hand-written `package.json`: `main`
and `types` point at
`./src/index.ts`, `build` is `vp pack`, `check` is `vp check`, `test` is `vp test`, and `typecheck`
is `tsc --noEmit -p tsconfig.json`.

## pnpm workspace

```yaml
# pnpm-workspace.yaml
packages:
  - 'apps/*'
  - 'packages/*'

catalog:
  hono: ^4.12.30
  drizzle-orm: ^0.45.2
  '@lingui/core': ^6.2.0
  react: ^19.2.6
  vite: ^8.0.16
  vitest: ^4.1.10
  # ... the rest of the shared third-party versions

overrides:
  typescript: ^6.0.3
  undici: ^7.28.0
  # ... transitive version pins
```

- Only `apps/*` and `packages/*` are workspace members. The `sdk/` tree holds the non-JS SDK matrix
  (go, rust, php, swift, and so on); it is outside the pnpm workspace and excluded from Oxfmt.
- Internal packages reference each other with `workspace:*` (for example `apps/server` depends on
  `packages/protocol` as `"@xid-kit/protocol": "workspace:*"`).
- Third-party versions go through the catalog (`"hono": "catalog:"`) so versions cannot drift.
  Transitive pins go in the `overrides` block of the same file.
- `onlyBuiltDependencies` lives in the **root `package.json`** under the `pnpm` key, not in
  `pnpm-workspace.yaml`. Current list: `esbuild`, `workerd`, `sharp` -- pnpm 10 ignores build
  scripts unless a package is approved there.
- Toolchain versions are pinned in the root `package.json`: `packageManager` is pnpm 10,
  `engines.node` is `>=22.12.0`, and `vite-plus`, `turbo`, `typescript`, and `wrangler` are root
  devDependencies.

## Vite+ Quality Config (root `vite.config.ts`)

`import { defineConfig } from 'vite-plus'`. The root config holds the shared Oxfmt and Oxlint
settings and uses `overrides` for per-package glob settings. There is no `test` block at the root --
each app and package owns its own Vitest configuration.

```ts
import { defineConfig } from 'vite-plus'

export default defineConfig({
  fmt: {
    singleQuote: true,
    semi: false,
    ignorePatterns: ['CLAUDE.md', 'AGENTS.md', '.claude/**', '.codex/**', '.agents/**', 'sdk/**'],
  },
  lint: {
    plugins: ['typescript'],
    // tsgo crashed natively and under-reported real type errors on the larger packages,
    // so type checking moved to the turbo `typecheck` task (official tsc).
    options: { typeAware: false, typeCheck: false },
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-explicit-any': 'error',
      'max-params': ['warn', 4],
    },
    overrides: [
      {
        files: [
          'apps/server/src/**',
          'apps/console/src/**',
          'packages/react/**',
          'packages/web-ui/**',
        ],
        plugins: ['typescript', 'react'],
      },
      {
        files: ['apps/server/worker/**', 'packages/protocol/**', 'packages/db/**'],
        env: { node: true },
        rules: { 'no-console': 'off' },
      },
      { files: ['**/*.test.ts', '**/*.spec.ts'], plugins: ['typescript', 'vitest'] },
    ],
  },
})
```

- The snippet above is abridged; read the real file before editing it. The node-env override covers
  every kernel package (`protocol`, `webauthn`, `crypto`, `saml`, `db`, `backend`) plus Worker
  entries, and `fmt.ignorePatterns` also excludes the lingui compile output.
- Setting `plugins` in an override **replaces** the base `lint.plugins`, so list them all
  (for example `['typescript', 'react']`).
- Globs resolve from the root `vite.config.ts` and use workspace-relative paths (`apps/server/src/**`).
- Everything stdagent generates (`CLAUDE.md`, `AGENTS.md`, `.claude/**`, `.codex/**`, `.agents/**`)
  is excluded from Oxfmt and listed in `.oxlintignore`; reformatting it would fight `stdagent sync`.
- The root `vite.config.ts` is the Vite+ quality config. `apps/server/vite.config.ts` and
  `apps/console/vite.config.ts` are standard Vite app configs. `apps/site/astro.config.ts` owns the
  Nimbus/Astro build and passes only its integration-specific options into Vite.
