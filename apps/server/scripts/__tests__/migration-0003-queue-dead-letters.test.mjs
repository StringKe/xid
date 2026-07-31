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

function insertDeadLetter(db, id, sourceQueue, messageId) {
  db.prepare(
    `INSERT INTO queue_dead_letters (
       id, source_queue, dead_letter_queue, message_id, tenant_id, event_type, error_code,
       status, attempts, payload_iv, payload_ciphertext, payload_tag, payload_kek_version,
       source_enqueued_at, failed_at, replay_count, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'org_1', 'user.updated', 'consumer_retries_exhausted',
       'pending', 1, 'iv', 'ciphertext', 'tag', 1, 1000, 2000, 0, 2000, 2000)`,
  ).run(id, sourceQueue, `${sourceQueue}-dlq`, messageId)
}

describe('migration 0003 queue dead letters', () => {
  it('applies after all prior migrations and has ciphertext-only payload columns', () => {
    const db = new DatabaseSync(':memory:')
    applyAll(db)

    const columns = db
      .prepare(`PRAGMA table_info('queue_dead_letters')`)
      .all()
      .map((column) => column.name)
    expect(columns).toEqual(
      expect.arrayContaining([
        'source_queue',
        'dead_letter_queue',
        'message_id',
        'payload_iv',
        'payload_ciphertext',
        'payload_tag',
        'payload_kek_version',
        'replay_count',
      ]),
    )
    expect(columns).not.toEqual(
      expect.arrayContaining(['payload', 'body', 'recipient', 'token', 'authorization', 'cookie']),
    )

    const indexes = db
      .prepare(`PRAGMA index_list('queue_dead_letters')`)
      .all()
      .map((index) => index.name)
    expect(indexes).toEqual(
      expect.arrayContaining([
        'queue_dead_letters_source_message_unq',
        'queue_dead_letters_status_failed_id_idx',
        'queue_dead_letters_tenant_failed_id_idx',
        'queue_dead_letters_source_status_idx',
      ]),
    )
    db.close()
  })

  it('deduplicates a source message while allowing the same message id in another source queue', () => {
    const db = new DatabaseSync(':memory:')
    applyAll(db)
    insertDeadLetter(db, 'dlq_1', 'xid-email', 'message_1')

    expect(() => insertDeadLetter(db, 'dlq_2', 'xid-email', 'message_1')).toThrow()
    expect(() => insertDeadLetter(db, 'dlq_3', 'xid-webhook', 'message_1')).not.toThrow()
    db.close()
  })
})
