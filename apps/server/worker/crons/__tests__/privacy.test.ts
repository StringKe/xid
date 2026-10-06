import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { enqueueDuePrivacyRequests, expirePrivacyExports } from '../privacy'

function asType<T>(value: unknown): T {
  return value as T
}

describe('daily privacy recovery', () => {
  it('enqueues due deletes, pending exports, and stale leases with identifier-only messages', async () => {
    const now = Date.parse('2026-07-28T00:00:00.000Z')
    let reads = 0
    const send = vi.fn().mockResolvedValue(undefined)
    const env = asType<Env>({
      DB: {
        prepare: (sql: string) => ({
          bind: (..._params: unknown[]) => ({
            all: async () => {
              if (!sql.includes('FROM privacy_requests') || reads++ > 0) return { results: [] }
              return {
                results: [
                  {
                    id: 'prv_export',
                    tenantId: 't_1',
                    userId: 'user_1',
                    requestType: 'export',
                    createdAt: now - 1_000,
                  },
                  {
                    id: 'prv_delete',
                    tenantId: 't_1',
                    userId: 'user_1',
                    requestType: 'delete',
                    createdAt: now - 30 * 24 * 60 * 60 * 1000,
                  },
                ],
              }
            },
          }),
        }),
      },
      PRIVACY_QUEUE: { send },
    })

    await enqueueDuePrivacyRequests(env, now)

    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenNthCalledWith(1, {
      requestId: 'prv_export',
      tenantId: 't_1',
      userId: 'user_1',
      operation: 'export',
      requestedAt: now - 1_000,
    })
    expect(JSON.stringify(send.mock.calls)).not.toContain('@')
  })

  it('stops redelivering requests that stay unfinished past the redelivery window', async () => {
    const now = Date.parse('2026-07-28T00:00:00.000Z')
    const day = 24 * 60 * 60 * 1000
    const database = new DatabaseSync(':memory:')
    database.exec(`
      CREATE TABLE privacy_requests (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        request_type TEXT NOT NULL,
        status TEXT NOT NULL,
        scheduled_for INTEGER,
        processing_started_at INTEGER,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    const insert = database.prepare(
      `INSERT INTO privacy_requests
         (id, tenant_id, user_id, request_type, status, scheduled_for, processing_started_at,
          error_code, created_at, updated_at)
       VALUES (?, 't_1', 'user_1', ?, ?, ?, ?, ?, ?, ?)`,
    )
    insert.run('prv_a_fresh_export', 'export', 'pending', null, null, null, now - day, now - day)
    insert.run(
      'prv_b_old_export',
      'export',
      'pending',
      null,
      null,
      'privacy_export_failed',
      now - 8 * day,
      now - day,
    )
    insert.run(
      'prv_c_old_delete',
      'delete',
      'processing',
      now - 8 * day,
      now - day,
      null,
      now - 38 * day,
      now - day,
    )
    insert.run(
      'prv_e_old_unattempted_export',
      'export',
      'pending',
      null,
      null,
      'privacy_queue_send_failed',
      now - 8 * day,
      now - day,
    )
    insert.run(
      'prv_d_exhausted',
      'export',
      'pending',
      null,
      null,
      'privacy_retries_exhausted',
      now - 9 * day,
      now - day,
    )
    const send = vi.fn().mockResolvedValue(undefined)
    const env = asType<Env>({
      DB: {
        prepare: (sql: string) => ({
          bind: (...params: unknown[]) => ({
            all: async () => ({
              results: database.prepare(sql).all(...(params as SQLInputValue[])),
            }),
            run: async () => {
              const result = database.prepare(sql).run(...(params as SQLInputValue[]))
              return { success: true, meta: { changes: Number(result.changes) } }
            },
          }),
        }),
      },
      PRIVACY_QUEUE: { send },
    })

    await enqueueDuePrivacyRequests(env, now)

    expect(send.mock.calls.map(([message]) => message.requestId)).toEqual([
      'prv_a_fresh_export',
      'prv_e_old_unattempted_export',
    ])
    expect(
      database
        .prepare(
          `SELECT id, status, processing_started_at AS processingStartedAt, error_code AS errorCode
             FROM privacy_requests WHERE id IN ('prv_b_old_export', 'prv_c_old_delete') ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        id: 'prv_b_old_export',
        status: 'pending',
        processingStartedAt: null,
        errorCode: 'privacy_retries_exhausted',
      },
      {
        id: 'prv_c_old_delete',
        status: 'pending',
        processingStartedAt: null,
        errorCode: 'privacy_retries_exhausted',
      },
    ])
    database.close()
  })

  it('deletes expired export objects before removing their storage reference', async () => {
    const now = Date.parse('2026-07-28T00:00:00.000Z')
    let reads = 0
    const calls: string[] = []
    const storageDelete = vi.fn(async () => {
      calls.push('r2-delete')
    })
    const env = asType<Env>({
      DB: {
        prepare: (sql: string) => ({
          bind: (..._params: unknown[]) => ({
            all: async () => {
              if (reads++ > 0) return { results: [] }
              return {
                results: [
                  {
                    id: 'prv_export',
                    tenantId: 't_1',
                    userId: 'user_1',
                    storageKey: 'privacy-exports/t_1/user_1/prv_export.json',
                  },
                ],
              }
            },
            run: async () => {
              calls.push(sql)
              return { success: true, meta: { changes: 1 } }
            },
          }),
        }),
      },
      STORAGE: { delete: storageDelete },
    })

    await expirePrivacyExports(env, now)

    expect(storageDelete).toHaveBeenCalledWith('privacy-exports/t_1/user_1/prv_export.json')
    expect(calls[0]).toBe('r2-delete')
    expect(calls[1]).toContain("SET status = 'expired'")
  })
})
