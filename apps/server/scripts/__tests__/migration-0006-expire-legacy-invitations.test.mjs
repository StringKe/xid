import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

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

function applyThrough(db, lastMigration) {
  for (const file of readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(migrationDir, file), 'utf8'))
    if (file === lastMigration) return
  }
  throw new Error(`missing migration ${lastMigration}`)
}

function applyMigration(db, migration) {
  db.exec(readFileSync(join(migrationDir, migration), 'utf8'))
}

function insertPreCutoverInvitation(db, id, status) {
  const now = Date.now()
  db.prepare(
    `INSERT INTO invitations (
       id, tenant_id, org_id, email, role, token_hash, invite_type, max_uses, used_count,
       status, invited_by_user_id, accepted_by_user_id, expires_at, created_at, updated_at
     ) VALUES (?, 'tenant-1', 'org-1', ?, 'member', ?, 'email', NULL, 0, ?, NULL, NULL, ?, ?, ?)`,
  ).run(id, `${id}@example.com`, `hash-${id}`, status, now + 86_400_000, now, now)
}

describe('migration 0006 legacy invitation cutover', () => {
  const databases = []

  afterEach(() => {
    for (const db of databases.splice(0)) db.close()
  })

  it('revokes every pre-cutover pending capability without changing terminal invitations', () => {
    const db = new DatabaseSync(':memory:')
    databases.push(db)
    applyThrough(db, '0005_platform-privacy-operations.sql')
    insertPreCutoverInvitation(db, 'pending-legacy', 'pending')
    insertPreCutoverInvitation(db, 'accepted-legacy', 'accepted')

    applyMigration(db, '0006_expire_legacy_invitation_tokens.sql')

    expect(
      db.prepare('SELECT id, token_version, status FROM invitations ORDER BY id').all(),
    ).toEqual([
      { id: 'accepted-legacy', token_version: 'legacy', status: 'accepted' },
      { id: 'pending-legacy', token_version: 'legacy', status: 'revoked' },
    ])
  })

  it('blocks old Worker inserts while allowing explicit locator_v1 invitations', () => {
    const db = new DatabaseSync(':memory:')
    databases.push(db)
    applyThrough(db, '0006_expire_legacy_invitation_tokens.sql')
    const now = Date.now()
    const insert = db.prepare(
      `INSERT INTO invitations (
         id, tenant_id, org_id, email, role, token_hash, token_version, invite_type,
         max_uses, used_count, status, invited_by_user_id, accepted_by_user_id,
         expires_at, created_at, updated_at
       ) VALUES (?, 'tenant-1', 'org-1', ?, 'member', ?, ?, 'email',
         NULL, 0, 'pending', NULL, NULL, ?, ?, ?)`,
    )

    expect(() =>
      insert.run(
        'locator-v1',
        'new@example.com',
        'hash-new',
        'locator_v1',
        now + 86_400_000,
        now,
        now,
      ),
    ).not.toThrow()
    expect(() =>
      db
        .prepare(
          `INSERT INTO invitations (
             id, tenant_id, org_id, email, role, token_hash, invite_type,
             max_uses, used_count, status, invited_by_user_id, accepted_by_user_id,
             expires_at, created_at, updated_at
           ) VALUES (
             'legacy-race', 'tenant-1', 'org-1', 'legacy@example.com', 'member',
             'hash-legacy-race', 'email', NULL, 0, 'pending', NULL, NULL, ?, ?, ?
           )`,
        )
        .run(now + 86_400_000, now, now),
    ).toThrow('legacy_invitation_token_disabled')
  })
})
