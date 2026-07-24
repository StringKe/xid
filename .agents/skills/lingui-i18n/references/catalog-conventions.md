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
- The runtime **imports the compiled artifact**, never a `.po`. Loading is `import('@xid-kit/i18n/locales/{locale}/messages.mjs')` in both `apps/server/src/lib/locale.ts` and `apps/server/worker/middleware/i18n.ts`.
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

The tag list is duplicated in six places and they MUST agree: `lingui.config.ts`, `packages/i18n/src/i18n.ts`, `apps/server/src/lib/locale.ts` (plus its `CATALOG_LOADERS`), `apps/server/worker/lib/locale.ts` (plus `CATALOG_LOADERS` in `apps/server/worker/middleware/i18n.ts`), the `LOCALE_LABELS` map in `apps/server/src/components/LanguageSwitcher.tsx`, and the `LOCALES` list in `packages/i18n/src/catalog.test.ts`.

## msgid generation

- For macros, do not hand-write `id`. extract derives a hash id from the source text plus context.
- Disambiguate identical English with context: `msg({ message: 'Open', context: 'verb' })` versus `msg({ message: 'Open', context: 'adjective' })`.
- Changing the source text changes the id and marks the old translation obsolete. That is expected -- consider whether a context is worth adding before a large copy rewrite.
- The React SDK is the one exception: `packages/react/src/i18n-runtime.tsx` declares explicit stable ids under the `sdk.` prefix, because runtime descriptors have no macro to hash from. Those ids land in the same shared catalog.

## Placeholder rules for translators

- ICU placeholders (`{name}`, `{count, plural, ...}`) MUST be identical in every locale. Translate only the surrounding text.
- Never add or remove a placeholder in `msgstr` -- MessageFormat throws at runtime.
- Fill plural categories according to the target language (en has one/other, ru has one/few/many/other, ja has other only).

## Package boundaries

- One catalog covers the whole repo. The extract scope is `include: ['apps/*/src/**', 'apps/*/worker/**', 'packages/*/src/**']` with `exclude: ['**/*.d.ts', '**/dist/**', '**/node_modules/**', '**/__tests__/**']`, so app code, Worker code and package sources all land in the same `.po`.
- The React SDK ships with no catalog of its own: it declares `@lingui/react` as a peer dependency and reads whatever catalog the host application activated. If the SDK ever needs to publish its own translations, that requires a separate catalog entry -- it is deliberately not the case today.
