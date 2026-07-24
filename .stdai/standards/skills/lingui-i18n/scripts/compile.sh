#!/usr/bin/env bash
# 把 .po 编译成运行时 import 的产物(messages.mjs / .ts)
# 用法: bash compile.sh [--strict]
# --strict: 有未翻译消息时失败(CI 用)
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [ -x "node_modules/.bin/lingui" ]; then
  LINGUI="node_modules/.bin/lingui"
else
  LINGUI="pnpm exec lingui"
fi

$LINGUI compile "$@"

echo "compile 完成。运行时 import 的是 compile 产物,不是 .po。提交前确保 git diff 中产物已更新。"
