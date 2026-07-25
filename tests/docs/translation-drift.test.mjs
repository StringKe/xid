// 翻译漂移门禁:docs/zh-Hans/ 下每个中文镜像首行的 xid-translation 标记必须指向
// 一个真实存在的英文正本,且记录的 source-blob 必须等于该正本当前内容的 git blob sha。
// 纯 node 复算 sha(不调 git 二进制),因为 Cloudflare Workers Builds 环境不保证有 .git。
// source-commit 字段保留但不参与断言:它与 source-blob 历史上已互相矛盾,断言它只会制造假失败。

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIRROR_ROOT = 'docs/zh-Hans'

/** 当前登记在册的英文正本路径。新增或删除镜像必须同步改这里。 */
const EXPECTED_MIRRORS = [
  'docs/README.md',
  'docs/deployment.md',
  'docs/design/00-overview.md',
  'docs/design/01-authentication.md',
  'docs/design/02-tenancy-rbac.md',
  'docs/design/03-oidc-oauth.md',
  'docs/design/04-enterprise-sso.md',
  'docs/design/05-users-sessions.md',
  'docs/design/06-developer-experience.md',
  'docs/design/07-platform-operations.md',
  'docs/design/08-data-model.md',
  'docs/design/README.md',
  'docs/sdks/platform-matrix.md',
  'docs/soft-delete.md',
]

const MARKER_FORMAT =
  '<!-- xid-translation source=<英文正本路径> source-commit=<短 sha> source-blob=<40 位 sha1> -->'
const MARKER_RE =
  /^<!--\s*xid-translation\s+source=(\S+)\s+source-commit=(\S+)\s+source-blob=([0-9a-f]{40})\s*-->\s*$/

/** git blob sha1 = sha1("blob " + 字节长度 + "\0" + 内容),与 `git hash-object` 逐字符一致。 */
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

const mirrors = listMirrors(MIRROR_ROOT)

describe('translation drift', () => {
  it('finds at least one translated mirror', () => {
    expect(mirrors.length).toBeGreaterThan(0)
  })

  for (const mirror of mirrors) {
    describe(mirror, () => {
      const firstLine = readFileSync(mirror, 'utf8').split('\n', 1)[0]
      const matched = MARKER_RE.exec(firstLine)

      it('carries a parseable xid-translation marker on line 1', () => {
        expect(
          matched,
          `${mirror} 首行不是合法的翻译标记。\n实际首行: ${JSON.stringify(firstLine)}\n期望格式: ${MARKER_FORMAT}`,
        ).not.toBeNull()
      })

      if (!matched) return
      const source = matched[1]

      it('points at an English source file that still exists', () => {
        expect(
          existsSync(source),
          `${mirror} 指向的英文正本 ${source} 不存在(被删或改名),中文镜像已成孤儿。` +
            `\n修复:恢复/更正 ${source} 的路径,或删除 ${mirror} 并从 EXPECTED_MIRRORS 移除该条目。`,
        ).toBe(true)
      })

      if (!existsSync(source)) return
      const actual = gitBlobSha(readFileSync(source))
      const recorded = matched[3]

      it('records the current blob sha of that source', () => {
        expect(
          recorded,
          `${source} 已变更(标记 ${recorded.slice(0, 8)},实际 ${actual.slice(0, 8)})。` +
            `\n重新翻译 ${mirror} 后把首行 source-blob 更新为 ${actual};` +
            `\n若英文改动不影响译文语义,可只刷新 sha。` +
            `\n一键刷新全部标记: node scripts/refresh-translation-markers.mjs`,
        ).toBe(actual)
      })
    })
  }

  it('mirrors exactly the registered EXPECTED_MIRRORS set', () => {
    const seen = mirrors
      .map((m) => MARKER_RE.exec(readFileSync(m, 'utf8').split('\n', 1)[0]))
      .filter((m) => m !== null)
      .map((m) => m[1])
      .sort()

    expect(
      seen,
      '实际遍历到的英文正本集合与 EXPECTED_MIRRORS 不一致。' +
        '\n新增镜像请登记进 EXPECTED_MIRRORS;删除镜像请同步移除条目。',
    ).toEqual([...EXPECTED_MIRRORS].sort())
  })
})
