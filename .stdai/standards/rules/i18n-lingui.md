---
type: rules
name: i18n-lingui
description: lingui for Site, Core UI, Console, shared UI, React SDK and Worker errors; email stays on Mustache
priority: high
applyTo:
  - 'apps/server/src/**/*.tsx'
  - 'apps/server/src/**/*.ts'
  - 'apps/console/src/**/*.tsx'
  - 'apps/console/src/**/*.ts'
  - 'apps/site/src/**/*.astro'
  - 'apps/site/src/**/*.ts'
  - 'packages/web-ui/**/*.tsx'
  - 'packages/web-ui/**/*.ts'
  - 'packages/react/**/*.tsx'
  - 'packages/i18n/**/*.ts'
  - 'apps/server/worker/lib/locale.ts'
  - 'apps/server/worker/lib/errors.ts'
  - 'apps/server/worker/middleware/i18n.ts'
  - 'apps/server/worker/middleware/error.ts'
  - 'lingui.config.ts'
targets: [claude-code, codex]
---

# Localization: the lingui stack

lingui is the only i18n stack for `apps/site`, `apps/server/src`, `apps/console`, `packages/web-ui`,
`packages/react`, and user-facing Worker API errors. **Transactional email is out of scope**:
Mustache plus R2 language packs. Workflow `docs/i18n.md`.

## MUST

- **Never hardcode user-facing copy.** Every visible string goes through lingui.
- Nimbus Site has no React runtime. Astro shell copy and document AST copy use `MessageDescriptor`
  values rendered from the shared compiled catalogs during static generation.
- SPA JSX: `<Trans>Sign in to {tenant}</Trans>`, never string concatenation. Imperative SPA strings
  (toast / alt / aria-label): `const { t } = useLingui(); t\`Email is required\``.
- **The React SDK does NOT use macros.** It declares runtime descriptors in
  `packages/react/src/i18n-runtime.tsx` (`sdkMessages`, keyed `sdk.*`) rendered through `Rt` and
  `rt(translate, descriptor)`, extracted via the `/*i18n*/` marker. That keeps `@lingui/react` a peer
  dependency -- do not reintroduce `@lingui/react/macro` imports there.
- Non-component contexts (plain `.ts`, Worker handlers, API errors): declare lazy messages with `msg`
  and render with `i18n._(descriptor)`. Every `XidErrorCode` has a descriptor in
  `packages/i18n/src/messages.ts`.
- Plurals and choices go through ICU, never hand-written `if/else`.
- Do not hand-write macro `id`s; disambiguate with `msg({ message, context })`. Explicit ids exist
  only in the SDK runtime descriptors, where they are the addressing mechanism.
- On every copy change: extract, then compile, and commit the refreshed compiled catalogs in the same
  commit as the source change.

Dependency layout, `lingui.config.ts`, Vite plugin order and macro transform, activation paths,
locale detection order, extract / compile / audit commands: reference `lingui-setup-reference` --
read before adding a locale, editing the config or plugin chain, or debugging locale resolution.
