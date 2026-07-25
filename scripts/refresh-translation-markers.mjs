#!/usr/bin/env node
// 重算 docs/zh-Hans/ 下每个中文镜像首行 xid-translation 标记的 source-blob 并原地更新。
// 用途:译文确认已跟上英文正本之后一键刷新,避免手抄 40 位 sha 出错。
//
// 警告:刷新 sha 等于声称"该译文已与英文正本同步"。译文没跟上时不要跑这个脚本,
// 否则会把真实漂移抹掉,门禁 tests/docs/translation-drift.test.mjs 就再也测不出来。

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MIRROR_ROOT = 'docs/zh-Hans'
const MARKER_RE =
  /^<!--\s*xid-translation\s+source=(\S+)\s+source-commit=(\S+)\s+source-blob=([0-9a-f]{40})\s*-->/

function gitBlobSha(buf) {
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex')
}

function listMirrors(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...listMirrors(full))
    else if (entry.name.endsWith('.md')) found.push(full)
  }
  return found
}

let updated = 0
let failed = 0

for (const mirror of listMirrors(MIRROR_ROOT)) {
  const text = readFileSync(mirror, 'utf8')
  const newlineAt = text.indexOf('\n')
  const firstLine = newlineAt === -1 ? text : text.slice(0, newlineAt)
  const matched = MARKER_RE.exec(firstLine)

  if (!matched) {
    console.error(`FAIL ${mirror}: 首行不是合法的 xid-translation 标记`)
    failed += 1
    continue
  }

  const [, source, commit, recorded] = matched
  if (!existsSync(source)) {
    console.error(`FAIL ${mirror}: 英文正本 ${source} 不存在`)
    failed += 1
    continue
  }

  const actual = gitBlobSha(readFileSync(source))
  if (actual === recorded) {
    console.log(`SKIP ${mirror} (${source} 未变更)`)
    continue
  }

  const rebuilt = `<!-- xid-translation source=${source} source-commit=${commit} source-blob=${actual} -->`
  writeFileSync(mirror, rebuilt + (newlineAt === -1 ? '' : text.slice(newlineAt)))
  console.log(`UPDATED ${mirror}: ${recorded.slice(0, 8)} -> ${actual.slice(0, 8)} (${source})`)
  updated += 1
}

console.log(`\n刷新完成: ${updated} 个已更新, ${failed} 个失败`)
process.exit(failed > 0 ? 1 : 0)
