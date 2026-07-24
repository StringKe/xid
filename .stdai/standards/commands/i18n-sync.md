---
type: commands
name: i18n-sync
description: One-shot lingui extract + compile to resync the locale catalogs
argument_hint: '[--strict]'
allowed_tools: [Bash, Read, Edit]
---

# /i18n-sync

Resync the lingui catalogs: extract new copy -> prompt for translation -> compile the runtime artifacts. Full background lives in the lingui-i18n skill.

## Steps

1. extract:

   ```bash
   bash .stdai/standards/skills/lingui-i18n/scripts/extract.sh
   ```

2. Report the `Missing` count per locale. If any locale other than the source locale (`en`) has missing translations, list the files to translate at `packages/i18n/locales/<locale>/messages.po` and ask the user to translate them (or confirm machine-translated placeholders).

3. compile:

   ```bash
   bash .stdai/standards/skills/lingui-i18n/scripts/compile.sh
   ```

   Forward `$ARGUMENTS` (for example `--strict`, which makes compile fail on untranslated messages).

4. Run the coverage gate and report failures:

   ```bash
   pnpm run i18n:audit
   ```

5. Confirm `git diff` shows updated `packages/i18n/locales/**/messages.mjs` artifacts and remind the user to commit them together with the source change.

## Constraints

- The runtime imports the compiled artifacts, never the `.po` files.
- ICU placeholders MUST be identical across every locale; never add or drop one.
- Email templates are out of scope for lingui (Mustache + R2, see chapter 07).
