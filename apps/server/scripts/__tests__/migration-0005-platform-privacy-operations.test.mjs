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

function insertOrganization(db, seatLimit = 1) {
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
       '{}', ?, 99, 'invite_required', 1, 'active', 1000, 1000)`,
  ).run(seatLimit)
}

function insertMembership(
  db,
  id,
  { tenantId = 'org_1', orgId = 'org_1', userId = `user_${id}`, status = 'active' } = {},
) {
  db.prepare(
    `INSERT INTO memberships (
       id, tenant_id, org_id, user_id, role, status, joined_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'member', ?, 1000, 1000, 1000)`,
  ).run(id, tenantId, orgId, userId, status)
}

function insertChildOrganization(db, id, tenantId = 'org_1') {
  db.prepare(
    `INSERT INTO organizations (
       id, tenant_id, instance_id, parent_org_id, slug, name, public_metadata,
       private_metadata, seat_limit, seat_used, enrollment_mode, allow_org_self_service,
       status, created_at, updated_at
     ) VALUES (?, ?, 'inst_1', ?, ?, ?, '{}',
       '{}', NULL, 0, 'invite_required', 1, 'active', 1000, 1000)`,
  ).run(id, tenantId, tenantId, id, id)
}

function insertAdditionalRootOrganization(db, id) {
  db.prepare(
    `INSERT INTO organizations (
       id, tenant_id, instance_id, parent_org_id, slug, name, public_metadata,
       private_metadata, seat_limit, seat_used, enrollment_mode, allow_org_self_service,
       status, created_at, updated_at
     ) VALUES (?, ?, 'inst_1', NULL, ?, ?, '{}',
       '{}', NULL, 0, 'invite_required', 1, 'active', 1000, 1000)`,
  ).run(id, id, id, id)
}

function upsertSeatQuota(db, tenantId, limit) {
  db.prepare(
    `INSERT INTO organization_quotas (
       tenant_id, quota_key, "limit", enforcement, created_at, updated_at
     ) VALUES (?, 'seats', ?, 'block_creation', 1000, 1000)
     ON CONFLICT (tenant_id, quota_key) DO UPDATE SET
       "limit" = excluded."limit",
       enforcement = excluded.enforcement,
       updated_at = excluded.updated_at`,
  ).run(tenantId, limit)
}

function insertSsoConnection(db, id, orgId, status = 'active') {
  db.prepare(
    `INSERT INTO sso_connections (
       id, tenant_id, org_id, protocol, idp_certificates, attribute_mapping, role_mapping,
       want_authn_response_signed, want_assertions_signed, jit_enabled, status, created_at, updated_at
     ) VALUES (?, 'org_1', ?, 'saml', '[]', '{}', '{}', 1, 1, 1, ?, 1000, 1000)`,
  ).run(id, orgId, status)
}

describe('migration 0005 platform and privacy operations', () => {
  it('adds every platform/privacy table and the user erasure marker', () => {
    const db = new DatabaseSync(':memory:')
    applyThrough(db, '0004_custom-hostnames.sql')
    insertOrganization(db)
    applyMigration(db, '0005_platform-privacy-operations.sql')

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((row) => row.name)
    expect(tables).toEqual(
      expect.arrayContaining([
        'organization_plans',
        'organization_quotas',
        'billing_meter_reports',
        'stripe_checkout_reservations',
        'stripe_webhook_events',
        'platform_announcements',
        'status_incidents',
        'status_incident_updates',
        'privacy_requests',
        'compliance_documents',
        'platform_audit_outbox',
      ]),
    )
    const userColumns = db
      .prepare(`PRAGMA table_info('users')`)
      .all()
      .map((column) => column.name)
    expect(userColumns).toContain('erased_at')
    expect(db.prepare(`SELECT COUNT(*) AS value FROM organization_plans`).get()).toEqual({
      value: 0,
    })
    expect(
      db
        .prepare(
          `SELECT tenant_id, quota_key, "limit", enforcement
           FROM organization_quotas
           WHERE tenant_id = 'org_1' AND quota_key = 'seats'`,
        )
        .get(),
    ).toEqual({
      tenant_id: 'org_1',
      quota_key: 'seats',
      limit: 1,
      enforcement: 'block_creation',
    })
    db.close()
  })

  it('deduplicates Stripe webhook processing by provider event id', () => {
    const db = new DatabaseSync(':memory:')
    applyThrough(db, '0004_custom-hostnames.sql')
    insertOrganization(db)
    applyMigration(db, '0005_platform-privacy-operations.sql')

    db.prepare(
      `INSERT INTO stripe_webhook_events (
         event_id, event_type, tenant_id, event_created, status, created_at, updated_at
       ) VALUES ('evt_1', 'customer.subscription.updated', NULL, 1000, 'processing', 1000, 1000)`,
    ).run()
    expect(() =>
      db
        .prepare(
          `INSERT INTO stripe_webhook_events (
             event_id, event_type, tenant_id, event_created, status, created_at, updated_at
           ) VALUES (
             'evt_1', 'customer.subscription.updated', 'org_1', 1000, 'processing', 1000, 1000
           )`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/)
    db.close()
  })

  it('persists one durable billing meter cursor and reserves pending identifiers globally', () => {
    const db = new DatabaseSync(':memory:')
    applyThrough(db, '0004_custom-hostnames.sql')
    insertOrganization(db)
    applyMigration(db, '0005_platform-privacy-operations.sql')

    db.prepare(
      `INSERT INTO billing_meter_reports (
         tenant_id, meter_key, period, reported_value, pending_identifier,
         pending_value, pending_target, pending_customer_id, pending_event_name,
         pending_timestamp, pending_reserved_at, provider_accepted_at,
         reconciliation_required_at, created_at, updated_at
       ) VALUES (
         'org_1', 'mau', '2026-07', 10, 'meter_report_1', 5, 15,
         'cus_1', 'xid_mau', 1785234600, 1785234600000, 1785234601000,
         NULL, 1000, 1000
       )`,
    ).run()
    expect(
      db
        .prepare(
          `SELECT reported_value, pending_identifier, pending_value, pending_target,
                  pending_customer_id, pending_event_name, pending_timestamp,
                  pending_reserved_at, provider_accepted_at, reconciliation_required_at
           FROM billing_meter_reports
           WHERE tenant_id = 'org_1' AND meter_key = 'mau' AND period = '2026-07'`,
        )
        .get(),
    ).toEqual({
      reported_value: 10,
      pending_identifier: 'meter_report_1',
      pending_value: 5,
      pending_target: 15,
      pending_customer_id: 'cus_1',
      pending_event_name: 'xid_mau',
      pending_timestamp: 1785234600,
      pending_reserved_at: 1785234600000,
      provider_accepted_at: 1785234601000,
      reconciliation_required_at: null,
    })
    expect(() =>
      db
        .prepare(
          `INSERT INTO billing_meter_reports (
             tenant_id, meter_key, period, reported_value, pending_identifier,
             created_at, updated_at
           ) VALUES ('org_2', 'mau', '2026-07', 0, 'meter_report_1', 1000, 1000)`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/)
    expect(() =>
      db
        .prepare(
          `INSERT INTO billing_meter_reports (
             tenant_id, meter_key, period, reported_value, pending_identifier,
             created_at, updated_at
           ) VALUES ('org_2', 'api_calls', '2026-07', 0, NULL, 1000, 1000)`,
        )
        .run(),
    ).not.toThrow()
    expect(() =>
      db
        .prepare(
          `INSERT INTO billing_meter_reports (
             tenant_id, meter_key, period, reported_value, pending_identifier,
             created_at, updated_at
           ) VALUES ('org_1', 'mau', '2026-07', 0, NULL, 1000, 1000)`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/)
    db.close()
  })

  it('persists one Checkout reservation per tenant and unique provider idempotency keys', () => {
    const db = new DatabaseSync(':memory:')
    applyThrough(db, '0004_custom-hostnames.sql')
    insertOrganization(db)
    applyMigration(db, '0005_platform-privacy-operations.sql')

    db.prepare(
      `INSERT INTO stripe_checkout_reservations (
         tenant_id, request_id, plan, customer_id, provider_idempotency_key,
         session_id, session_url, expires_at, status, created_at, updated_at
       ) VALUES (
         'org_1', 'request_1', 'pro', NULL, 'checkout_key_1',
         'cs_1', 'https://checkout.stripe.test/cs_1', 2000, 'ready', 1000, 1000
       )`,
    ).run()
    expect(
      db
        .prepare(
          `SELECT request_id, plan, provider_idempotency_key, session_id, status
           FROM stripe_checkout_reservations
           WHERE tenant_id = 'org_1'`,
        )
        .get(),
    ).toEqual({
      request_id: 'request_1',
      plan: 'pro',
      provider_idempotency_key: 'checkout_key_1',
      session_id: 'cs_1',
      status: 'ready',
    })
    expect(() =>
      db
        .prepare(
          `INSERT INTO stripe_checkout_reservations (
             tenant_id, request_id, plan, provider_idempotency_key, status, created_at, updated_at
           ) VALUES (
             'org_1', 'request_2', 'enterprise', 'checkout_key_2', 'reserved', 1000, 1000
           )`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/)
    expect(() =>
      db
        .prepare(
          `INSERT INTO stripe_checkout_reservations (
             tenant_id, request_id, plan, provider_idempotency_key, status, created_at, updated_at
           ) VALUES (
             'org_2', 'request_2', 'pro', 'checkout_key_1', 'reserved', 1000, 1000
           )`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/)
    db.close()
  })

  it('atomically enforces tenant-wide distinct active-user seats across child organizations', () => {
    const db = new DatabaseSync(':memory:')
    applyThrough(db, '0004_custom-hostnames.sql')
    insertOrganization(db, null)
    applyMigration(db, '0005_platform-privacy-operations.sql')
    upsertSeatQuota(db, 'org_1', 2)
    insertChildOrganization(db, 'org_child_1')

    insertMembership(db, 'mem_1', { userId: 'user_a' })
    expect(() =>
      insertMembership(db, 'mem_2', { orgId: 'org_child_1', userId: 'user_a' }),
    ).not.toThrow()
    insertMembership(db, 'mem_3', { orgId: 'org_child_1', userId: 'user_b' })
    expect(() => insertMembership(db, 'mem_4', { userId: 'user_c' })).toThrow(/seat_limit_exceeded/)

    expect(() =>
      db.prepare(`UPDATE memberships SET status = 'inactive' WHERE id = 'mem_1'`).run(),
    ).not.toThrow()
    expect(() => insertMembership(db, 'mem_4', { userId: 'user_c' })).toThrow(/seat_limit_exceeded/)
    db.prepare(`UPDATE memberships SET status = 'inactive' WHERE id = 'mem_2'`).run()
    expect(() => insertMembership(db, 'mem_4', { userId: 'user_c' })).not.toThrow()
    expect(() =>
      db.prepare(`UPDATE memberships SET status = 'active' WHERE id = 'mem_1'`).run(),
    ).toThrow(/seat_limit_exceeded/)

    db.prepare(`UPDATE memberships SET status = 'inactive' WHERE id = 'mem_4'`).run()
    expect(() =>
      db.prepare(`UPDATE memberships SET status = 'active' WHERE id = 'mem_1'`).run(),
    ).not.toThrow()
    db.close()
  })

  it('excludes the OLD membership when moving an active seat and checks the destination tenant', () => {
    const db = new DatabaseSync(':memory:')
    applyThrough(db, '0004_custom-hostnames.sql')
    insertOrganization(db, null)
    insertAdditionalRootOrganization(db, 'org_2')
    applyMigration(db, '0005_platform-privacy-operations.sql')
    upsertSeatQuota(db, 'org_1', 1)
    upsertSeatQuota(db, 'org_2', 1)
    insertChildOrganization(db, 'org_1_child')
    insertChildOrganization(db, 'org_2_child', 'org_2')
    insertMembership(db, 'mem_1', { userId: 'user_a' })
    insertMembership(db, 'mem_2', {
      tenantId: 'org_2',
      orgId: 'org_2',
      userId: 'user_b',
    })

    expect(() =>
      db.prepare(`UPDATE memberships SET org_id = 'org_1_child' WHERE id = 'mem_1'`).run(),
    ).not.toThrow()
    expect(() =>
      db
        .prepare(
          `UPDATE memberships
           SET tenant_id = 'org_2', org_id = 'org_2_child'
           WHERE id = 'mem_1'`,
        )
        .run(),
    ).toThrow(/seat_limit_exceeded/)
    expect(
      db.prepare(`SELECT tenant_id, org_id FROM memberships WHERE id = 'mem_1'`).get(),
    ).toEqual({ tenant_id: 'org_1', org_id: 'org_1_child' })
    expect(() =>
      insertMembership(db, 'mem_3', {
        tenantId: 'org_2',
        orgId: 'org_2_child',
        userId: 'user_b',
      }),
    ).not.toThrow()
    db.close()
  })

  it('atomically enforces the hard organization creation quota on insert and restore', () => {
    const db = new DatabaseSync(':memory:')
    applyThrough(db, '0004_custom-hostnames.sql')
    insertOrganization(db)
    applyMigration(db, '0005_platform-privacy-operations.sql')
    db.prepare(
      `INSERT INTO organization_quotas (
         tenant_id, quota_key, "limit", enforcement, created_at, updated_at
       ) VALUES ('org_1', 'organizations', 1, 'block_creation', 1000, 1000)`,
    ).run()

    insertChildOrganization(db, 'org_child_1')
    expect(() => insertChildOrganization(db, 'org_child_2')).toThrow(/resource_quota_exceeded/)

    db.prepare(
      `UPDATE organizations SET status = 'deleted', deleted_at = 2000
       WHERE id = 'org_child_1'`,
    ).run()
    insertChildOrganization(db, 'org_child_2')
    expect(() =>
      db
        .prepare(
          `UPDATE organizations SET status = 'active', deleted_at = NULL
           WHERE id = 'org_child_1'`,
        )
        .run(),
    ).toThrow(/resource_quota_exceeded/)

    db.prepare(`DELETE FROM organizations WHERE id = 'org_child_2'`).run()
    expect(() =>
      db
        .prepare(
          `UPDATE organizations SET status = 'active', deleted_at = NULL
           WHERE id = 'org_child_1'`,
        )
        .run(),
    ).not.toThrow()
    db.close()
  })

  it('atomically enforces the hard SSO connection quota on insert and restore', () => {
    const db = new DatabaseSync(':memory:')
    applyThrough(db, '0004_custom-hostnames.sql')
    insertOrganization(db)
    applyMigration(db, '0005_platform-privacy-operations.sql')
    insertChildOrganization(db, 'org_child_1')
    insertChildOrganization(db, 'org_child_2')
    db.prepare(
      `INSERT INTO organization_quotas (
         tenant_id, quota_key, "limit", enforcement, created_at, updated_at
       ) VALUES ('org_1', 'sso_connections', 1, 'block_creation', 1000, 1000)`,
    ).run()

    insertSsoConnection(db, 'sso_1', 'org_child_1')
    expect(() => insertSsoConnection(db, 'sso_2', 'org_child_2')).toThrow(/resource_quota_exceeded/)

    db.prepare(`UPDATE sso_connections SET status = 'deleted' WHERE id = 'sso_1'`).run()
    insertSsoConnection(db, 'sso_2', 'org_child_2')
    expect(() =>
      db.prepare(`UPDATE sso_connections SET status = 'active' WHERE id = 'sso_1'`).run(),
    ).toThrow(/resource_quota_exceeded/)

    db.prepare(`UPDATE sso_connections SET status = 'deleted' WHERE id = 'sso_2'`).run()
    expect(() =>
      db.prepare(`UPDATE sso_connections SET status = 'active' WHERE id = 'sso_1'`).run(),
    ).not.toThrow()
    db.close()
  })
})
