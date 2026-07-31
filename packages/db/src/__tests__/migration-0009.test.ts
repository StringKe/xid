import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import migration from '../../drizzle/0009_saml_idp_certificate_uniqueness.sql?raw'

function legacyDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE cert_store (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      usage TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  return db
}

describe('0009_saml_idp_certificate_uniqueness migration', () => {
  it('normalizes legacy statuses without disabling SP signing or encryption certificates', () => {
    const db = legacyDatabase()
    db.exec(`
      INSERT INTO cert_store (id, tenant_id, usage, status, updated_at)
      VALUES
        ('cert_a', 'tenant_a', 'saml_idp_signing', 'active', 1),
        ('cert_b', 'tenant_a', 'saml_idp_signing', 'active', 1),
        ('cert_c', 'tenant_a', 'saml_idp_signing', 'expiring', 1),
        ('cert_d', 'tenant_a', 'saml_idp_signing', 'retiring', 1),
        ('cert_e', 'tenant_a', 'saml_sp_signing', 'active', 1),
        ('cert_f', 'tenant_b', 'saml_idp_signing', 'active', 1),
        ('cert_g', 'tenant_b', 'saml_idp_signing', 'expiring', 1),
        ('cert_h', 'tenant_a', 'saml_sp_signing', 'active', 1),
        ('cert_i', 'tenant_a', 'saml_sp_signing', 'expiring', 1),
        ('cert_j', 'tenant_a', 'saml_sp_encryption', 'expiring', 1);
    `)

    db.exec(migration)

    expect(
      db
        .prepare(
          `SELECT id, tenant_id, usage, status
           FROM cert_store
           ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        id: 'cert_a',
        tenant_id: 'tenant_a',
        usage: 'saml_idp_signing',
        status: 'active',
      },
      {
        id: 'cert_b',
        tenant_id: 'tenant_a',
        usage: 'saml_idp_signing',
        status: 'retiring',
      },
      {
        id: 'cert_c',
        tenant_id: 'tenant_a',
        usage: 'saml_idp_signing',
        status: 'retiring',
      },
      {
        id: 'cert_d',
        tenant_id: 'tenant_a',
        usage: 'saml_idp_signing',
        status: 'retiring',
      },
      {
        id: 'cert_e',
        tenant_id: 'tenant_a',
        usage: 'saml_sp_signing',
        status: 'active',
      },
      {
        id: 'cert_f',
        tenant_id: 'tenant_b',
        usage: 'saml_idp_signing',
        status: 'active',
      },
      {
        id: 'cert_g',
        tenant_id: 'tenant_b',
        usage: 'saml_idp_signing',
        status: 'retiring',
      },
      {
        id: 'cert_h',
        tenant_id: 'tenant_a',
        usage: 'saml_sp_signing',
        status: 'active',
      },
      {
        id: 'cert_i',
        tenant_id: 'tenant_a',
        usage: 'saml_sp_signing',
        status: 'active',
      },
      {
        id: 'cert_j',
        tenant_id: 'tenant_a',
        usage: 'saml_sp_encryption',
        status: 'active',
      },
    ])

    db.close()
  })

  it('limits only active IdP signing certificates while preserving other usages', () => {
    const db = legacyDatabase()
    db.prepare(
      `INSERT INTO cert_store (id, tenant_id, usage, status, updated_at)
       VALUES (?, ?, ?, ?, 1)`,
    ).run('cert_a', 'tenant_a', 'saml_idp_signing', 'active')

    db.exec(migration)

    expect(() =>
      db
        .prepare(
          `INSERT INTO cert_store (id, tenant_id, usage, status, updated_at)
           VALUES (?, ?, ?, ?, 2)`,
        )
        .run('cert_b', 'tenant_a', 'saml_idp_signing', 'active'),
    ).toThrow()
    expect(() =>
      db
        .prepare(
          `INSERT INTO cert_store (id, tenant_id, usage, status, updated_at)
           VALUES (?, ?, ?, ?, 2)`,
        )
        .run('cert_c', 'tenant_a', 'saml_idp_signing', 'retiring'),
    ).not.toThrow()
    expect(() =>
      db
        .prepare(
          `INSERT INTO cert_store (id, tenant_id, usage, status, updated_at)
           VALUES (?, ?, ?, ?, 2)`,
        )
        .run('cert_d', 'tenant_a', 'saml_sp_signing', 'active'),
    ).not.toThrow()
    expect(() =>
      db
        .prepare(
          `INSERT INTO cert_store (id, tenant_id, usage, status, updated_at)
           VALUES (?, ?, ?, ?, 2)`,
        )
        .run('cert_e', 'tenant_b', 'saml_idp_signing', 'active'),
    ).not.toThrow()
    expect(() =>
      db
        .prepare(
          `INSERT INTO cert_store (id, tenant_id, usage, status, updated_at)
           VALUES (?, ?, ?, ?, 2)`,
        )
        .run('cert_f', 'tenant_a', 'saml_sp_signing', 'active'),
    ).not.toThrow()

    expect(
      db
        .prepare(
          `SELECT tenant_id, usage, status, COUNT(*) AS count
           FROM cert_store
           GROUP BY tenant_id, usage, status
           ORDER BY tenant_id, usage, status`,
        )
        .all(),
    ).toEqual([
      { tenant_id: 'tenant_a', usage: 'saml_idp_signing', status: 'active', count: 1 },
      { tenant_id: 'tenant_a', usage: 'saml_idp_signing', status: 'retiring', count: 1 },
      { tenant_id: 'tenant_a', usage: 'saml_sp_signing', status: 'active', count: 2 },
      { tenant_id: 'tenant_b', usage: 'saml_idp_signing', status: 'active', count: 1 },
    ])

    db.close()
  })
})
