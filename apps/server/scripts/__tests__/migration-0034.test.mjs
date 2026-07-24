// migration 0034 验证:applications 表重建后 access_token_ttl_sec 可空(NULL = 继承租户 token 策略)。
// 用 node:sqlite 内存库按序 apply 全部 migration,模拟空库初始化与存量库升级两条路径。
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

function apply(db, files) {
  for (const file of files) {
    db.exec(readFileSync(join(migrationDir, file), 'utf8'))
  }
}

describe('migration 0034 applications.access_token_ttl_sec 可空', () => {
  it('空库全量 apply 通过,列可空无默认值', () => {
    const db = new DatabaseSync(':memory:')

    apply(db, migrationFiles())

    const columns = db.prepare(`PRAGMA table_info('applications')`).all()
    const ttl = columns.find((col) => col.name === 'access_token_ttl_sec')
    expect(ttl.notnull).toBe(0)
    expect(ttl.dflt_value).toBeNull()
    db.close()
  })

  it('存量 3600 值升级后保留,新插入未指定 -> NULL', () => {
    const db = new DatabaseSync(':memory:')
    apply(
      db,
      migrationFiles().filter((name) => name < '0034'),
    )
    db.exec(
      `INSERT INTO applications (id, tenant_id, client_id, access_token_ttl_sec, created_at, updated_at)
       VALUES ('app_1', 't_1', 'client_1', 3600, 1000, 1000)`,
    )

    db.exec(readFileSync(join(migrationDir, '0034_applications_ttl_nullable.sql'), 'utf8'))

    const kept = db
      .prepare(`SELECT access_token_ttl_sec AS ttl FROM applications WHERE id = 'app_1'`)
      .get()
    expect(kept.ttl).toBe(3600)
    db.exec(
      `INSERT INTO applications (id, tenant_id, client_id, created_at, updated_at)
       VALUES ('app_2', 't_1', 'client_2', 2000, 2000)`,
    )
    const inserted = db
      .prepare(`SELECT access_token_ttl_sec AS ttl FROM applications WHERE id = 'app_2'`)
      .get()
    expect(inserted.ttl).toBeNull()
    db.close()
  })
})
