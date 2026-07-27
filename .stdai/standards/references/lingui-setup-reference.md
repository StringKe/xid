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

apps/server + apps/console
  @lingui/core              runtime core (framework agnostic, runs in Workers)
  @lingui/react             React bindings (I18nProvider / Trans / useLingui)
  @lingui/vite-plugin       Vite integration, exports linguiTransformerBabelPreset
  @lingui/babel-plugin-lingui-macro / @rolldown/plugin-babel   macro transform (Vite 8)

apps/site
  @lingui/core for localized static content and Astro shell descriptors
  @lingui/vite-plugin + babel macro transform through astro.config.ts

packages/i18n            @lingui/core + @lingui/react as dependencies
packages/web-ui          @lingui/core + @lingui/react for shared product UI and LocaleProvider
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

## Build integration (macro transform)

`apps/server/vite.config.ts` and `apps/console/vite.config.ts` use this plugin order, abridged to
the i18n-relevant entries:

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

`apps/site/astro.config.ts` owns the Nimbus/Astro build and applies the lingui macro transform to
Astro support modules. It has no React integration or StyleX plugin. It MUST stay a static build and
MUST NOT add a second catalog or a Cloudflare SSR locale runtime.

## Runtime activation

Each browser app and the Core Worker activate independently.

- **Core UI and Console**: the shared browser activation and `LocaleProvider` live in private
  `@xid-kit/web-ui`. `apps/server/src/main.tsx` and `apps/console/src/main.tsx` each mount their own
  provider instance. They load catalogs via dynamic
  `import('@xid-kit/i18n/locales/{locale}/messages.mjs')`; neither app shares mutable runtime state.
- **Nimbus Site**: localized content generation reads the same compiled catalogs before the Astro
  content scan. Astro derives the locale from the canonical URL and renders static HTML. There is no
  browser Lingui provider or React island.
- **Worker API**: `apps/server/worker/middleware/i18n.ts` creates a **per-request** instance with `setupI18n()`, loads the catalog and activates it, then stores it on the context. Concurrent requests in one isolate MUST NOT share a mutable global locale. `apps/server/worker/middleware/error.ts` renders `XidAPIError.message` with `c.get('i18n')._(errorMessages[code])` and never reads a global locale (see api-sdk-conventions rule).
- The runtime imports **compiled catalogs** (`messages.mjs`), never `.po`.

## Locale detection priority

- Worker (`apps/server/worker/lib/locale.ts`, `resolveLocale`): `?locale=` -> `user.locale` -> `Accept-Language` -> tenant default -> `en`.
- Core UI and Console browser detection: `?locale=` -> stored user preference (`localStorage` key
  `xid.locale`) -> `navigator.languages` -> `en`.
- Nimbus Site rendering: canonical locale path -> `en` for an unprefixed public URL. The language
  switch updates `xid.locale` and navigates to the corresponding locale path. Legacy `?locale=`
  public URLs are redirected to the canonical path before rendering.

Both match exact BCP 47 tags first, then fall back by language subtag (`zh` -> `zh-Hans`, `pt` -> `pt-BR`). Anything unresolved falls back to `en`; **never render the message key**. Per-tenant uploaded language packs for white-label terminology are not implemented (the R2 language packs are a global path with no upload endpoint) -- do not write code that assumes they exist.

## Workflow

After adding or changing copy you MUST extract and compile. Details in the lingui-i18n skill (`.stdai/standards/skills/lingui-i18n/`).

```bash
pnpm run i18n:extract    # lingui extract --clean -- scan source and remove obsolete messages
# translate the .po files
pnpm run i18n:compile    # lingui compile -- .po -> messages.mjs consumed at runtime
pnpm run i18n:audit      # vitest gate: no bypassed UI copy, no untranslated catalog entries
```

`pnpm run i18n:audit` scans visible React text nodes plus `aria-label` / `alt` / `placeholder` /
`title` across Console, Core UI, `packages/web-ui` and `packages/react`. Site Astro shell and
document AST descriptors have separate Site tests. The audit then runs
`packages/i18n/src/catalog.test.ts` for empty or untranslated entries. `pnpm check` includes it, and
CI runs `pnpm check`. `pnpm run i18n:runtime` drives real browser entry points for Site, Console and
Core UI and asserts `html lang`, catalog loading and target-language copy.

Strict verification is `lingui compile --strict` (fails on missing translations). lingui v6 has no `--fail-on-warning` flag on extract -- the coverage gate is `pnpm run i18n:audit`, not an extract flag. Compiled catalogs are committed and MUST be fresh in the same commit as the source change.
