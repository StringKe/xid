// applications.access_token_ttl_sec 的可空契约:NULL = 继承租户 token 策略,显式值 = 该 application 固定 TTL。
// 用 node:sqlite 内存库 apply 全部 migration 后验证终态列定义与插入行为。
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

describe('applications.access_token_ttl_sec 可空', () => {
  it('空库全量 apply 通过,列可空无默认值', () => {
    const db = new DatabaseSync(':memory:')

    apply(db, migrationFiles())

    const columns = db.prepare(`PRAGMA table_info('applications')`).all()
    const ttl = columns.find((col) => col.name === 'access_token_ttl_sec')
    expect(ttl.notnull).toBe(0)
    expect(ttl.dflt_value).toBeNull()
    db.close()
  })

  it('显式值原样保留,未指定时为 NULL 而不是回落 3600', () => {
    const db = new DatabaseSync(':memory:')
    apply(db, migrationFiles())

    db.exec(
      `INSERT INTO applications (id, tenant_id, client_id, access_token_ttl_sec, created_at, updated_at)
       VALUES ('app_1', 't_1', 'client_1', 3600, 1000, 1000)`,
    )
    db.exec(
      `INSERT INTO applications (id, tenant_id, client_id, created_at, updated_at)
       VALUES ('app_2', 't_1', 'client_2', 2000, 2000)`,
    )

    const explicit = db
      .prepare(`SELECT access_token_ttl_sec AS ttl FROM applications WHERE id = 'app_1'`)
      .get()
    expect(explicit.ttl).toBe(3600)

    // NULL 与 3600 语义不同:NULL = 继承租户 token 策略,3600 = 该 application 固定 1 小时。
    // 列若带 DEFAULT 3600,这两者会被混同,租户策略对未配置的 application 永远不生效。
    const omitted = db
      .prepare(`SELECT access_token_ttl_sec AS ttl FROM applications WHERE id = 'app_2'`)
      .get()
    expect(omitted.ttl).toBeNull()
    db.close()
  })
})
