import type { PrivacyQueueMessage } from '@xid-kit/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/session', () => ({
  sessionDoRevoke: vi.fn().mockResolvedValue(undefined),
  sessionDoRevokeAll: vi.fn().mockResolvedValue(undefined),
}))

import { sessionDoRevoke, sessionDoRevokeAll } from '../../lib/session'
import { PRIVACY_EXPORT_TTL_MS } from '../../privacy/constants'
import { handlePrivacyBatch } from '../privacy'

type CapturedStatement = {
  sql: string
  params: unknown[]
  run: () => Promise<D1Result<unknown>>
  all: <T>() => Promise<D1Result<T>>
  first: <T>() => Promise<T | null>
}

function asType<T>(value: unknown): T {
  return value as T
}

function message(body: PrivacyQueueMessage) {
  return {
    id: 'queue_message_1',
    timestamp: new Date(body.requestedAt),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  }
}

function batch(item: ReturnType<typeof message>): MessageBatch<PrivacyQueueMessage> {
  return asType<MessageBatch<PrivacyQueueMessage>>({
    queue: 'xid-privacy',
    messages: [item],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  })
}

function request(operation: 'export' | 'delete'): PrivacyQueueMessage {
  return {
    requestId: `prv_${operation}`,
    tenantId: 't_1',
    userId: 'user_1',
    operation,
    requestedAt: Date.parse('2026-07-28T00:00:00.000Z'),
  }
}

function makeExportEnv(options: { putFails?: boolean; requestExists?: boolean } = {}) {
  let status = 'pending'
  let exportBody = ''
  let expiresAt: number | null = null
  const sqlLog: string[] = []
  const prepare = (sql: string) => {
    let params: unknown[] = []
    const statement = {
      bind: (...values: unknown[]) => {
        params = values
        return statement
      },
      run: async () => {
        sqlLog.push(sql)
        if (sql.includes("SET status = 'processing'")) {
          if (options.requestExists === false) {
            return { success: true, meta: { changes: 0 } }
          }
          if (status !== 'pending') return { success: true, meta: { changes: 0 } }
          status = 'processing'
          return { success: true, meta: { changes: 1 } }
        }
        if (sql.includes("SET status = 'completed'") && sql.includes('storage_key')) {
          status = 'completed'
          expiresAt = Number(params[3])
          return { success: true, meta: { changes: 1 } }
        }
        if (sql.includes("SET status = 'pending'")) {
          status = 'pending'
          return { success: true, meta: { changes: 1 } }
        }
        return { success: true, meta: { changes: 1 } }
      },
      all: async () => {
        sqlLog.push(sql)
        if (sql.includes('FROM users')) {
          return {
            results: [
              {
                id: 'user_1',
                tenant_id: 't_1',
                display_name: 'Private Name',
                private_metadata: '{"private":"value"}',
              },
            ],
          }
        }
        return { results: [] }
      },
      first: async () =>
        options.requestExists === false ? null : { status, processingStartedAt: null },
    }
    return statement
  }
  const env = asType<Env>({
    DB: { prepare },
    STORAGE: {
      put: vi.fn(async (_key: string, value: ReadableStream<Uint8Array>) => {
        if (options.putFails) throw new Error('r2 unavailable')
        exportBody = await new Response(value).text()
      }),
      delete: vi.fn(),
    },
  })
  return {
    env,
    sqlLog,
    getStatus: () => status,
    getExportBody: () => exportBody,
    getExpiresAt: () => expiresAt,
  }
}

function makeErasureEnv(
  options: {
    blocksOwnerErasure?: boolean
    blocksInstanceManagerErasure?: boolean
  } = {},
) {
  const statements: CapturedStatement[] = []
  let status = 'pending'
  const prepare = (sql: string) => {
    let params: unknown[] = []
    const statement: CapturedStatement = {
      sql,
      params,
      run: async () => {
        if (sql.includes("SET status = 'processing'")) {
          status = 'processing'
          return asType<D1Result<unknown>>({ success: true, meta: { changes: 1 } })
        }
        return asType<D1Result<unknown>>({ success: true, meta: { changes: 1 } })
      },
      all: async <T>() => {
        const results = sql.includes('impersonator_user_id')
          ? [{ id: 'impersonated_session_1', userId: 'target_user_1' }]
          : []
        return asType<D1Result<T>>({ success: true, results, meta: {} })
      },
      first: async <T>() =>
        (sql.includes('blocksOwnerErasure') && sql.includes('blocksInstanceManagerErasure')
          ? asType<T>({
              blocksOwnerErasure: options.blocksOwnerErasure ? 1 : 0,
              blocksInstanceManagerErasure: options.blocksInstanceManagerErasure ? 1 : 0,
            })
          : asType<T>({ status, processingStartedAt: null })) as T | null,
    }
    statement.bind = (...values: unknown[]) => {
      statement.params = values
      return statement
    }
    statements.push(statement)
    return statement
  }
  const batches: CapturedStatement[][] = []
  const auditSend = vi.fn().mockResolvedValue(undefined)
  const env = asType<Env>({
    DB: {
      prepare,
      batch: async (batchStatements: CapturedStatement[]) => {
        batches.push(batchStatements)
        return batchStatements.map(() => ({ success: true, meta: { changes: 1 }, results: [] }))
      },
    },
    STORAGE: { delete: vi.fn().mockResolvedValue(undefined) },
    AUDIT_QUEUE: { send: auditSend },
  })
  return { env, statements, batches, auditSend }
}

describe('privacy Queue consumer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes a streamed R2 export, omits credential secrets, and grants exactly 48 hours', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-28T12:00:00.000Z'))
    const { env, sqlLog, getStatus, getExportBody, getExpiresAt } = makeExportEnv()
    const item = message(request('export'))

    await handlePrivacyBatch(batch(item), env)

    expect(item.ack).toHaveBeenCalledOnce()
    expect(item.retry).not.toHaveBeenCalled()
    expect(getStatus()).toBe('completed')
    expect(getExpiresAt()).toBe(Date.now() + PRIVACY_EXPORT_TTL_MS)
    expect(JSON.parse(getExportBody())).toMatchObject({
      schemaVersion: 1,
      requestId: 'prv_export',
      data: { profile: [{ display_name: 'Private Name' }] },
    })
    const selectSql = sqlLog.filter((sql) => sql.trimStart().startsWith('SELECT')).join('\n')
    expect(selectSql).not.toContain('access_token_ciphertext')
    expect(selectSql).not.toContain('refresh_token_ciphertext')
    expect(selectSql).not.toMatch(/\bhash\b/u)
    expect(selectSql).not.toContain('secret_ciphertext')
    expect(selectSql).not.toContain('refresh_token_hash')
    vi.useRealTimers()
  })

  it('acks a delayed staging-Tenant message after terminal history migrated', async () => {
    const { env, sqlLog, getExportBody } = makeExportEnv({ requestExists: false })
    const item = message({
      ...request('export'),
      tenantId: 'tenant-staging',
    })

    await handlePrivacyBatch(batch(item), env)

    expect(item.ack).toHaveBeenCalledOnce()
    expect(item.retry).not.toHaveBeenCalled()
    expect(getExportBody()).toBe('')
    expect(sqlLog.join('\n')).not.toContain('FROM users')
  })

  it('returns a failed export to pending and retries without logging or persisting payload data', async () => {
    const { env, getStatus } = makeExportEnv({ putFails: true })
    const item = message(request('export'))

    await handlePrivacyBatch(batch(item), env)

    expect(getStatus()).toBe('pending')
    expect(item.ack).not.toHaveBeenCalled()
    expect(item.retry).toHaveBeenCalledOnce()
  })

  it('revokes sessions and OAuth JWTs, erases PII transactionally, preserves audit rows, and appends completion audit', async () => {
    const { env, batches, auditSend } = makeErasureEnv()
    const item = message(request('delete'))

    await handlePrivacyBatch(batch(item), env)

    expect(sessionDoRevokeAll).toHaveBeenCalledWith(env, 'user_1')
    expect(sessionDoRevoke).toHaveBeenCalledWith(env, 'target_user_1', 'impersonated_session_1')
    expect(item.ack).toHaveBeenCalledOnce()
    expect(item.retry).not.toHaveBeenCalled()
    expect(batches).toHaveLength(1)
    const transaction = batches[0] ?? []
    const sql = transaction.map((statement) => statement.sql).join('\n')
    expect(sql).toContain('INSERT OR IGNORE INTO access_token_revocations')
    expect(sql).toContain('DELETE FROM refresh_tokens')
    expect(sql).toContain('impersonator_user_id = ?')
    expect(sql).toContain('DELETE FROM user_identities')
    expect(sql).toContain("THEN 'erased-' || lower(hex(randomblob(16))) || '@invalid.invalid'")
    expect(sql).toContain('UPDATE users')
    expect(sql).toContain("profile_completion_status = 'erased'")
    expect(sql).not.toContain('DELETE FROM audit_events')
    expect(sql.indexOf('INSERT OR IGNORE INTO access_token_revocations')).toBeLessThan(
      sql.indexOf('DELETE FROM access_token_issuances'),
    )
    expect(transaction.at(-1)?.sql).toContain('INSERT INTO platform_audit_outbox')
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't_1',
        action: 'user.erasure_completed',
        payload: expect.objectContaining({
          targetType: 'user',
          targetId: 'user_1',
        }),
      }),
    )
  })

  it('releases and retries an erasure when the user became the sole owner during the grace period', async () => {
    const { env, batches } = makeErasureEnv({ blocksOwnerErasure: true })
    const item = message(request('delete'))

    await handlePrivacyBatch(batch(item), env)

    expect(sessionDoRevokeAll).not.toHaveBeenCalled()
    expect(sessionDoRevoke).not.toHaveBeenCalled()
    expect(batches).toHaveLength(0)
    expect(item.ack).not.toHaveBeenCalled()
    expect(item.retry).toHaveBeenCalledOnce()
  })
})
