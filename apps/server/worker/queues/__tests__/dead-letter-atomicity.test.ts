import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareConditionalPlatformAuditOutboxInsert } from '../../platform/audit-outbox'
import {
  DEAD_LETTER_REPLAY_LEASE_MS,
  handleDeadLetterBatch,
  recoverStaleDeadLetterReplays,
  replayDeadLetter,
} from '../dead-letter'

class SqliteD1Statement {
  private bindings: unknown[] = []

  constructor(
    private readonly owner: SqliteD1,
    private readonly sql: string,
  ) {}

  bind(...bindings: unknown[]): this {
    this.bindings = bindings
    return this
  }

  execute(): D1Result<unknown> {
    if (this.owner.failReplayCompletion && this.sql.includes("SET status = 'replayed'")) {
      throw new Error('replay completion unavailable')
    }
    const result = this.owner.database.prepare(this.sql).run(...this.bindings)
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as D1Result<unknown>
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    return this.execute() as D1Result<T>
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.owner.database.prepare(this.sql).get(...this.bindings) as T | undefined) ?? null
  }
}

class SqliteD1 {
  readonly database = new DatabaseSync(':memory:')
  failReplayCompletion = false

  constructor() {
    this.database.exec(`
      CREATE TABLE queue_dead_letters (
        id TEXT PRIMARY KEY NOT NULL,
        source_queue TEXT NOT NULL,
        dead_letter_queue TEXT NOT NULL,
        message_id TEXT NOT NULL,
        tenant_id TEXT,
        org_id TEXT,
        event_type TEXT NOT NULL,
        error_code TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        payload_iv TEXT NOT NULL,
        payload_ciphertext TEXT NOT NULL,
        payload_tag TEXT NOT NULL,
        payload_kek_version INTEGER NOT NULL,
        source_enqueued_at INTEGER NOT NULL,
        failed_at INTEGER NOT NULL,
        replay_requested_at INTEGER,
        replayed_at INTEGER,
        replayed_by TEXT,
        replay_count INTEGER NOT NULL,
        last_replay_error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX queue_dead_letters_source_message_unq
        ON queue_dead_letters (source_queue, message_id);
      CREATE TABLE platform_audit_outbox (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        org_id TEXT,
        action TEXT NOT NULL,
        actor_id TEXT,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        available_at INTEGER NOT NULL,
        queued_at INTEGER,
        attempt_count INTEGER NOT NULL,
        last_error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
  }

  prepare(sql: string): D1PreparedStatement {
    return new SqliteD1Statement(this, sql) as unknown as D1PreparedStatement
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const results = statements.map((statement) =>
        (statement as unknown as SqliteD1Statement).execute(),
      )
      this.database.exec('COMMIT')
      return results as D1Result<T>[]
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.database.close()
  }
}

const databases: SqliteD1[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function asType<T>(value: unknown): T {
  return value as T
}

function testKek(): string {
  return btoa(String.fromCharCode(...new Uint8Array(32).fill(0x52)))
}

function makeEnv(): {
  env: Env
  database: SqliteD1
  emailSend: ReturnType<typeof vi.fn>
} {
  const database = new SqliteD1()
  databases.push(database)
  const emailSend = vi.fn(async () => undefined)
  const unusedQueue = asType<Queue<never>>({ send: vi.fn(async () => undefined) })
  return {
    database,
    emailSend,
    env: asType<Env>({
      KEK: testKek(),
      DB: database,
      ANALYTICS: { writeDataPoint: vi.fn() },
      EMAIL_QUEUE: { send: emailSend },
      WHATSAPP_QUEUE: unusedQueue,
      SMS_QUEUE: unusedQueue,
      AUDIT_QUEUE: unusedQueue,
      WEBHOOK_QUEUE: unusedQueue,
      METERING_QUEUE: unusedQueue,
      SCIM_QUEUE: unusedQueue,
      PRIVACY_QUEUE: unusedQueue,
    }),
  }
}

async function persistEmailDeadLetter(env: Env): Promise<string> {
  const message = {
    id: 'message_email_1',
    timestamp: new Date('2026-07-29T00:00:00.000Z'),
    body: {
      type: 'verify_email',
      recipient: 'private@example.test',
      payload: { tenantId: 'tenant_1', token: 'secret' },
    },
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  }
  await handleDeadLetterBatch(
    asType<MessageBatch<unknown>>({
      queue: 'xid-email-dlq',
      messages: [message],
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    }),
    env,
  )
  expect(message.ack).toHaveBeenCalledOnce()
  const row = (env.DB as unknown as SqliteD1).database
    .prepare('SELECT id FROM queue_dead_letters WHERE message_id = ?')
    .get(message.id) as { id: string }
  return row.id
}

function prepareReplayAudit(env: Env, id: string, claimedAtOffset = 0) {
  return (claimedAt: number) =>
    prepareConditionalPlatformAuditOutboxInsert(
      env,
      {
        id: `paud_replay_${id}`,
        tenantId: 'tenant_1',
        action: 'platform.queue_dead_letter.replayed',
        actorId: 'manager_1',
        payload: {
          targetType: 'queue_dead_letter',
          targetId: id,
          sourceQueue: 'xid-email',
        },
      },
      {
        sql: `EXISTS (
          SELECT 1
            FROM queue_dead_letters
           WHERE id = ? AND status = 'replaying' AND replay_requested_at = ?
        )`,
        bindings: [id, claimedAt + claimedAtOffset],
      },
      claimedAt,
    )
}

function scalar(database: SqliteD1, sql: string): number {
  return Number((database.database.prepare(sql).get() as { value: number }).value)
}

describe('dead-letter replay transaction against SQLite', () => {
  it('commits exactly one audit outbox row with the replay completion', async () => {
    const { env, database, emailSend } = makeEnv()
    const id = await persistEmailDeadLetter(env)

    await expect(
      replayDeadLetter(env, id, 'manager_1', prepareReplayAudit(env, id)),
    ).resolves.toMatchObject({ replayed: true, status: 'replayed' })

    expect(emailSend).toHaveBeenCalledOnce()
    expect(
      database.database
        .prepare('SELECT status, replay_count AS replayCount FROM queue_dead_letters')
        .get(),
    ).toEqual({ status: 'replayed', replayCount: 1 })
    expect(scalar(database, 'SELECT COUNT(*) AS value FROM platform_audit_outbox')).toBe(1)
  })

  it('does not complete the replay when the conditional audit cannot observe its lease', async () => {
    const { env, database, emailSend } = makeEnv()
    const id = await persistEmailDeadLetter(env)

    await expect(
      replayDeadLetter(env, id, 'manager_1', prepareReplayAudit(env, id, 1)),
    ).rejects.toThrow('dead_letter_replay_completion_not_observable')

    expect(emailSend).toHaveBeenCalledOnce()
    expect(
      database.database
        .prepare('SELECT status, replay_count AS replayCount FROM queue_dead_letters')
        .get(),
    ).toEqual({ status: 'replaying', replayCount: 0 })
    expect(scalar(database, 'SELECT COUNT(*) AS value FROM platform_audit_outbox')).toBe(0)
  })

  it('rolls back the audit insert when completion fails and converges after lease recovery', async () => {
    const { env, database, emailSend } = makeEnv()
    const id = await persistEmailDeadLetter(env)
    database.failReplayCompletion = true

    await expect(
      replayDeadLetter(env, id, 'manager_1', prepareReplayAudit(env, id)),
    ).rejects.toThrow('replay completion unavailable')

    expect(emailSend).toHaveBeenCalledOnce()
    expect(scalar(database, 'SELECT COUNT(*) AS value FROM platform_audit_outbox')).toBe(0)
    const replaying = database.database
      .prepare(
        'SELECT status, replay_count AS replayCount, replay_requested_at AS replayRequestedAt FROM queue_dead_letters',
      )
      .get() as { status: string; replayCount: number; replayRequestedAt: number }
    expect(replaying).toMatchObject({ status: 'replaying', replayCount: 0 })

    database.failReplayCompletion = false
    await expect(
      recoverStaleDeadLetterReplays(
        env,
        replaying.replayRequestedAt + DEAD_LETTER_REPLAY_LEASE_MS + 1,
      ),
    ).resolves.toBe(1)
    await expect(
      replayDeadLetter(env, id, 'manager_1', prepareReplayAudit(env, id)),
    ).resolves.toMatchObject({ replayed: true, status: 'replayed' })

    expect(emailSend).toHaveBeenCalledTimes(2)
    expect(scalar(database, 'SELECT COUNT(*) AS value FROM platform_audit_outbox')).toBe(1)
  })

  it('serializes concurrent replay claims to one source send and one audit row', async () => {
    const { env, database, emailSend } = makeEnv()
    const id = await persistEmailDeadLetter(env)

    const results = await Promise.all([
      replayDeadLetter(env, id, 'manager_1', prepareReplayAudit(env, id)),
      replayDeadLetter(env, id, 'manager_1', prepareReplayAudit(env, id)),
    ])

    expect(results.filter((result) => result?.replayed)).toHaveLength(1)
    expect(emailSend).toHaveBeenCalledOnce()
    expect(scalar(database, 'SELECT COUNT(*) AS value FROM platform_audit_outbox')).toBe(1)
  })
})
