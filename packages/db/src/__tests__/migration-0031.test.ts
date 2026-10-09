import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const migrationDir = fileURLToPath(new URL('../../drizzle/', import.meta.url))
const TARGET = '0031_sso_preset_idp_id_cleanup.sql'

function migratedThroughPrevious(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql') && name < TARGET)
    .sort()) {
    db.exec(readFileSync(join(migrationDir, file), 'utf8'))
  }
  return db
}

function insertConnection(db: DatabaseSync, id: string, attributeMapping: string): void {
  db.prepare(
    `INSERT INTO sso_connections (id, tenant_id, org_id, protocol, attribute_mapping, created_at, updated_at)
      VALUES (?, 'tenant_a', ?, 'saml', ?, 1, 1)`,
  ).run(id, `org_${id}`, attributeMapping)
}

describe('0031 SSO preset idpId cleanup migration', () => {
  it('removes only the never-applied preset idpId values and keeps every other mapping key', () => {
    const db = migratedThroughPrevious()
    insertConnection(db, 'c1', '{"email":"mail","idpId":"nameID","_xidPreset":"okta"}')
    insertConnection(db, 'c2', '{"email":"mail","idpId":"User.username"}')
    insertConnection(
      db,
      'c3',
      '{"idpId":"http://schemas.microsoft.com/identity/claims/objectidentifier"}',
    )
    insertConnection(db, 'c4', '{"idpId":"employeeNumber"}')

    db.exec(readFileSync(join(migrationDir, TARGET), 'utf8'))

    const rows = db.prepare('SELECT id, attribute_mapping FROM sso_connections ORDER BY id').all()
    expect(
      rows.map((row) =>
        JSON.parse(String((row as { attribute_mapping: unknown }).attribute_mapping)),
      ),
    ).toEqual([
      { email: 'mail', _xidPreset: 'okta' },
      { email: 'mail' },
      { idpId: 'http://schemas.microsoft.com/identity/claims/objectidentifier' },
      { idpId: 'employeeNumber' },
    ])
    db.close()
  })
})
