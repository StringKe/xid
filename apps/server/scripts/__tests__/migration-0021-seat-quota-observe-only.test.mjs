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
const MIGRATION = '0021_seat_quota_observe_only.sql'

function migrationFiles() {
  return readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
}

function applyThrough(db, lastFile) {
  for (const file of migrationFiles()) {
    db.exec(readFileSync(join(migrationDir, file), 'utf8'))
    if (file === lastFile) return
  }
  throw new Error(`missing migration ${lastFile}`)
}

function applyMigration(db, file) {
  db.exec(readFileSync(join(migrationDir, file), 'utf8'))
}

function seedTenant(db) {
  db.prepare(
    `INSERT INTO instances (
       id, name, primary_domain, mode, default_locale, data_residency, mfa_policy,
       password_policy, session_policy, status, created_at, updated_at
     ) VALUES ('inst_1', 'XID', 'xid.test', 'multi_tenant', 'en', 'us', 'optional',
       '{}', '{}', 'active', 1000, 1000)`,
  ).run()
  db.prepare(
    `INSERT INTO organizations (
       id, tenant_id, instance_id, parent_org_id, slug, name, public_metadata,
       private_metadata, seat_limit, seat_used, enrollment_mode, allow_org_self_service,
       status, created_at, updated_at
     ) VALUES ('org_1', 'org_1', 'inst_1', NULL, 'acme', 'Acme', '{}',
       '{}', 1, 0, 'invite_required', 1, 'active', 1000, 1000)`,
  ).run()
  for (const id of ['org_child_1', 'org_child_2']) {
    db.prepare(
      `INSERT INTO organizations (
         id, tenant_id, instance_id, parent_org_id, slug, name, public_metadata,
         private_metadata, seat_limit, seat_used, enrollment_mode, allow_org_self_service,
         status, created_at, updated_at
       ) VALUES (?, 'org_1', 'inst_1', 'org_1', ?, ?, '{}',
         '{}', NULL, 0, 'invite_required', 1, 'active', 1000, 1000)`,
    ).run(id, id, id)
  }
  db.prepare(
    `INSERT INTO organization_quotas (
       tenant_id, quota_key, "limit", enforcement, updated_by, created_at, updated_at
     ) VALUES
       ('org_1', 'seats', 1, 'block_creation', 'user_admin', 1000, 1000),
       ('org_1', 'sso_connections', 1, 'block_creation', 'user_admin', 1000, 1000)`,
  ).run()
  db.prepare(
    `INSERT INTO organization_plans (
       tenant_id, plan, status, source, external_customer_id, effective_at, created_at, updated_at
     ) VALUES ('org_1', 'pro', 'active', 'stripe', 'cus_1', 1000, 1000, 1000)`,
  ).run()
  insertMembership(db, 'mem_1', 'user_a')
}

function insertMembership(db, id, userId) {
  db.prepare(
    `INSERT INTO memberships (
       id, tenant_id, org_id, user_id, role, status, joined_at, created_at, updated_at
     ) VALUES (?, 'org_1', 'org_1', ?, 'member', 'active', 1000, 1000, 1000)`,
  ).run(id, userId)
}

function insertSsoConnection(db, id, orgId) {
  db.prepare(
    `INSERT INTO sso_connections (
       id, tenant_id, org_id, protocol, idp_certificates, attribute_mapping, role_mapping,
       want_authn_response_signed, want_assertions_signed, jit_enabled, status, created_at, updated_at
     ) VALUES (?, 'org_1', ?, 'saml', '[]', '{}', '{}', 1, 1, 1, 'active', 1000, 1000)`,
  ).run(id, orgId)
}

function migratedDatabase() {
  const db = new DatabaseSync(':memory:')
  applyThrough(db, '0020_console_users_applications.sql')
  seedTenant(db)
  return db
}

describe('migration 0021 seat quota observe-only', () => {
  it('blocks the second active seat before the migration runs', () => {
    const db = migratedDatabase()

    const insertSecond = () => insertMembership(db, 'mem_2', 'user_b')

    expect(insertSecond).toThrow(/seat_limit_exceeded/)
    db.close()
  })

  it('admits members beyond the former seat limit after the migration', () => {
    const db = migratedDatabase()

    applyMigration(db, MIGRATION)

    expect(() => insertMembership(db, 'mem_2', 'user_b')).not.toThrow()
    expect(() =>
      db.prepare(`UPDATE memberships SET status = 'inactive' WHERE id = 'mem_1'`).run(),
    ).not.toThrow()
    expect(() =>
      db.prepare(`UPDATE memberships SET status = 'active' WHERE id = 'mem_1'`).run(),
    ).not.toThrow()
    db.close()
  })

  it('drops both seat triggers and keeps the resource quota triggers', () => {
    const db = migratedDatabase()

    applyMigration(db, MIGRATION)

    const triggers = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)
      .all()
      .map((row) => row.name)
    expect(triggers).not.toContain('memberships_seat_limit_before_insert')
    expect(triggers).not.toContain('memberships_seat_limit_before_update')
    expect(triggers).toEqual(
      expect.arrayContaining([
        'organizations_quota_before_insert',
        'organizations_quota_before_update',
        'sso_connections_quota_before_insert',
        'sso_connections_quota_before_update',
      ]),
    )
    db.close()
  })

  it('switches seat rows to observe while preserving limit, author and other quotas', () => {
    const db = migratedDatabase()

    applyMigration(db, MIGRATION)

    const rows = db
      .prepare(
        `SELECT quota_key, "limit", enforcement, updated_by, updated_at
         FROM organization_quotas WHERE tenant_id = 'org_1' ORDER BY quota_key`,
      )
      .all()
      .map((row) => ({ ...row }))
    expect(rows).toEqual([
      expect.objectContaining({
        quota_key: 'seats',
        limit: 1,
        enforcement: 'observe',
        updated_by: 'user_admin',
      }),
      {
        quota_key: 'sso_connections',
        limit: 1,
        enforcement: 'block_creation',
        updated_by: 'user_admin',
        updated_at: 1000,
      },
    ])
    expect(rows[0].updated_at).toBeGreaterThan(1000)
    expect({
      ...db.prepare(`SELECT seat_limit FROM organizations WHERE id = 'org_1'`).get(),
    }).toEqual({ seat_limit: 1 })
    db.close()
  })

  it('leaves the billing account record untouched', () => {
    const db = migratedDatabase()

    applyMigration(db, MIGRATION)

    expect({
      ...db
        .prepare(
          `SELECT plan, status, source, external_customer_id, updated_at
           FROM organization_plans WHERE tenant_id = 'org_1'`,
        )
        .get(),
    }).toEqual({
      plan: 'pro',
      status: 'active',
      source: 'stripe',
      external_customer_id: 'cus_1',
      updated_at: 1000,
    })
    db.close()
  })

  it('still enforces the SSO connection quota', () => {
    const db = migratedDatabase()

    applyMigration(db, MIGRATION)
    insertSsoConnection(db, 'sso_1', 'org_child_1')

    expect(() => insertSsoConnection(db, 'sso_2', 'org_child_2')).toThrow(/resource_quota_exceeded/)
    db.close()
  })

  it('can be applied twice without error', () => {
    const db = migratedDatabase()
    applyMigration(db, MIGRATION)

    const reapply = () => applyMigration(db, MIGRATION)

    expect(reapply).not.toThrow()
    expect(() => insertMembership(db, 'mem_2', 'user_b')).not.toThrow()
    db.close()
  })
})
