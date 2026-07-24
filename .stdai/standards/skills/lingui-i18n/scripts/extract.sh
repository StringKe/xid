#!/usr/bin/env bash
# 抽取源码中的 lingui macro 消息到各 locale 的 .po
# 用法: bash extract.sh [--watch] [--clean]
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# 优先用本地 lingui CLI;fallback pnpm exec
if [ -x "node_modules/.bin/lingui" ]; then
  LINGUI="node_modules/.bin/lingui"
else
  LINGUI="pnpm exec lingui"
fi

# --clean: 删除源码中已不存在的废弃消息;CI 用 --overwrite 保持 sourceLocale 同步
$LINGUI extract --overwrite "$@"

echo "extract 完成。翻译 packages/i18n/locales/<locale>/messages.po 后跑 compile.sh"
