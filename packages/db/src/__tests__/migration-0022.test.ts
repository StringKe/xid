import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const migrationDir = fileURLToPath(new URL('../../drizzle/', import.meta.url))
const TARGET = '0022_console_s5_s6.sql'

function applyPriorMigrations(db: DatabaseSync): void {
  for (const file of readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql') && name < TARGET)
    .sort()) {
    db.exec(readFileSync(join(migrationDir, file), 'utf8'))
  }
}

function applyTargetMigration(db: DatabaseSync): void {
  db.exec(readFileSync(join(migrationDir, TARGET), 'utf8'))
}

function seedLegacyRows(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO webhook_deliveries (id, tenant_id, webhook_id, event_type, payload, created_at, updated_at)
      VALUES ('wd_1', 'tenant_a', 'wh_1', 'user.created', '{}', 1, 1);
    INSERT INTO api_keys (id, tenant_id, name, key_hash, key_prefix, created_at, updated_at)
      VALUES ('key_1', 'tenant_a', 'CI', 'hash_1', 'sk_live_ab', 1, 1);
    INSERT INTO status_incidents (id, title, summary, started_at, created_by, updated_by, created_at, updated_at)
      VALUES ('inc_1', 'Outage', 'Investigating', 1, 'user_1', 'user_1', 1, 1);
    INSERT INTO compliance_documents (id, document_type, title, version, created_at, updated_at)
      VALUES ('doc_1', 'soc2', 'SOC 2', '2026', 1, 1);
    INSERT INTO organization_domains (id, tenant_id, org_id, domain, verification_token, created_at, updated_at)
      VALUES ('dom_1', 'tenant_a', 'org_a', 'example.com', 'token_1', 1, 1);
    INSERT INTO manager_assignments (id, tenant_id, user_id, manager_role, scope_type, created_at, updated_at)
      VALUES ('ma_1', 'tenant_a', 'user_1', 'instance_manager', 'instance', 1, 1);
  `)
}

function columnValues(db: DatabaseSync, table: string, columns: string[]): unknown {
  return db.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).get()
}

describe('0022 console S5/S6 migration', () => {
  it('adds nullable columns without rewriting existing rows', () => {
    const db = new DatabaseSync(':memory:')
    applyPriorMigrations(db)
    seedLegacyRows(db)

    applyTargetMigration(db)

    expect(columnValues(db, 'webhook_deliveries', ['id', 'response_ms', 'last_error'])).toEqual({
      id: 'wd_1',
      response_ms: null,
      last_error: null,
    })
    expect(columnValues(db, 'api_keys', ['id', 'created_by'])).toEqual({
      id: 'key_1',
      created_by: null,
    })
    expect(
      columnValues(db, 'compliance_documents', [
        'id',
        'size_bytes',
        'last_checked_at',
        'last_check_result',
      ]),
    ).toEqual({
      id: 'doc_1',
      size_bytes: null,
      last_checked_at: null,
      last_check_result: null,
    })
    expect(
      columnValues(db, 'organization_domains', ['id', 'last_checked_at', 'last_check_result']),
    ).toEqual({
      id: 'dom_1',
      last_checked_at: null,
      last_check_result: null,
    })
    expect(columnValues(db, 'manager_assignments', ['id', 'granted_by'])).toEqual({
      id: 'ma_1',
      granted_by: null,
    })
    db.close()
  })

  it('defaults incident components to an empty JSON array for existing and new rows', () => {
    const db = new DatabaseSync(':memory:')
    applyPriorMigrations(db)
    seedLegacyRows(db)

    applyTargetMigration(db)
    db.exec(`
      INSERT INTO status_incidents (id, title, summary, started_at, created_by, updated_by, created_at, updated_at)
        VALUES ('inc_2', 'Delay', 'Monitoring', 2, 'user_1', 'user_1', 2, 2);
    `)

    expect(db.prepare('SELECT id, components FROM status_incidents ORDER BY id').all()).toEqual([
      { id: 'inc_1', components: '[]' },
      { id: 'inc_2', components: '[]' },
    ])
    db.close()
  })

  it('indexes webhook deliveries for per-endpoint cursor pagination', () => {
    const db = new DatabaseSync(':memory:')
    applyPriorMigrations(db)

    applyTargetMigration(db)

    const columns = db
      .prepare(`PRAGMA index_info('webhook_deliveries_tenant_webhook_created_id_idx')`)
      .all()
      .map((row) => String((row as { name: unknown }).name))
    expect(columns).toEqual(['tenant_id', 'webhook_id', 'created_at', 'id'])
    db.close()
  })
})
