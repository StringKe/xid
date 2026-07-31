import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import migration from '../../drizzle/0010_passwordless_flow_context.sql?raw'

describe('0010 passwordless flow context migration', () => {
  it('adds a nullable flow context without rewriting active verification credentials', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE verification_tokens (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        code_hash TEXT,
        channel TEXT,
        purpose TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        consumed_at INTEGER,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO verification_tokens (
        id, tenant_id, user_id, token_hash, purpose, expires_at, created_at
      ) VALUES ('token_1', 'tenant_1', 'user_1', 'hash_1', 'magic_link', 2, 1);
    `)

    db.exec(migration)

    expect(
      db
        .prepare(
          `SELECT id, flow_context
             FROM verification_tokens
            WHERE tenant_id = ? AND user_id = ?`,
        )
        .get('tenant_1', 'user_1'),
    ).toEqual({ id: 'token_1', flow_context: null })

    db.prepare(
      `UPDATE verification_tokens
          SET flow_context = ?
        WHERE tenant_id = ? AND id = ?`,
    ).run('{"version":1}', 'tenant_1', 'token_1')
    expect(
      db.prepare('SELECT flow_context FROM verification_tokens WHERE id = ?').get('token_1'),
    ).toEqual({ flow_context: '{"version":1}' })
    db.close()
  })
})
