#!/usr/bin/env bash
# Compile the .po files into the messages.mjs artifacts imported at runtime
# Usage: bash compile.sh [--strict]
# --strict: fail on untranslated messages (for CI)
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [ -x "node_modules/.bin/lingui" ]; then
  LINGUI="node_modules/.bin/lingui"
else
  LINGUI="pnpm exec lingui"
fi

$LINGUI compile "$@"

echo "compile done. The runtime imports the compiled artifacts, not the .po files. Make sure git diff shows them updated before committing."
