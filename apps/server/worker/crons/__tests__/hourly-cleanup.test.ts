// hourly cron 单元测试:过期 session/denylist 清理、DAU 兜底、runHourly 编排。
import { describe, expect, it, vi } from 'vitest'
import {
  aggregateDau,
  cleanupExpiredAccessTokenRevocations,
  cleanupExpiredAuthCodes,
  cleanupExpiredChallenges,
  cleanupExpiredSessions,
  hardDeleteExpiredSessions,
  redeliverMeteringOutbox,
  runHourly,
} from '../hourly'

type D1Run = ReturnType<typeof vi.fn>

function makeD1(
  run: D1Run,
  options: {
    tenants?: Array<{ tenant_id: string }>
    meteringOutbox?: Array<{ id: string; tenantId: string; userId: string; occurredAt: number }>
  } = {},
): D1Database {
  const batches: unknown[][] = []
  const prepare = vi.fn((sql: string) => {
    let bound: unknown[] = []
    const all = async () => {
      if (sql.includes('FROM metering_outbox')) {
        return { results: options.meteringOutbox ?? [] }
      }
      if (!sql.includes('FROM organizations') || !options.tenants) return { results: [] }
      const cursor = typeof bound[0] === 'string' ? bound[0] : null
      const pageSize = typeof bound[2] === 'number' ? bound[2] : options.tenants.length
      return {
        results: options.tenants
          .filter((row) => cursor === null || row.tenant_id > cursor)
          .slice(0, pageSize),
      }
    }
    const statement = {
      bind: (...args: unknown[]) => {
        bound = args
        return statement
      },
      run,
      first: async () => null,
      all,
    }
    return statement
  })
  return {
    prepare,
    batch: async (statements: unknown[]) => {
      batches.push(statements)
      return []
    },
    __batches: batches,
  } as unknown as D1Database & { __batches: unknown[][] }
}

describe('hardDeleteExpiredSessions', () => {
  it('deletes sessions past expires_at', async () => {
    const run = vi.fn().mockResolvedValue({ success: true })
    const env = { DB: makeD1(run) } as unknown as Env
    const now = 1_700_000_000_000
    await hardDeleteExpiredSessions(env, now)
    expect(run).toHaveBeenCalled()
    expect(env.DB.prepare).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM sessions WHERE expires_at'),
    )
  })
})

describe('cleanupExpiredSessions', () => {
  it('delegates to hard delete path', async () => {
    const run = vi.fn().mockResolvedValue({ success: true })
    const env = { DB: makeD1(run) } as unknown as Env
    await cleanupExpiredSessions(env)
    expect(run).toHaveBeenCalled()
  })
})

describe('cleanupExpiredAccessTokenRevocations', () => {
  it('deletes expired denylist rows when table exists', async () => {
    const run = vi.fn().mockResolvedValue({ success: true })
    const env = { DB: makeD1(run) } as unknown as Env
    await cleanupExpiredAccessTokenRevocations(env, 1_700_000_000_000)
    expect(env.DB.prepare).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM access_token_revocations'),
    )
  })

  it('swallows missing-table error until migration applied', async () => {
    const run = vi.fn().mockRejectedValue(new Error('no such table: access_token_revocations'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const env = { DB: makeD1(run) } as unknown as Env
    await expect(cleanupExpiredAccessTokenRevocations(env)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('rethrows unexpected database errors', async () => {
    const run = vi.fn().mockRejectedValue(new Error('disk I/O error'))
    const env = { DB: makeD1(run) } as unknown as Env
    await expect(cleanupExpiredAccessTokenRevocations(env)).rejects.toThrow('disk I/O error')
  })
})

describe('cleanupExpiredAuthCodes', () => {
  // 内存版 D1:把 DELETE 真正应用到 rows,用于断言"只删过期行"。
  function makeAuthCodesD1(rows: Array<{ code: string; expires_at: number }>): D1Database {
    const prepare = vi.fn((sql: string) => {
      let bound: unknown[] = []
      const statement = {
        bind: (...args: unknown[]) => {
          bound = args
          return statement
        },
        run: async () => {
          if (sql.includes('DELETE FROM authorization_codes')) {
            const now = Number(bound[0])
            const kept = rows.filter((row) => row.expires_at >= now)
            rows.length = 0
            rows.push(...kept)
          }
          return { success: true }
        },
        first: async () => null,
        all: async () => ({ results: [] }),
      }
      return statement
    })
    return { prepare } as unknown as D1Database
  }

  it('deletes expired authorization codes and keeps unexpired ones', async () => {
    const now = 1_700_000_000_000
    const rows = [
      { code: 'ac_expired', expires_at: now - 1 },
      { code: 'ac_fresh', expires_at: now + 60_000 },
    ]
    const env = { DB: makeAuthCodesD1(rows) } as unknown as Env

    await cleanupExpiredAuthCodes(env, now)

    expect(rows.map((row) => row.code)).toEqual(['ac_fresh'])
    expect(env.DB.prepare).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM authorization_codes WHERE expires_at'),
    )
  })
})

describe('cleanupExpiredChallenges', () => {
  it('is a no-op while challenge/state TTL is owned by Durable Objects', async () => {
    await expect(cleanupExpiredChallenges({} as Env)).resolves.toBeUndefined()
  })
})

describe('aggregateDau', () => {
  it('skips batch insert when no active root organizations exist', async () => {
    const run = vi.fn().mockResolvedValue({ success: true })
    const db = makeD1(run)
    await aggregateDau({ DB: db } as unknown as Env)
    expect((db as D1Database & { __batches: unknown[][] }).__batches).toHaveLength(0)
  })

  it('batch upserts usage_daily rows for active root tenants', async () => {
    const run = vi.fn().mockResolvedValue({ success: true })
    const db = makeD1(run, { tenants: [{ tenant_id: 'org_a' }, { tenant_id: 'org_b' }] })
    await aggregateDau({ DB: db } as unknown as Env)
    const batches = (db as D1Database & { __batches: unknown[][] }).__batches
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(2)
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO usage_daily'))
  })

  it('paginates beyond 100 active root tenants without omitting the second page', async () => {
    const run = vi.fn().mockResolvedValue({ success: true })
    const tenants = Array.from({ length: 101 }, (_, index) => ({
      tenant_id: `org_${String(index).padStart(3, '0')}`,
    }))
    const db = makeD1(run, { tenants })

    await aggregateDau({ DB: db } as unknown as Env)

    const batches = (db as D1Database & { __batches: unknown[][] }).__batches
    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(100)
    expect(batches[1]).toHaveLength(1)
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('ORDER BY id ASC'))
  })
})

describe('redeliverMeteringOutbox', () => {
  it('requeues a pending event then marks it delivered', async () => {
    const run = vi.fn().mockResolvedValue({ success: true })
    const db = makeD1(run, {
      meteringOutbox: [
        { id: 'met_1', tenantId: 'tenant_1', userId: 'user_1', occurredAt: Date.UTC(2025, 0, 15) },
      ],
    })
    const send = vi.fn().mockResolvedValue(undefined)

    await redeliverMeteringOutbox({ DB: db, METERING_QUEUE: { send } } as unknown as Env)

    expect(send).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      userId: 'user_1',
      ts: Date.UTC(2025, 0, 15),
    })
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('SET delivered_at = ?'))
  })

  it('keeps the event pending when the retry queue send fails', async () => {
    const run = vi.fn().mockResolvedValue({ success: true })
    const db = makeD1(run, {
      meteringOutbox: [
        { id: 'met_1', tenantId: 'tenant_1', userId: 'user_1', occurredAt: Date.UTC(2025, 0, 15) },
      ],
    })
    const send = vi.fn().mockRejectedValue(new Error('queue unavailable'))

    await redeliverMeteringOutbox({ DB: db, METERING_QUEUE: { send } } as unknown as Env)

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('last_error_code = ?'))
    expect(db.prepare).not.toHaveBeenCalledWith(expect.stringContaining('SET delivered_at = ?'))
  })
})

describe('runHourly', () => {
  it('orchestrates session, denylist, and auth code cleanup plus DAU aggregation', async () => {
    const run = vi.fn().mockResolvedValue({ success: true })
    const db = makeD1(run, { tenants: [{ tenant_id: 'org_hourly' }] })
    await runHourly({ DB: db } as unknown as Env)

    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM sessions WHERE expires_at'),
    )
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM access_token_revocations'),
    )
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM authorization_codes WHERE expires_at'),
    )
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('FROM organizations'))
    expect((db as D1Database & { __batches: unknown[][] }).__batches).toHaveLength(1)
  })
})
