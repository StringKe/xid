// migration 0035 验证:authorization_codes / refresh_tokens 加 session_id(可空,hosted session 关联)。
// 用 node:sqlite 内存库按序 apply 全部 migration,模拟空库初始化。
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const migrationDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'packages',
  'db',
  'drizzle',
)

function migrationFiles() {
  return readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
}

describe('migration 0035 oauth session_id', () => {
  it('空库全量 apply 通过,两表 session_id 可空无默认值', () => {
    const db = new DatabaseSync(':memory:')
    for (const file of migrationFiles()) {
      db.exec(readFileSync(join(migrationDir, file), 'utf8'))
    }

    for (const table of ['authorization_codes', 'refresh_tokens']) {
      const columns = db.prepare(`PRAGMA table_info('${table}')`).all()
      const sessionId = columns.find((col) => col.name === 'session_id')
      expect(sessionId, `${table}.session_id`).toBeDefined()
      expect(sessionId.notnull).toBe(0)
      expect(sessionId.dflt_value).toBeNull()
    }
    db.close()
  })
})
