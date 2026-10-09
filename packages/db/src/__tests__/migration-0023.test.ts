import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const migrationDir = fileURLToPath(new URL('../../drizzle/', import.meta.url))
const TARGET = '0023_scim_secret_hotfix.sql'

function migratedThroughPrevious(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql') && name < TARGET)
    .sort()) {
    db.exec(readFileSync(join(migrationDir, file), 'utf8'))
  }
  return db
}

function insertDirectoryUser(db: DatabaseSync, id: string, scimRaw: string): void {
  db.prepare(
    `INSERT INTO directory_users (id, tenant_id, directory_id, user_name, scim_raw, created_at, updated_at)
      VALUES (?, 'tenant_a', 'dir_1', ?, ?, 1, 1)`,
  ).run(id, id, scimRaw)
}

describe('0023 SCIM secret hotfix migration', () => {
  it('removes stored SCIM passwords and keeps every other attribute', () => {
    const db = migratedThroughPrevious()
    insertDirectoryUser(db, 'du_1', '{"userName":"a","password":"p1","name":{"givenName":"A"}}')
    insertDirectoryUser(db, 'du_2', '{"userName":"b","Password":"p2"}')
    insertDirectoryUser(db, 'du_3', '{"userName":"c"}')

    db.exec(readFileSync(join(migrationDir, TARGET), 'utf8'))

    const rows = db.prepare('SELECT id, scim_raw FROM directory_users ORDER BY id').all()
    expect(rows.map((row) => JSON.parse(String((row as { scim_raw: unknown }).scim_raw)))).toEqual([
      { userName: 'a', name: { givenName: 'A' } },
      { userName: 'b' },
      { userName: 'c' },
    ])
    db.close()
  })
})
