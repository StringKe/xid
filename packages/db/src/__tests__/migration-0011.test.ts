import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import migration from '../../drizzle/0011_invitation_email_claim.sql?raw'

function legacyDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE user_emails (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL
    );
    CREATE TABLE invitations (
      id TEXT PRIMARY KEY NOT NULL,
      tenant_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  return db
}

describe('0011 invitation Email claim migration', () => {
  it('normalizes and deterministically revokes historical duplicate pending invitations', () => {
    const db = legacyDatabase()
    db.exec(`
      INSERT INTO invitations (
        id, tenant_id, org_id, email, status, created_at, updated_at
      ) VALUES
        ('inv_old', 'tenant_a', 'org_a', ' Owner@Example.com ', 'pending', 100, 100),
        ('inv_tie_a', 'tenant_a', 'org_a', 'owner@example.com', 'pending', 200, 200),
        ('inv_tie_b', 'tenant_a', 'org_a', 'OWNER@example.com', 'pending', 200, 200),
        ('inv_other_org', 'tenant_a', 'org_b', 'owner@example.com', 'pending', 50, 50),
        ('inv_accepted', 'tenant_a', 'org_a', ' Kept@Example.com ', 'accepted', 10, 10);
    `)

    db.exec(migration)

    expect(
      db
        .prepare(
          `SELECT id, email, status
             FROM invitations
            ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        id: 'inv_accepted',
        email: ' Kept@Example.com ',
        status: 'accepted',
      },
      {
        id: 'inv_old',
        email: 'owner@example.com',
        status: 'revoked',
      },
      {
        id: 'inv_other_org',
        email: 'owner@example.com',
        status: 'pending',
      },
      {
        id: 'inv_tie_a',
        email: 'owner@example.com',
        status: 'revoked',
      },
      {
        id: 'inv_tie_b',
        email: 'owner@example.com',
        status: 'pending',
      },
    ])

    const claimColumns = db
      .prepare(`PRAGMA table_info('invitations')`)
      .all()
      .map((row) => String((row as { name: unknown }).name))
    expect(claimColumns).toEqual(
      expect.arrayContaining([
        'email_claim_token_hash',
        'email_claim_email_hash',
        'email_claim_expires_at',
        'email_claim_consumed_at',
        'email_claim_consumption_id',
        'email_claim_user_id',
        'email_claim_recovery_hash',
        'email_claim_session_id',
        'email_claim_session_reserved_at',
        'email_claim_finalization_id',
        'displaced_user_id',
        'displaced_email_id',
      ]),
    )

    db.close()
  })

  it('enforces pending, proof, recovery, and finalization winner uniqueness after upgrade', () => {
    const db = legacyDatabase()
    db.exec(`
      INSERT INTO user_emails (id, tenant_id, user_id, email)
      VALUES ('email_a', 'tenant_a', 'user_a', 'owner@example.com');
      INSERT INTO invitations (
        id, tenant_id, org_id, email, status, created_at, updated_at
      ) VALUES (
        'inv_a', 'tenant_a', 'org_a', 'owner@example.com', 'pending', 1, 1
      );
    `)

    db.exec(migration)

    expect(() =>
      db
        .prepare(
          `INSERT INTO invitations (
             id, tenant_id, org_id, email, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'pending', 2, 2)`,
        )
        .run('inv_duplicate', 'tenant_a', 'org_a', 'owner@example.com'),
    ).toThrow()
    expect(() =>
      db
        .prepare(
          `INSERT INTO invitations (
             id, tenant_id, org_id, email, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'revoked', 2, 2)`,
        )
        .run('inv_revoked', 'tenant_a', 'org_a', 'owner@example.com'),
    ).not.toThrow()
    expect(() =>
      db
        .prepare(
          `INSERT INTO invitations (
             id, tenant_id, org_id, email, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'pending', 2, 2)`,
        )
        .run('inv_other_org', 'tenant_a', 'org_b', 'owner@example.com'),
    ).not.toThrow()

    db.prepare(
      `UPDATE invitations
          SET email_claim_token_hash = ?,
              email_claim_consumption_id = ?,
              email_claim_recovery_hash = ?,
              email_claim_finalization_id = ?
        WHERE id = ?`,
    ).run('token_hash', 'consume_a', 'recovery_hash', 'finalize_a', 'inv_a')

    for (const [column, value] of [
      ['email_claim_token_hash', 'token_hash'],
      ['email_claim_consumption_id', 'consume_a'],
      ['email_claim_recovery_hash', 'recovery_hash'],
      ['email_claim_finalization_id', 'finalize_a'],
    ] as const) {
      expect(() =>
        db
          .prepare(
            `UPDATE invitations
                SET ${column} = ?
              WHERE id = ?`,
          )
          .run(value, 'inv_other_org'),
      ).toThrow()
    }

    db.prepare(
      `UPDATE user_emails
          SET ownership_proof = 'invitation_email_claim_v1',
              ownership_proof_ceremony_id = 'inv_a',
              ownership_proven_at = 10
        WHERE id = 'email_a'`,
    ).run()
    db.prepare(
      `INSERT INTO user_emails (id, tenant_id, user_id, email)
       VALUES ('email_b', 'tenant_a', 'user_b', 'other@example.com')`,
    ).run()
    expect(() =>
      db
        .prepare(
          `UPDATE user_emails
              SET ownership_proof = 'invitation_email_claim_v1',
                  ownership_proof_ceremony_id = 'inv_a',
                  ownership_proven_at = 11
            WHERE id = 'email_b'`,
        )
        .run(),
    ).toThrow()

    db.close()
  })
})
