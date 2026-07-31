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

function insertHostname(
  db,
  { id, tenantId, orgId, hostname, cloudflareHostnameId, status = 'pending', deletedAt = null },
) {
  db.prepare(
    `INSERT INTO custom_hostnames (
       id, tenant_id, org_id, instance_id, hostname, cloudflare_hostname_id,
       status, hostname_status, traffic_cname_target, deleted_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'inst_1', ?, ?, ?, 'pending', 'customers.xid.test', ?, 1000, 1000)`,
  ).run(id, tenantId, orgId, hostname, cloudflareHostnameId, status, deletedAt)
}

describe('migration 0004 custom hostnames', () => {
  it('applies after prior migrations with the lifecycle and DNS evidence columns', () => {
    const db = new DatabaseSync(':memory:')
    applyAll(db)

    const columns = db
      .prepare(`PRAGMA table_info('custom_hostnames')`)
      .all()
      .map((column) => column.name)
    expect(columns).toEqual(
      expect.arrayContaining([
        'tenant_id',
        'org_id',
        'instance_id',
        'hostname',
        'cloudflare_hostname_id',
        'hostname_status',
        'ssl_status',
        'ownership_verification_name',
        'ownership_verification_value',
        'ownership_expires_at',
        'dcv_delegation_records',
        'validation_records',
        'traffic_cname_target',
        'requires_passkey_reregistration',
        'activated_at',
        'last_polled_at',
        'deleted_at',
      ]),
    )

    const indexes = db
      .prepare(`PRAGMA index_list('custom_hostnames')`)
      .all()
      .map((index) => index.name)
    expect(indexes).toEqual(
      expect.arrayContaining([
        'custom_hostnames_hostname_unq',
        'custom_hostnames_cloudflare_id_unq',
        'custom_hostnames_tenant_org_status_id_idx',
        'custom_hostnames_status_expiry_id_idx',
        'custom_hostnames_instance_status_id_idx',
      ]),
    )
    db.close()
  })

  it('globally reserves a hostname even after deletion to prevent stale-DNS takeover', () => {
    const db = new DatabaseSync(':memory:')
    applyAll(db)
    insertHostname(db, {
      id: 'ch_1',
      tenantId: 'tenant_1',
      orgId: 'org_1',
      hostname: 'login.customer.example',
      cloudflareHostnameId: 'cf_hostname_1',
      status: 'deleted',
      deletedAt: 2000,
    })

    expect(() =>
      insertHostname(db, {
        id: 'ch_2',
        tenantId: 'tenant_2',
        orgId: 'org_2',
        hostname: 'login.customer.example',
        cloudflareHostnameId: 'cf_hostname_2',
      }),
    ).toThrow()
    db.close()
  })

  it('does not allow one Cloudflare hostname id to bind to two local rows', () => {
    const db = new DatabaseSync(':memory:')
    applyAll(db)
    insertHostname(db, {
      id: 'ch_1',
      tenantId: 'tenant_1',
      orgId: 'org_1',
      hostname: 'login.customer.example',
      cloudflareHostnameId: 'cf_hostname_1',
    })

    expect(() =>
      insertHostname(db, {
        id: 'ch_2',
        tenantId: 'tenant_1',
        orgId: 'org_1',
        hostname: 'admin.customer.example',
        cloudflareHostnameId: 'cf_hostname_1',
      }),
    ).toThrow()
    db.close()
  })
})
