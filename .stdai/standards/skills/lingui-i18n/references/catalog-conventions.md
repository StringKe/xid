# lingui catalog conventions

## Layout (one catalog for the whole monorepo)

```
lingui.config.ts                          # repo root, NOT inside packages/i18n
packages/i18n/locales/en/messages.po      # sourceLocale, extract fills msgstr from msgid
packages/i18n/locales/en/messages.mjs     # compiled artifact (imported at runtime)
packages/i18n/locales/zh-Hans/messages.po
packages/i18n/locales/zh-Hans/messages.mjs
packages/i18n/locales/ja/messages.po
packages/i18n/locales/...                 # ko, fr, de, es, pt-BR
```

- The `.po` files are the source (hand-edited, committed). The `.mjs` files are compiled artifacts (also committed, kept fresh).
- The runtime **imports the compiled artifact**, never a `.po`. Browser loading is centralized in
  `packages/web-ui/src/locale.ts` for Core UI and Console. Nimbus static generation loads the same
  compiled catalogs, and `apps/server/worker/middleware/i18n.ts` loads them per
  request for Worker errors.
- `compileNamespace: 'es'` in the config, so a compiled catalog is `export const messages = ...`. Consumers normalize `mod.messages ?? mod.default?.messages`.
- Only `.mjs` is generated. `lingui compile --typescript` is not used, so there are no `.ts` or `.d.ts` catalog artifacts.

## Locale tags (BCP 47)

| Use       | Do not use                        |
| --------- | --------------------------------- |
| `zh-Hans` | `zh-CN` / `zh`                    |
| `zh-Hant` | `zh-TW`                           |
| `pt-BR`   | `pt`                              |
| `en`      | `en-US` (unless en-GB needs split) |

Runtime resolution matches the exact tag first, then falls back by language subtag (`zh` -> `zh-Hans`, `pt` -> `pt-BR`).

The tag list is duplicated in seven contract points and they MUST agree: `lingui.config.ts`,
`packages/i18n/src/i18n.ts`, `packages/web-ui/src/locale.ts`,
`apps/site/src/lib/site-locale.ts`, `apps/server/worker/lib/locale.ts` plus the loaders in
`apps/server/worker/middleware/i18n.ts`, `packages/types/src/web-route-ownership.ts`, and the locale
list in `packages/i18n/src/catalog.test.ts`.

## msgid generation

- For macros, do not hand-write `id`. extract derives a hash id from the source text plus context.
- Disambiguate identical English with context: `msg({ message: 'Open', context: 'verb' })` versus `msg({ message: 'Open', context: 'adjective' })`.
- Changing the source text changes the id. The extraction workflow removes the obsolete translation from runtime catalogs, so consider whether a context is worth adding before a large copy rewrite.
- The React SDK is the one exception: `packages/react/src/i18n-runtime.tsx` declares explicit stable ids under the `sdk.` prefix, because runtime descriptors have no macro to hash from. Those ids land in the same shared catalog.

## Placeholder rules for translators

- ICU placeholders (`{name}`, `{count, plural, ...}`) MUST be identical in every locale. Translate only the surrounding text.
- Never add or remove a placeholder in `msgstr` -- MessageFormat throws at runtime.
- Fill plural categories according to the target language (en has one/other, ru has one/few/many/other, ja has other only).

## Package boundaries

- One catalog covers the whole repo. The extract scope is
  `include: ['apps/*/src/**', 'apps/*/worker/**', 'packages/*/src/**']`. It excludes declarations,
  build output, dependencies, tests, and the removed legacy server docs source. The committed
  `apps/site/src/content-source/docs/message-descriptors.ts` keeps the Nimbus document AST in the
  shared catalog.
- The React SDK ships with no catalog of its own: it declares `@lingui/react` as a peer dependency and reads whatever catalog the host application activated. If the SDK ever needs to publish its own translations, that requires a separate catalog entry -- it is deliberately not the case today.
