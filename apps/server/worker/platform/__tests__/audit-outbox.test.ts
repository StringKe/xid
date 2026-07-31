import type { AuditQueueMessage } from '@xid-kit/types'
import { describe, expect, it, vi } from 'vitest'
import {
  completePlatformAuditOutbox,
  recordPlatformAudit,
  redeliverPendingPlatformAudits,
} from '../audit-outbox'

type StoredRow = {
  id: string
  tenantId: string
  orgId: string | null
  action: string
  actorId: string | null
  payload: string
  status: string
  availableAt: number
  createdAt: number
}

function makeEnv(send: (message: AuditQueueMessage) => Promise<void>) {
  const rows = new Map<string, StoredRow>()
  const prepare = (query: string) => {
    let args: unknown[] = []
    const statement = {
      bind: (...values: unknown[]) => {
        args = values
        return statement
      },
      run: async () => {
        if (query.includes('INSERT INTO platform_audit_outbox')) {
          rows.set(String(args[0]), {
            id: String(args[0]),
            tenantId: String(args[1]),
            orgId: args[2] === null ? null : String(args[2]),
            action: String(args[3]),
            actorId: args[4] === null ? null : String(args[4]),
            payload: String(args[5]),
            status: 'pending',
            availableAt: Number(args[6]),
            createdAt: Number(args[7]),
          })
        } else if (query.includes("SET status = 'queued'")) {
          const row = rows.get(String(args[2]))
          if (row) row.status = 'queued'
        } else if (query.includes("SET status = 'pending'")) {
          const row = rows.get(String(args[2]))
          if (row) {
            row.status = 'pending'
            row.availableAt = Number(args[0])
          }
        } else if (query.includes("SET status = 'delivered'")) {
          const row = rows.get(String(args[1]))
          if (row) row.status = 'delivered'
        }
        return { meta: { changes: 1 } }
      },
      all: async () => ({
        results: [...rows.values()]
          .filter((row) => row.status === 'pending' && row.availableAt <= Number(args[0]))
          .map((row) => ({
            id: row.id,
            tenantId: row.tenantId,
            orgId: row.orgId,
            action: row.action,
            actorId: row.actorId,
            payload: row.payload,
            createdAt: row.createdAt,
          })),
      }),
    }
    return statement
  }
  return {
    env: {
      DB: { prepare },
      AUDIT_QUEUE: { send },
    } as unknown as Env,
    rows,
  }
}

describe('platform audit outbox', () => {
  it('persists redacted metadata before Queue handoff and completes by stable source id', async () => {
    const sent: AuditQueueMessage[] = []
    const { env, rows } = makeEnv(async (message) => {
      sent.push(message)
    })

    const prepared = await recordPlatformAudit(env, {
      tenantId: 'tenant_1',
      action: 'platform.users.searched',
      actorId: 'user_manager',
      payload: { query: 'person@example.com', targetType: 'user' },
      ts: 100,
    })

    expect(JSON.parse(rows.get(prepared.id)?.payload ?? '{}')).toEqual({
      query: '[redacted]',
      targetType: 'user',
    })
    expect(sent[0]?.payload.sourceMessageId).toBe(`platform-audit:${prepared.id}`)
    expect(rows.get(prepared.id)?.status).toBe('queued')

    await completePlatformAuditOutbox(env, `platform-audit:${prepared.id}`, 200)
    expect(rows.get(prepared.id)?.status).toBe('delivered')
  })

  it('Queue failure remains pending and Cron redelivery reuses the same source id', async () => {
    const send = vi
      .fn<(message: AuditQueueMessage) => Promise<void>>()
      .mockRejectedValueOnce(new Error('queue_unavailable'))
      .mockResolvedValue(undefined)
    const { env, rows } = makeEnv(send)

    const prepared = await recordPlatformAudit(env, {
      tenantId: 'tenant_1',
      action: 'platform.plan_changed',
      payload: { targetId: 'tenant_1' },
      ts: 100,
    })
    expect(rows.get(prepared.id)?.status).toBe('pending')

    await redeliverPendingPlatformAudits(env, Number.MAX_SAFE_INTEGER)

    expect(send).toHaveBeenCalledTimes(2)
    const firstMessage = send.mock.calls[0]?.[0]
    const secondMessage = send.mock.calls[1]?.[0]
    expect(firstMessage).toBeDefined()
    expect(secondMessage).toBeDefined()
    expect(firstMessage?.payload.sourceMessageId).toBe(secondMessage?.payload.sourceMessageId)
    expect(rows.get(prepared.id)?.status).toBe('queued')
  })
})
