import { describe, expect, it, vi } from 'vitest'
import {
  DEAD_LETTER_REPLAY_LEASE_MS,
  DEAD_LETTER_SOURCES,
  deadLetterMetadata,
  handleDeadLetterBatch,
  recoverStaleDeadLetterReplays,
  replayDeadLetter,
} from '../dead-letter'
import { isPersistedId } from '../../lib/persisted-id'
import { prepareConditionalPlatformAuditOutboxInsert } from '../../platform/audit-outbox'

type StoredRow = {
  id: string
  sourceQueue: string
  deadLetterQueue: string
  messageId: string
  tenantId: string | null
  orgId: string | null
  eventType: string
  status: string
  attempts: number
  payloadIv: string
  payloadCiphertext: string
  payloadTag: string
  payloadKekVersion: number
  sourceEnqueuedAt: number
  failedAt: number
  replayRequestedAt: number | null
  replayedBy: string | null
  replayCount: number
  lastReplayErrorCode: string | null
}

type StoredAudit = {
  id: string
  tenantId: string
  action: string
  actorId: string | null
  payload: string
  status: string
}

type FakeMessage = {
  id: string
  timestamp: Date
  body: unknown
  attempts: number
  ack: ReturnType<typeof vi.fn>
  retry: ReturnType<typeof vi.fn>
}

function asType<T>(value: unknown): T {
  return value as T
}

function testKek(): string {
  return btoa(String.fromCharCode(...new Uint8Array(32).fill(0x52)))
}

function makeMessage(body: unknown, id = 'queue_message_1'): FakeMessage {
  return {
    id,
    timestamp: new Date('2026-07-28T00:00:00.000Z'),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  }
}

function makeBatch(queue: string, messages: FakeMessage[]): MessageBatch<unknown> {
  return asType<MessageBatch<unknown>>({
    queue,
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  })
}

function fixtures(): Record<string, unknown> {
  return {
    'xid-email': {
      type: 'verify_email',
      recipient: 'private@example.test',
      payload: { tenantId: 'org_1', token: 'email-token-secret' },
    },
    'xid-whatsapp': {
      type: 'otp',
      recipient: '+15555550100',
      payload: { tenantId: 'org_1', otp: '123456' },
    },
    'xid-sms': {
      type: 'otp',
      recipient: '+15555550101',
      payload: { tenantId: 'org_1', otp: '654321' },
    },
    'xid-audit': {
      tenantId: 'org_1',
      orgId: 'org_child',
      action: 'membership.updated',
      ts: Date.now(),
      payload: { token: 'audit-secret' },
    },
    'xid-webhook': {
      tenantId: 'org_1',
      event: 'user.updated',
      payload: { authorization: 'Bearer webhook-secret' },
    },
    'xid-metering': { tenantId: 'org_1', userId: 'user_1', ts: Date.now() },
    'xid-scim-sync': {
      tenantId: 'org_1',
      orgId: 'org_child',
      targetId: 'target_1',
      issuer: 'https://xid.example.test',
      runId: 'run_1',
      requestedAt: Date.now(),
    },
    'xid-privacy': {
      requestId: 'prv_1',
      tenantId: 'org_1',
      userId: 'user_1',
      operation: 'export',
      requestedAt: Date.now(),
    },
  }
}

function makeEnv(options: { insertFails?: boolean; auditInsertFails?: boolean } = {}) {
  const rows = new Map<string, StoredRow>()
  const audits = new Map<string, StoredAudit>()
  const sent = new Map<string, unknown[]>()
  const failures = {
    auditInsert: options.auditInsertFails ?? false,
  }
  const queue = (name: string): Queue<never> =>
    asType<Queue<never>>({
      send: vi.fn(async (body: unknown) => {
        sent.set(name, [...(sent.get(name) ?? []), body])
      }),
    })

  const prepare = (sql: string) => {
    let params: unknown[] = []
    const statement = {
      bind: (...values: unknown[]) => {
        params = values
        return statement
      },
      first: async () => {
        if (sql.includes('WHERE source_queue = ? AND message_id = ?')) {
          const found = [...rows.values()].find(
            (row) => row.sourceQueue === params[0] && row.messageId === params[1],
          )
          return found ? { id: found.id } : null
        }
        if (sql.includes('WHERE id = ?')) return rows.get(String(params[0])) ?? null
        return null
      },
      run: async () => {
        if (sql.includes('INSERT INTO platform_audit_outbox')) {
          if (failures.auditInsert) throw new Error('audit outbox unavailable')
          const deadLetterId = String(params.at(-2))
          const claimedAt = Number(params.at(-1))
          const deadLetter = rows.get(deadLetterId)
          if (
            !deadLetter ||
            deadLetter.status !== 'replaying' ||
            deadLetter.replayRequestedAt !== claimedAt
          ) {
            return { success: true, meta: { changes: 0 } }
          }
          const id = String(params[0])
          if (audits.has(id)) throw new Error('audit outbox duplicate')
          audits.set(id, {
            id,
            tenantId: String(params[1]),
            action: String(params[3]),
            actorId: params[4] === null ? null : String(params[4]),
            payload: String(params[5]),
            status: 'pending',
          })
          return { success: true, meta: { changes: 1 } }
        }
        if (sql.includes('INSERT OR IGNORE INTO queue_dead_letters')) {
          if (options.insertFails) throw new Error('d1 unavailable')
          const [
            id,
            sourceQueue,
            deadLetterQueue,
            messageId,
            tenantId,
            orgId,
            eventType,
            attempts,
            payloadIv,
            payloadCiphertext,
            payloadTag,
            payloadKekVersion,
            sourceEnqueuedAt,
            failedAt,
          ] = params
          const key = `${String(sourceQueue)}:${String(messageId)}`
          if (![...rows.values()].some((row) => `${row.sourceQueue}:${row.messageId}` === key)) {
            rows.set(String(id), {
              id: String(id),
              sourceQueue: String(sourceQueue),
              deadLetterQueue: String(deadLetterQueue),
              messageId: String(messageId),
              tenantId: tenantId === null ? null : String(tenantId),
              orgId: orgId === null ? null : String(orgId),
              eventType: String(eventType),
              status: 'pending',
              attempts: Number(attempts),
              payloadIv: String(payloadIv),
              payloadCiphertext: String(payloadCiphertext),
              payloadTag: String(payloadTag),
              payloadKekVersion: Number(payloadKekVersion),
              sourceEnqueuedAt: Number(sourceEnqueuedAt),
              failedAt: Number(failedAt),
              replayRequestedAt: null,
              replayedBy: null,
              replayCount: 0,
              lastReplayErrorCode: null,
            })
          }
          return { success: true, meta: { changes: 1 } }
        }

        if (
          sql.includes("SET status = 'pending'") &&
          sql.includes("last_replay_error_code = 'replay_lease_expired'")
        ) {
          const staleBefore = Number(params[1])
          let changes = 0
          for (const candidate of rows.values()) {
            if (
              candidate.status === 'replaying' &&
              (candidate.replayRequestedAt === null || candidate.replayRequestedAt <= staleBefore)
            ) {
              candidate.status = 'pending'
              candidate.lastReplayErrorCode = 'replay_lease_expired'
              changes += 1
            }
          }
          return { success: true, meta: { changes } }
        }
        if (sql.includes("SET status = 'replaying'")) {
          const row = rows.get(String(params[3]))
          if (!row) return { success: true, meta: { changes: 0 } }
          const staleBefore = Number(params[4])
          if (
            row.status !== 'pending' &&
            !(
              row.status === 'replaying' &&
              (row.replayRequestedAt === null || row.replayRequestedAt <= staleBefore)
            )
          ) {
            return { success: true, meta: { changes: 0 } }
          }
          row.status = 'replaying'
          row.replayedBy = String(params[1])
          row.replayRequestedAt = Number(params[0])
          return { success: true, meta: { changes: 1 } }
        }
        if (sql.includes("SET status = 'pending'")) {
          const row = rows.get(String(params[2]))
          if (!row || row.status !== 'replaying' || row.replayRequestedAt !== Number(params[3])) {
            return { success: true, meta: { changes: 0 } }
          }
          row.status = 'pending'
          row.lastReplayErrorCode = String(params[0])
          return { success: true, meta: { changes: 1 } }
        }
        if (sql.includes("SET status = 'replayed'")) {
          const row = rows.get(String(params[2]))
          const auditId = String(params[4])
          if (
            !sql.includes('platform_audit_outbox') ||
            !audits.has(auditId) ||
            !row ||
            row.status !== 'replaying' ||
            row.replayRequestedAt !== Number(params[3])
          ) {
            return { success: true, meta: { changes: 0 } }
          }
          row.status = 'replayed'
          row.replayCount += 1
          row.lastReplayErrorCode = null
          return { success: true, meta: { changes: 1 } }
        }
        return { success: true, meta: { changes: 0 } }
      },
    }
    return statement
  }

  const env = asType<Env>({
    KEK: testKek(),
    DB: {
      prepare,
      batch: async (statements: D1PreparedStatement[]) => {
        const rowSnapshot = structuredClone([...rows.entries()])
        const auditSnapshot = structuredClone([...audits.entries()])
        try {
          const results = []
          for (const statement of statements) results.push(await statement.run())
          return results
        } catch (error) {
          rows.clear()
          for (const [id, row] of rowSnapshot) rows.set(id, row)
          audits.clear()
          for (const [id, audit] of auditSnapshot) audits.set(id, audit)
          throw error
        }
      },
    },
    ANALYTICS: { writeDataPoint: vi.fn() },
    EMAIL_QUEUE: queue('xid-email'),
    WHATSAPP_QUEUE: queue('xid-whatsapp'),
    SMS_QUEUE: queue('xid-sms'),
    AUDIT_QUEUE: queue('xid-audit'),
    WEBHOOK_QUEUE: queue('xid-webhook'),
    METERING_QUEUE: queue('xid-metering'),
    SCIM_QUEUE: queue('xid-scim-sync'),
    PRIVACY_QUEUE: queue('xid-privacy'),
  })
  return { env, rows, audits, sent, failures }
}

function prepareReplayAudit(env: Env, row: StoredRow, actorId = 'user_manager') {
  return (claimedAt: number) =>
    prepareConditionalPlatformAuditOutboxInsert(
      env,
      {
        id: `paud_replay_${row.id}`,
        tenantId: row.tenantId ?? 'platform',
        ...(row.orgId ? { orgId: row.orgId } : {}),
        action: 'platform.queue_dead_letter.replayed',
        actorId,
        payload: {
          targetType: 'queue_dead_letter',
          targetId: row.id,
          sourceQueue: row.sourceQueue,
        },
      },
      {
        sql: `EXISTS (
          SELECT 1
            FROM queue_dead_letters
           WHERE id = ? AND status = 'replaying' AND replay_requested_at = ?
        )`,
        bindings: [row.id, claimedAt],
      },
      claimedAt,
    )
}

describe('dead-letter source mapping and encrypted persistence', () => {
  it('maps all eight business queues to distinct dead-letter queues', () => {
    expect(DEAD_LETTER_SOURCES).toHaveLength(8)
    expect(new Set(DEAD_LETTER_SOURCES.map((source) => source.sourceQueue)).size).toBe(8)
    expect(new Set(DEAD_LETTER_SOURCES.map((source) => source.deadLetterQueue)).size).toBe(8)
    expect(DEAD_LETTER_SOURCES.map((source) => source.sourceQueue)).toContain('xid-scim-sync')
    expect(DEAD_LETTER_SOURCES.map((source) => source.sourceQueue)).toContain('xid-privacy')
  })

  it('extracts only bounded operational metadata', () => {
    expect(
      deadLetterMetadata('xid-email', {
        type: 'otp',
        recipient: 'private@example.test',
        payload: { tenantId: 'org_1', token: 'secret' },
      }),
    ).toEqual({ tenantId: 'org_1', orgId: null, eventType: 'otp' })
  })

  it.each(DEAD_LETTER_SOURCES)(
    'persists $sourceQueue body as KEK ciphertext and replays only to the source queue',
    async ({ sourceQueue, deadLetterQueue }) => {
      const fixture = fixtures()[sourceQueue]
      const message = makeMessage(fixture, `message_${sourceQueue}`)
      const { env, rows, audits, sent } = makeEnv()

      await handleDeadLetterBatch(makeBatch(deadLetterQueue, [message]), env)

      expect(message.ack).toHaveBeenCalledOnce()
      expect(message.retry).not.toHaveBeenCalled()
      const row = [...rows.values()][0]
      expect(row).toBeDefined()
      expect(isPersistedId('queueDeadLetter', row?.id ?? '')).toBe(true)
      expect(row?.sourceQueue).toBe(sourceQueue)
      expect(row?.deadLetterQueue).toBe(deadLetterQueue)
      expect(JSON.stringify(row)).not.toContain('private@example.test')
      expect(JSON.stringify(row)).not.toContain('123456')
      expect(JSON.stringify(row)).not.toContain('email-token-secret')
      expect(JSON.stringify(row)).not.toContain('webhook-secret')

      const first = await replayDeadLetter(
        env,
        row?.id ?? '',
        'user_manager',
        prepareReplayAudit(env, row!),
      )
      const second = await replayDeadLetter(
        env,
        row?.id ?? '',
        'user_manager',
        prepareReplayAudit(env, row!),
      )

      expect(first).toMatchObject({ status: 'replayed', replayed: true, idempotent: false })
      expect(second).toMatchObject({ status: 'replayed', replayed: false, idempotent: true })
      expect(audits.size).toBe(1)
      expect(sent.get(sourceQueue)).toEqual([fixture])
      expect([...sent.entries()].filter(([, values]) => values.length > 0)).toHaveLength(1)
    },
  )

  it('retries without ack when encrypted persistence fails', async () => {
    const message = makeMessage(fixtures()['xid-email'])
    const { env } = makeEnv({ insertFails: true })

    await handleDeadLetterBatch(makeBatch('xid-email-dlq', [message]), env)

    expect(message.retry).toHaveBeenCalledOnce()
    expect(message.ack).not.toHaveBeenCalled()
  })

  it('retries unknown DLQ batches rather than acknowledging them', async () => {
    const batch = makeBatch('xid-unknown-dlq', [makeMessage({})])
    const { env } = makeEnv()

    await handleDeadLetterBatch(batch, env)

    expect(batch.retryAll).toHaveBeenCalledOnce()
  })

  it('reclaims an expired replay lease and sends the original message once for the new claim', async () => {
    const fixture = fixtures()['xid-email']
    const message = makeMessage(fixture)
    const { env, rows, sent } = makeEnv()
    await handleDeadLetterBatch(makeBatch('xid-email-dlq', [message]), env)
    const row = [...rows.values()][0]!
    row.status = 'replaying'
    row.replayRequestedAt = Date.now() - DEAD_LETTER_REPLAY_LEASE_MS - 1

    const result = await replayDeadLetter(env, row.id, 'user_manager', prepareReplayAudit(env, row))

    expect(result).toMatchObject({ status: 'replayed', replayed: true, idempotent: false })
    expect(sent.get('xid-email')).toEqual([fixture])
    expect(row.replayCount).toBe(1)
  })

  it('does not steal a live replay lease', async () => {
    const message = makeMessage(fixtures()['xid-email'])
    const { env, rows, sent } = makeEnv()
    await handleDeadLetterBatch(makeBatch('xid-email-dlq', [message]), env)
    const row = [...rows.values()][0]!
    row.status = 'replaying'
    row.replayRequestedAt = Date.now()

    const result = await replayDeadLetter(env, row.id, 'user_manager', prepareReplayAudit(env, row))

    expect(result).toMatchObject({ status: 'replaying', replayed: false, idempotent: true })
    expect(sent.get('xid-email')).toBeUndefined()
  })

  it('hourly recovery releases only expired replay leases', async () => {
    const { env, rows } = makeEnv()
    await handleDeadLetterBatch(
      makeBatch('xid-email-dlq', [
        makeMessage(fixtures()['xid-email'], 'message_stale'),
        makeMessage(fixtures()['xid-email'], 'message_live'),
      ]),
      env,
    )
    const [stale, live] = [...rows.values()]
    const now = Date.now()
    stale!.status = 'replaying'
    stale!.replayRequestedAt = now - DEAD_LETTER_REPLAY_LEASE_MS - 1
    live!.status = 'replaying'
    live!.replayRequestedAt = now

    await expect(recoverStaleDeadLetterReplays(env, now)).resolves.toBe(1)
    expect(stale).toMatchObject({
      status: 'pending',
      lastReplayErrorCode: 'replay_lease_expired',
    })
    expect(live?.status).toBe('replaying')
  })

  it('keeps replay completion pending when the audit outbox transaction fails and converges after lease recovery', async () => {
    const fixture = fixtures()['xid-email']
    const message = makeMessage(fixture)
    const { env, rows, audits, sent, failures } = makeEnv({ auditInsertFails: true })
    await handleDeadLetterBatch(makeBatch('xid-email-dlq', [message]), env)
    const row = [...rows.values()][0]!

    await expect(
      replayDeadLetter(env, row.id, 'user_manager', prepareReplayAudit(env, row)),
    ).rejects.toThrow('audit outbox unavailable')

    expect(sent.get('xid-email')).toEqual([fixture])
    expect(rows.get(row.id)?.status).toBe('replaying')
    expect(rows.get(row.id)?.replayCount).toBe(0)
    expect(audits.size).toBe(0)

    failures.auditInsert = false
    const replaying = rows.get(row.id)!
    await expect(
      recoverStaleDeadLetterReplays(
        env,
        (replaying.replayRequestedAt ?? 0) + DEAD_LETTER_REPLAY_LEASE_MS + 1,
      ),
    ).resolves.toBe(1)
    await expect(
      replayDeadLetter(env, row.id, 'user_manager', prepareReplayAudit(env, replaying)),
    ).resolves.toMatchObject({ status: 'replayed', replayed: true, idempotent: false })

    expect(sent.get('xid-email')).toEqual([fixture, fixture])
    expect(rows.get(row.id)?.status).toBe('replayed')
    expect(rows.get(row.id)?.replayCount).toBe(1)
    expect(audits.size).toBe(1)
  })
})
