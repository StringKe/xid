---
type: references
name: lingui-setup-reference
description: How lingui is wired in XID - which package holds which lingui dependency, the full lingui.config.ts with the reason behind every option, the Vite plugin order, SPA and Worker activation paths, locale detection order, and the extract / compile / audit commands
---

# lingui Setup Reference

Setup and lookup material split out of the `i18n-lingui` rule. That rule holds the coding
conventions (never hardcode copy, which macro to use where, the SDK runtime-descriptor exception);
this file holds the wiring. Read it when you are adding a locale, touching `lingui.config.ts` or the
Vite plugin chain, changing how a catalog is loaded or activated, debugging a locale that does not
resolve, or running the extract / compile / audit commands.

## Dependencies and versions

lingui v6 (`6.2.0`), split across three places:

```
repo root devDependencies
  @lingui/cli               extract / compile CLI
  @lingui/conf              defineConfig types
  @lingui/format-po         po catalog format (formatter, must be passed explicitly in v6)

apps/server
  @lingui/core              runtime core (framework agnostic, runs in Workers)
  @lingui/react             React bindings (I18nProvider / Trans / useLingui)
  @lingui/vite-plugin       Vite integration, exports linguiTransformerBabelPreset
  @lingui/babel-plugin-lingui-macro / @rolldown/plugin-babel   macro transform (Vite 8)

packages/i18n            @lingui/core + @lingui/react as dependencies
packages/react           @lingui/react as a peerDependency (SDK does not bundle it)
```

macro import paths (lingui v6 -- `@lingui/macro` was removed and is no longer maintained):

- string macros: `import { t, msg, plural, select, selectOrdinal, defineMessage } from "@lingui/core/macro"`
- JSX macros: `import { Trans, useLingui } from "@lingui/react/macro"`

## lingui.config.ts (repo root)

```ts
import { defineConfig } from '@lingui/conf'
import { formatter } from '@lingui/format-po'

export default defineConfig({
  sourceLocale: 'en',
  locales: ['en', 'zh-Hans', 'ja', 'ko', 'fr', 'de', 'es', 'pt-BR'],
  compileNamespace: 'es',
  catalogs: [
    {
      path: '<rootDir>/packages/i18n/locales/{locale}/messages',
      include: ['apps/*/src/**', 'apps/*/worker/**', 'packages/*/src/**'],
      exclude: ['**/*.d.ts', '**/dist/**', '**/node_modules/**', '**/__tests__/**'],
    },
  ],
  format: formatter({ lineNumbers: false }),
})
```

- The config lives at the repo root; each app's `@lingui/vite-plugin` searches upward and finds it.
- `compileNamespace: 'es'` is mandatory. The lingui default (`cjs`, `module.exports=`) throws `module is not defined` when the browser loads a catalog as ESM, which silently skips `i18n.activate` and produces the "without setting a locale" race.
- `include` MUST spell out recursive `/**` segments. lingui uses `node:fs` globSync, so a wildcard-bearing entry like `apps/*/src` is not recognized as a directory, is never expanded to `/**/*.*`, and deep route files are skipped.
- `exclude` keeps generated `.d.ts` (for example `worker-configuration.d.ts`), build output and tests out. Babel fails on ambient declarations and aborts the whole extract.
- Locale tags are BCP 47 (`zh-Hans` not `zh-CN`, `pt-BR` not `pt`).
- v6 removed the `format: 'po'` string; you MUST pass `formatter()` from `@lingui/format-po`.

## Vite integration (macro transform)

`apps/server/vite.config.ts` plugin order, abridged to the i18n-relevant entries:

```ts
import { cloudflare } from '@cloudflare/vite-plugin'
import babel from '@rolldown/plugin-babel'
import { lingui, linguiTransformerBabelPreset } from '@lingui/vite-plugin'
import stylex from '@stylexjs/unplugin'
import react from '@vitejs/plugin-react'

plugins: [
  stylex.vite({ useCSSLayers: true, runtimeInjection: false }),
  react(),
  cloudflare(),
  lingui(),
  babel({ presets: [linguiTransformerBabelPreset()] }),
]
```

lingui v6 on Vite 8 runs macros through `@rolldown/plugin-babel` with `linguiTransformerBabelPreset`. **plugin-react 6 no longer accepts a `babel` field** (the old `react({ babel: {...} })` form raises TS2353), so the babel plugin is registered separately. `stylex.vite` comes before `react()`: the StyleX unplugin runs its own dedicated babel transform, which keeps it clear of the lingui macro chain.

## Runtime activation

The SPA and the Worker are separate isolates and activate independently.

- **React SPA**: `apps/server/src/lib/locale-context.tsx` owns activation. `activateEnglishLocale()` loads the English catalog synchronously for the first paint, `loadInitialLocale()` awaits the detected locale, and `LocaleProvider` wraps children in `<I18nProvider i18n={i18n} key={locale}>`. `apps/server/src/main.tsx` mounts the provider chain. Catalogs are loaded via dynamic `import('@xid-kit/i18n/locales/{locale}/messages.mjs')`.
- **Worker API**: `apps/server/worker/middleware/i18n.ts` creates a **per-request** instance with `setupI18n()`, loads the catalog and activates it, then stores it on the context. Concurrent requests in one isolate MUST NOT share a mutable global locale. `apps/server/worker/middleware/error.ts` renders `XidAPIError.message` with `c.get('i18n')._(errorMessages[code])` and never reads a global locale (see api-sdk-conventions rule).
- The runtime imports **compiled catalogs** (`messages.mjs`), never `.po`.

## Locale detection priority

- Worker (`apps/server/worker/lib/locale.ts`, `resolveLocale`): `?locale=` -> `user.locale` -> `Accept-Language` -> tenant default -> `en`.
- Browser (`apps/server/src/lib/locale.ts`, `detectLocale`): `?locale=` -> stored user preference (`localStorage` key `xid.locale`) -> `navigator.languages` -> `en`.

Both match exact BCP 47 tags first, then fall back by language subtag (`zh` -> `zh-Hans`, `pt` -> `pt-BR`). Anything unresolved falls back to `en`; **never render the message key**. Per-tenant uploaded language packs for white-label terminology are not implemented (the R2 language packs are a global path with no upload endpoint) -- do not write code that assumes they exist.

## Workflow

After adding or changing copy you MUST extract and compile. Details in the lingui-i18n skill (`.stdai/standards/skills/lingui-i18n/`).

```bash
pnpm run i18n:extract    # lingui extract -- scan source, write macro messages into .po
# translate the .po files
pnpm run i18n:compile    # lingui compile -- .po -> messages.mjs consumed at runtime
pnpm run i18n:audit      # vitest gate: no bypassed UI copy, no untranslated catalog entries
```

`pnpm run i18n:audit` runs `apps/server/src/lib/i18n-ui-audit.test.ts` (visible text nodes plus `aria-label` / `alt` / `placeholder` / `title` across `apps/server/src` and `packages/react/src`) and `packages/i18n/src/catalog.test.ts` (no empty translations, no whole-sentence source text left in a non-source locale). `pnpm check` includes it, and CI runs `pnpm check`. `pnpm run i18n:runtime` drives a real browser over the public entry points and asserts `html lang`, catalog loading and target-language copy.

Strict verification is `lingui compile --strict` (fails on missing translations). lingui v6 has no `--fail-on-warning` flag on extract -- the coverage gate is `pnpm run i18n:audit`, not an extract flag. Compiled catalogs are committed and MUST be fresh in the same commit as the source change.
