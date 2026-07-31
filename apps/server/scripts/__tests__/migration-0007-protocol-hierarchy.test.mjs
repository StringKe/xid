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

function applyAll(db) {
  for (const file of readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(migrationDir, file), 'utf8'))
  }
}

function insertInstance(db, id = 'inst_1') {
  db.prepare(
    `INSERT INTO instances (
       id, name, primary_domain, mode, default_locale, data_residency, mfa_policy,
       password_policy, session_policy, status, created_at, updated_at
     ) VALUES (?, ?, ?, 'multi_tenant', 'en', 'us', 'optional',
       '{}', '{}', 'active', 1000, 1000)`,
  ).run(id, id, `${id}.test`)
}

function insertOrganization(
  db,
  { id, tenantId, instanceId = 'inst_1', parentOrgId = null, status = 'active' },
) {
  db.prepare(
    `INSERT INTO organizations (
       id, tenant_id, instance_id, parent_org_id, slug, name, public_metadata,
       private_metadata, seat_used, enrollment_mode, allow_org_self_service,
       status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, '{}', '{}', 0, 'invite_required', 1, ?, 1000, 1000)`,
  ).run(id, tenantId, instanceId, parentOrgId, id, id, status)
}

describe('migration 0007 protocol fields and organization hierarchy', () => {
  it('adds persisted logout and bounded SAML tolerance fields with safe defaults', () => {
    const db = new DatabaseSync(':memory:')
    applyAll(db)

    const applicationColumns = db
      .prepare(`PRAGMA table_info('applications')`)
      .all()
      .map((column) => [column.name, column.dflt_value, column.notnull])
    expect(applicationColumns).toContainEqual(['backchannel_logout_session_required', 'false', 1])

    const connectionColumns = db
      .prepare(`PRAGMA table_info('sso_connections')`)
      .all()
      .map((column) => [column.name, column.dflt_value, column.notnull])
    expect(connectionColumns).toContainEqual(['saml_clock_skew_ms', '180000', 1])
    db.close()
  })

  it('permits one child level and rejects invalid roots, deep nesting, and reparenting', () => {
    const db = new DatabaseSync(':memory:')
    applyAll(db)
    insertInstance(db)
    insertOrganization(db, { id: 'tenant_1', tenantId: 'tenant_1' })
    insertOrganization(db, {
      id: 'child_1',
      tenantId: 'tenant_1',
      parentOrgId: 'tenant_1',
    })

    expect(() =>
      insertOrganization(db, {
        id: 'orphan_1',
        tenantId: 'tenant_1',
        parentOrgId: null,
      }),
    ).toThrow(/organization_hierarchy_invalid/)
    expect(() =>
      insertOrganization(db, {
        id: 'grandchild_1',
        tenantId: 'tenant_1',
        parentOrgId: 'child_1',
      }),
    ).toThrow(/organization_hierarchy_invalid/)
    expect(() =>
      db
        .prepare(
          `UPDATE organizations
           SET tenant_id = 'child_1', parent_org_id = NULL
           WHERE id = 'child_1'`,
        )
        .run(),
    ).toThrow(/organization_hierarchy_invalid/)

    expect(
      db
        .prepare(
          `SELECT tenant_id, parent_org_id
           FROM organizations
           WHERE id = 'child_1'`,
        )
        .get(),
    ).toEqual({ tenant_id: 'tenant_1', parent_org_id: 'tenant_1' })
    db.close()
  })

  it('requires an active same-instance root when a child is created or restored', () => {
    const db = new DatabaseSync(':memory:')
    applyAll(db)
    insertInstance(db)
    insertInstance(db, 'inst_2')
    insertOrganization(db, { id: 'tenant_1', tenantId: 'tenant_1' })

    expect(() =>
      insertOrganization(db, {
        id: 'wrong_instance',
        tenantId: 'tenant_1',
        instanceId: 'inst_2',
        parentOrgId: 'tenant_1',
      }),
    ).toThrow(/organization_hierarchy_invalid/)

    insertOrganization(db, {
      id: 'child_1',
      tenantId: 'tenant_1',
      parentOrgId: 'tenant_1',
    })
    db.prepare(`UPDATE organizations SET status = 'deleted' WHERE id = 'child_1'`).run()
    db.prepare(`UPDATE organizations SET status = 'suspended' WHERE id = 'tenant_1'`).run()

    expect(() =>
      db.prepare(`UPDATE organizations SET status = 'active' WHERE id = 'child_1'`).run(),
    ).toThrow(/organization_hierarchy_invalid/)
    expect(db.prepare(`SELECT status FROM organizations WHERE id = 'child_1'`).get()).toEqual({
      status: 'deleted',
    })
    db.close()
  })
})
