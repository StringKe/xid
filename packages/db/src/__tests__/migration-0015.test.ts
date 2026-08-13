import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import migration from '../../drizzle/0015_magic_link_tokens.sql?raw'

describe('0015 magic link token ledger migration', () => {
  it('allows multiple active links for one tenant user while keeping token hashes unique', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(migration)

    const insert = db.prepare(
      `INSERT INTO magic_link_tokens (
         id, tenant_id, user_id, token_hash, flow_context, expires_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    insert.run('ml_1', 'tenant_a', 'user_a', 'hash_1', '{}', 2_000, 1_000)
    expect(() =>
      insert.run('ml_2', 'tenant_a', 'user_a', 'hash_2', '{}', 2_100, 1_100),
    ).not.toThrow()
    expect(() => insert.run('ml_3', 'tenant_b', 'user_b', 'hash_1', '{}', 2_200, 1_200)).toThrow()

    expect(
      db
        .prepare(
          `SELECT id, consumed_at
             FROM magic_link_tokens
            WHERE tenant_id = ? AND user_id = ?
            ORDER BY created_at`,
        )
        .all('tenant_a', 'user_a'),
    ).toEqual([
      { id: 'ml_1', consumed_at: null },
      { id: 'ml_2', consumed_at: null },
    ])

    const indexes = db
      .prepare(`PRAGMA index_list('magic_link_tokens')`)
      .all()
      .map((row) => String((row as { name: unknown }).name))
    expect(indexes).toEqual(
      expect.arrayContaining([
        'magic_link_tokens_hash_unq',
        'magic_link_tokens_tenant_user_expiry_idx',
      ]),
    )

    db.close()
  })
})
