#!/usr/bin/env bash
# Extract lingui messages from the source into each locale's .po
# Usage: bash extract.sh [--watch] [--clean]
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Prefer the locally installed lingui CLI; fall back to pnpm exec
if [ -x "node_modules/.bin/lingui" ]; then
  LINGUI="node_modules/.bin/lingui"
else
  LINGUI="pnpm exec lingui"
fi

# --overwrite keeps the source locale in sync with the source text.
# Pass --clean yourself to drop messages that no longer exist in the source.
$LINGUI extract --overwrite "$@"

echo "extract done. Translate packages/i18n/locales/<locale>/messages.po, then run compile.sh"
