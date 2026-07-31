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
