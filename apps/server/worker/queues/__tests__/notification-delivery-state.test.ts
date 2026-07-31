import { describe, expect, it, vi } from 'vitest'
import type { AuditQueueMessage } from '@xid-kit/types'
import {
  prepareNotificationOutboxInsert,
  redeliverPendingNotificationOutbox,
  executeNotificationDelivery,
  NotificationProviderError,
  type NotificationDeliveryInput,
} from '../notification-delivery-state'
import { recordNotificationSent } from '../notification-audit'

type StoredRow = {
  status: string
  leaseUntil: number | null
  attemptCount: number
  providerAcceptedAt?: number
  auditQueuedAt?: number
}

function makeEnv(options: { failAuditStateWriteOnce?: boolean } = {}): {
  env: Env
  rows: Map<string, StoredRow>
  inserts: Array<ReadonlyArray<unknown>>
  failures: Array<ReadonlyArray<unknown>>
  auditMessages: AuditQueueMessage[]
} {
  const rows = new Map<string, StoredRow>()
  const inserts: Array<ReadonlyArray<unknown>> = []
  const failures: Array<ReadonlyArray<unknown>> = []
  const auditMessages: AuditQueueMessage[] = []
  let shouldFailAuditStateWrite = options.failAuditStateWriteOnce === true
  const keyFor = (tenantId: unknown, deliveryKey: unknown) => `${tenantId}:${deliveryKey}`
  const execute = async (query: string, args: ReadonlyArray<unknown>) => {
    if (query.includes('INSERT OR IGNORE INTO notification_delivery_outbox')) {
      inserts.push(args)
      const key = keyFor(args[1], args[4])
      if (!rows.has(key)) rows.set(key, { status: 'pending', leaseUntil: null, attemptCount: 0 })
      return { meta: { changes: 1 } }
    }
    if (query.includes('SET status = ?, lease_until = ?, attempt_count')) {
      const row = rows.get(keyFor(args[3], args[4]))
      if (row?.status !== args[5]) return { meta: { changes: 0 } }
      row.status = String(args[0])
      row.leaseUntil = Number(args[1])
      row.attemptCount += 1
      return { meta: { changes: 1 } }
    }
    if (query.includes('SET status = ?, lease_until = NULL, last_error_code')) {
      const row = rows.get(keyFor(args[5], args[6]))
      if (row?.status !== args[7]) return { meta: { changes: 0 } }
      row.status = String(args[0])
      row.leaseUntil = null
      return { meta: { changes: 1 } }
    }
    if (query.includes('INSERT INTO notification_delivery_failures')) {
      failures.push(args)
      return { meta: { changes: 1 } }
    }
    if (query.includes("SET status = 'delivered'")) {
      if (shouldFailAuditStateWrite) {
        shouldFailAuditStateWrite = false
        throw new Error('audit_state_write_failed')
      }
      const row = rows.get(keyFor(args[2], args[3]))
      if (row?.status !== 'auditing') return { meta: { changes: 0 } }
      row.status = 'delivered'
      row.leaseUntil = null
      row.auditQueuedAt = Number(args[0])
      return { meta: { changes: 1 } }
    }
    if (query.includes("SET status = 'provider_accepted', lease_until = NULL")) {
      const row = rows.get(keyFor(args[1], args[2]))
      if (row?.status !== 'auditing') return { meta: { changes: 0 } }
      row.status = 'provider_accepted'
      row.leaseUntil = null
      return { meta: { changes: 1 } }
    }
    if (query.includes("SET status = 'provider_accepted'")) {
      const row = rows.get(keyFor(args[2], args[3]))
      if (row?.status !== 'sending') return { meta: { changes: 0 } }
      row.status = 'provider_accepted'
      row.leaseUntil = null
      row.providerAcceptedAt = Number(args[0])
      return { meta: { changes: 1 } }
    }
    throw new Error(`unexpected query: ${query}`)
  }
  const db = {
    prepare: (query: string) => ({
      bind: (...args: Array<unknown>) => ({
        query,
        args,
        run: () => execute(query, args),
        first: async () => rows.get(keyFor(args[0], args[1])) ?? null,
      }),
    }),
    batch: (statements: Array<{ query: string; args: ReadonlyArray<unknown> }>) =>
      Promise.all(statements.map((statement) => execute(statement.query, statement.args))),
  }
  return {
    env: {
      DB: db,
      KEK: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
      AUDIT_QUEUE: { send: async (message: AuditQueueMessage) => auditMessages.push(message) },
    } as unknown as Env,
    rows,
    inserts,
    failures,
    auditMessages,
  }
}

function makeInput(messageId = 'queue-message-1'): NotificationDeliveryInput {
  return {
    messageId,
    tenantId: 'tenant-1',
    channel: 'email',
    type: 'magic_link',
    provider: 'cloudflare',
    recipient: 'user@example.com',
    payload: { tenantId: 'tenant-1', token: 'token-secret' },
  }
}

describe('notification delivery state', () => {
  it('provider 已接受后审计失败只重试审计，不再次调用 provider', async () => {
    const { env, rows } = makeEnv()
    const input = makeInput()
    const send = vi.fn().mockResolvedValue(undefined)
    const failedAudit = vi.fn().mockRejectedValue(new Error('audit_queue_down'))

    await expect(
      executeNotificationDelivery(env, input, { send, recordAudit: failedAudit }),
    ).resolves.toBe('retry')
    expect(send).toHaveBeenCalledOnce()
    expect(rows.get('tenant-1:email:queue-message-1')?.status).toBe('provider_accepted')

    const recoveredAudit = vi.fn().mockResolvedValue(undefined)
    await expect(
      executeNotificationDelivery(env, input, { send, recordAudit: recoveredAudit }),
    ).resolves.toBe('ack')
    expect(send).toHaveBeenCalledOnce()
    expect(recoveredAudit).toHaveBeenCalledOnce()
    expect(rows.get('tenant-1:email:queue-message-1')?.status).toBe('delivered')
  })

  it('provider 调用异常进入 unknown_delivery，重投递不再调用 provider', async () => {
    const { env, rows } = makeEnv()
    const input = makeInput('queue-message-2')
    const send = vi.fn().mockRejectedValue(new Error('provider_timeout'))
    const recordAudit = vi.fn().mockResolvedValue(undefined)

    await expect(executeNotificationDelivery(env, input, { send, recordAudit })).resolves.toBe(
      'ack',
    )
    expect(rows.get('tenant-1:email:queue-message-2')?.status).toBe('unknown_delivery')

    await expect(executeNotificationDelivery(env, input, { send, recordAudit })).resolves.toBe(
      'ack',
    )
    expect(send).toHaveBeenCalledOnce()
    expect(recordAudit).not.toHaveBeenCalled()
  })

  it('outbox 不保存明文 recipient 或 payload token', async () => {
    const { env, inserts } = makeEnv()
    const input = makeInput('queue-message-3')

    await executeNotificationDelivery(env, input, {
      send: vi.fn().mockRejectedValue(new Error('provider_timeout')),
      recordAudit: vi.fn(),
    })

    const serialized = JSON.stringify(inserts[0])
    expect(serialized).not.toContain('user@example.com')
    expect(serialized).not.toContain('token-secret')
  })

  it('producer outbox 解密重派使用稳定 deliveryId，并在 Queue 接收后标记 queued', async () => {
    const input = makeInput('invitation-message-id')
    const sent: unknown[] = []
    let insertArgs: unknown[] = []
    let markedQueued = 0
    const db = {
      prepare: (query: string) => {
        let args: unknown[] = []
        const statement = {
          bind: (...values: unknown[]) => {
            args = values
            return statement
          },
          run: async () => {
            if (query.startsWith('INSERT INTO notification_delivery_outbox')) {
              insertArgs = args
            }
            if (query.includes('SET queued_at = COALESCE')) markedQueued += 1
            return { meta: { changes: 1 } }
          },
          all: async () => ({
            results: [
              {
                tenantId: insertArgs[1],
                deliveryKey: insertArgs[2],
                sourceMessageId: insertArgs[3],
                type: insertArgs[6],
                provider: insertArgs[7],
                recipientIv: insertArgs[9],
                recipientCiphertext: insertArgs[10],
                recipientTag: insertArgs[11],
                payloadIv: insertArgs[12],
                payloadCiphertext: insertArgs[13],
                payloadTag: insertArgs[14],
              },
            ],
          }),
        }
        return statement
      },
    }
    const env = {
      DB: db,
      KEK: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
      EMAIL_QUEUE: {
        send: async (message: unknown) => {
          sent.push(message)
        },
      },
    } as unknown as Env

    const insert = await prepareNotificationOutboxInsert(env, input, {
      ignoreExisting: false,
      now: 100,
    })
    await insert.run()
    await redeliverPendingNotificationOutbox(env, 101)

    expect(sent).toEqual([
      {
        deliveryId: 'invitation-message-id',
        type: 'magic_link',
        recipient: 'user@example.com',
        payload: { tenantId: 'tenant-1', token: 'token-secret' },
      },
    ])
    expect(markedQueued).toBe(1)
  })

  it('provider 明确拒绝写入可查询失败记录且不重投递', async () => {
    const { env, failures, rows } = makeEnv()
    const input = makeInput('queue-message-rejected')
    const send = vi.fn().mockRejectedValue(new NotificationProviderError('rejected', 'twilio_400'))

    await expect(
      executeNotificationDelivery(env, input, { send, recordAudit: vi.fn() }),
    ).resolves.toBe('ack')
    expect(rows.get('tenant-1:email:queue-message-rejected')?.status).toBe('provider_rejected')
    expect(failures).toHaveLength(1)
    expect(failures[0]?.[6]).toBe('rejected')

    await expect(
      executeNotificationDelivery(env, input, { send, recordAudit: vi.fn() }),
    ).resolves.toBe('ack')
    expect(send).toHaveBeenCalledOnce()
  })

  it('相同 Queue source id 在 email 和 sms 使用独立状态', async () => {
    const { env, rows } = makeEnv()
    const email = makeInput('shared-source')
    const sms = { ...email, channel: 'sms' as const, provider: 'twilio', recipient: '+15551234567' }

    await executeNotificationDelivery(env, email, {
      send: vi.fn().mockRejectedValue(new Error('network_timeout')),
      recordAudit: vi.fn(),
    })
    await executeNotificationDelivery(env, sms, {
      send: vi.fn().mockRejectedValue(new Error('network_timeout')),
      recordAudit: vi.fn(),
    })

    expect(rows.get('tenant-1:email:shared-source')?.status).toBe('unknown_delivery')
    expect(rows.get('tenant-1:sms:shared-source')?.status).toBe('unknown_delivery')
  })

  it('审计入队成功但状态写失败时使用同一 source identity，provider 不会重发', async () => {
    const { env, auditMessages } = makeEnv({ failAuditStateWriteOnce: true })
    const input = makeInput('queue-audit-state-failure')
    const send = vi.fn().mockResolvedValue(undefined)
    const recordAudit = () => recordNotificationSent(env, input)

    await expect(executeNotificationDelivery(env, input, { send, recordAudit })).resolves.toBe(
      'retry',
    )
    await expect(executeNotificationDelivery(env, input, { send, recordAudit })).resolves.toBe(
      'ack',
    )

    expect(send).toHaveBeenCalledOnce()
    expect(auditMessages.map((message) => message.payload.sourceMessageId)).toEqual([
      'notification:email:queue-audit-state-failure',
      'notification:email:queue-audit-state-failure',
    ])
  })
})
