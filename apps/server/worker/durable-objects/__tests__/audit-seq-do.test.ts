import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    protected ctx: DurableObjectState
    protected env: Env

    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

import { AUDIT_PENDING_STALE_MS } from '../../lib/ttl'
import { AuditSeqDO } from '../audit-seq-do'

type StoredEvent = {
  seq: number
  id: string
  hash: string
}

type TestStorage = Map<string, unknown>

type TestDatabase = {
  events: Map<string, StoredEvent>
  deadLetters: Set<string>
  deadLetterReasons: Map<string, string>
  failNextEventInsert: boolean
  failAfterNextEventInsert: boolean
}

function sourceKey(tenantId: unknown, sourceMessageId: unknown): string {
  return `${String(tenantId)}:${String(sourceMessageId)}`
}

function makeState(storage: TestStorage): DurableObjectState {
  const durableStorage = {
    get: async <T>(key: string): Promise<T | undefined> => storage.get(key) as T | undefined,
    put: async (key: string | Record<string, unknown>, value?: unknown): Promise<void> => {
      if (typeof key === 'string') {
        storage.set(key, value)
        return
      }
      for (const [entryKey, entryValue] of Object.entries(key)) storage.set(entryKey, entryValue)
    },
    delete: async (key: string): Promise<number> => (storage.delete(key) ? 1 : 0),
  }
  return {
    storage: durableStorage,
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>): Promise<T> => callback(),
  } as unknown as DurableObjectState
}

function makeDatabase(database: TestDatabase): D1Database {
  return {
    prepare: (query: string) => ({
      bind: (...args: Array<unknown>) => ({
        run: async () => {
          if (query.includes('INSERT OR IGNORE INTO audit_events')) {
            if (database.failNextEventInsert) {
              database.failNextEventInsert = false
              throw new Error('d1 unavailable')
            }
            const key = sourceKey(args[3], args[2])
            if (!database.events.has(key)) {
              database.events.set(key, {
                seq: Number(args[0]),
                id: String(args[1]),
                hash: String(args[13]),
              })
            }
            if (database.failAfterNextEventInsert) {
              database.failAfterNextEventInsert = false
              throw new Error('d1 response lost')
            }
            return { meta: { changes: 1 } }
          }
          if (query.includes('INSERT OR IGNORE INTO audit_dead_letters')) {
            const key = sourceKey(args[3], args[2])
            if (!database.deadLetters.has(key)) {
              database.deadLetters.add(key)
              database.deadLetterReasons.set(key, String(args[4]))
            }
            return { meta: { changes: 1 } }
          }
          throw new Error(`unexpected run query: ${query}`)
        },
        first: async <T>() => {
          if (query.includes('FROM audit_events WHERE tenant_id = ? AND source_message_id = ?')) {
            return (database.events.get(sourceKey(args[0], args[1])) ?? null) as T | null
          }
          if (query.includes('FROM audit_events WHERE tenant_id = ? ORDER BY seq DESC')) {
            const tenantPrefix = `${String(args[0])}:`
            const latest = [...database.events.entries()]
              .filter(([key]) => key.startsWith(tenantPrefix))
              .map(([, event]) => event)
              .sort((left, right) => right.seq - left.seq)[0]
            return (latest ?? null) as T | null
          }
          if (query.includes('FROM audit_dead_letters')) {
            return (
              database.deadLetters.has(sourceKey(args[0], args[1])) ? { found: 1 } : null
            ) as T | null
          }
          throw new Error(`unexpected first query: ${query}`)
        },
      }),
    }),
  } as unknown as D1Database
}

function makeAuditInput(sourceMessageId: string) {
  return {
    sourceMessageId,
    fields: {
      tenantId: 'tenant-1',
      orgId: undefined,
      eventType: 'session.created',
      actorId: 'user-1',
      actorIp: undefined,
      targetType: undefined,
      targetId: undefined,
      meta: { source: 'test' },
      occurredAt: '2026-07-13T00:00:00.000Z',
    },
  }
}

function makeAuditSeqDO(storage: TestStorage, database: TestDatabase): AuditSeqDO {
  return new AuditSeqDO(makeState(storage), { DB: makeDatabase(database) } as unknown as Env)
}

describe('AuditSeqDO', () => {
  let storage: TestStorage
  let database: TestDatabase

  beforeEach(() => {
    storage = new Map()
    database = {
      events: new Map(),
      deadLetters: new Set(),
      deadLetterReasons: new Map(),
      failNextEventInsert: false,
      failAfterNextEventInsert: false,
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('D1 写入失败不会推进 seq，后序 source 被阻塞', async () => {
    const do_ = makeAuditSeqDO(storage, database)
    database.failNextEventInsert = true

    await expect(do_.append(makeAuditInput('A'))).rejects.toThrow('d1 unavailable')
    await expect(do_.append(makeAuditInput('B'))).resolves.toEqual({ status: 'blocked' })
    await expect(do_.append(makeAuditInput('A'))).resolves.toEqual({ status: 'appended' })
    await expect(do_.append(makeAuditInput('B'))).resolves.toEqual({ status: 'appended' })

    expect(database.events.get('tenant-1:A')?.seq).toBe(1)
    expect(database.events.get('tenant-1:B')?.seq).toBe(2)
  })

  it('重复 source 恢复已提交事件且不会重复写入', async () => {
    const do_ = makeAuditSeqDO(storage, database)

    await expect(do_.append(makeAuditInput('A'))).resolves.toEqual({ status: 'appended' })
    await expect(do_.append(makeAuditInput('A'))).resolves.toEqual({ status: 'appended' })

    expect(database.events).toHaveLength(1)
    expect(database.events.get('tenant-1:A')?.seq).toBe(1)
  })

  it('重启后从 D1 最新事件继续，不会重用已提交 seq', async () => {
    const first = makeAuditSeqDO(storage, database)
    await expect(first.append(makeAuditInput('A'))).resolves.toEqual({ status: 'appended' })

    const restarted = makeAuditSeqDO(new Map(), database)
    await expect(restarted.append(makeAuditInput('B'))).resolves.toEqual({ status: 'appended' })

    expect(database.events.get('tenant-1:B')?.seq).toBe(2)
  })

  it('终态死信释放未提交位置，后续 source 从同一 seq 提交', async () => {
    const do_ = makeAuditSeqDO(storage, database)
    database.failNextEventInsert = true

    await expect(do_.append(makeAuditInput('A'))).rejects.toThrow('d1 unavailable')
    await expect(
      do_.terminalize({
        sourceMessageId: 'A',
        messageId: 'queue-A',
        tenantId: 'tenant-1',
        attempts: 5,
        body: { type: 'audit' },
      }),
    ).resolves.toEqual({ status: 'terminal' })
    await expect(do_.append(makeAuditInput('B'))).resolves.toEqual({ status: 'appended' })

    expect(database.deadLetters.has('tenant-1:A')).toBe(true)
    expect(database.events.get('tenant-1:B')?.seq).toBe(1)
  })

  it('后序 source 不可替前序消息进入终态', async () => {
    const do_ = makeAuditSeqDO(storage, database)
    database.failNextEventInsert = true

    await expect(do_.append(makeAuditInput('A'))).rejects.toThrow('d1 unavailable')
    await expect(
      do_.terminalize({
        sourceMessageId: 'B',
        messageId: 'queue-B',
        tenantId: 'tenant-1',
        attempts: 5,
        body: { type: 'audit' },
      }),
    ).resolves.toEqual({ status: 'blocked' })
  })

  it('已进入终态的 source 保持终态，不再占用后续提交', async () => {
    const do_ = makeAuditSeqDO(storage, database)
    database.deadLetters.add('tenant-1:A')

    await expect(do_.append(makeAuditInput('A'))).resolves.toEqual({ status: 'terminal' })
    await expect(do_.append(makeAuditInput('B'))).resolves.toEqual({ status: 'appended' })

    expect(database.events.get('tenant-1:B')?.seq).toBe(1)
  })

  it('前序待提交未超过过期窗口时后序仍被阻塞', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const do_ = makeAuditSeqDO(storage, database)
    database.failNextEventInsert = true
    await expect(do_.append(makeAuditInput('A'))).rejects.toThrow('d1 unavailable')

    vi.setSystemTime(1_000_000 + AUDIT_PENDING_STALE_MS - 1)
    const result = await do_.append(makeAuditInput('B'))

    expect(result).toEqual({ status: 'blocked' })
    expect(database.deadLetters.size).toBe(0)
  })

  it('前序待提交超过过期窗口后转入审计死信，后序复用同一 seq 继续链', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const do_ = makeAuditSeqDO(storage, database)
    database.failNextEventInsert = true
    await expect(do_.append(makeAuditInput('A'))).rejects.toThrow('d1 unavailable')

    vi.setSystemTime(1_000_000 + AUDIT_PENDING_STALE_MS)
    const result = await do_.append(makeAuditInput('B'))

    expect(result).toEqual({ status: 'appended' })
    expect(database.deadLetterReasons.get('tenant-1:A')).toBe('pending_expired')
    expect(database.events.has('tenant-1:A')).toBe(false)
    expect(database.events.get('tenant-1:B')?.seq).toBe(1)
    expect(storage.has('pending')).toBe(false)
  })

  it('过期前序被释放后，其重放保持终态且不会写入重复事件', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const do_ = makeAuditSeqDO(storage, database)
    database.failNextEventInsert = true
    await expect(do_.append(makeAuditInput('A'))).rejects.toThrow('d1 unavailable')
    vi.setSystemTime(1_000_000 + AUDIT_PENDING_STALE_MS)
    await expect(do_.append(makeAuditInput('B'))).resolves.toEqual({ status: 'appended' })

    const replay = await do_.append(makeAuditInput('A'))

    expect(replay).toEqual({ status: 'terminal' })
    expect(database.events.has('tenant-1:A')).toBe(false)
    await expect(do_.append(makeAuditInput('C'))).resolves.toEqual({ status: 'appended' })
    expect(database.events.get('tenant-1:C')?.seq).toBe(2)
  })

  it('重试推进最后尝试时间，仍在重试的前序不会被过期释放', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const do_ = makeAuditSeqDO(storage, database)
    database.failNextEventInsert = true
    await expect(do_.append(makeAuditInput('A'))).rejects.toThrow('d1 unavailable')
    vi.setSystemTime(1_000_000 + AUDIT_PENDING_STALE_MS - 1)
    database.failNextEventInsert = true
    await expect(do_.append(makeAuditInput('A'))).rejects.toThrow('d1 unavailable')

    vi.setSystemTime(1_000_000 + AUDIT_PENDING_STALE_MS + 1)
    const result = await do_.append(makeAuditInput('B'))

    expect(result).toEqual({ status: 'blocked' })
    expect(database.deadLetters.size).toBe(0)
  })

  it('前序已落库但未确认时，后序先补提交前序再继续，不重复也不跳号', async () => {
    const do_ = makeAuditSeqDO(storage, database)
    database.failAfterNextEventInsert = true
    await expect(do_.append(makeAuditInput('A'))).rejects.toThrow('d1 response lost')

    const result = await do_.append(makeAuditInput('B'))

    expect(result).toEqual({ status: 'appended' })
    expect(database.events.get('tenant-1:A')?.seq).toBe(1)
    expect(database.events.get('tenant-1:B')?.seq).toBe(2)
    expect(database.deadLetters.size).toBe(0)
  })

  it('前序已有终态死信时，后序释放其待提交位置并复用同一 seq', async () => {
    const do_ = makeAuditSeqDO(storage, database)
    database.failNextEventInsert = true
    await expect(do_.append(makeAuditInput('A'))).rejects.toThrow('d1 unavailable')
    database.deadLetters.add('tenant-1:A')

    const result = await do_.append(makeAuditInput('B'))

    expect(result).toEqual({ status: 'appended' })
    expect(database.events.get('tenant-1:B')?.seq).toBe(1)
  })

  it('缺少最后尝试时间的存量待提交先记录时间并阻塞，不立即过期', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const first = makeAuditSeqDO(storage, database)
    database.failNextEventInsert = true
    await expect(first.append(makeAuditInput('A'))).rejects.toThrow('d1 unavailable')
    const { attemptedAt: _attemptedAt, ...legacyPending } = storage.get('pending') as {
      attemptedAt: number
    }
    storage.set('pending', legacyPending)
    vi.setSystemTime(1_000_000 + AUDIT_PENDING_STALE_MS * 2)
    const restarted = makeAuditSeqDO(storage, database)

    const result = await restarted.append(makeAuditInput('B'))

    expect(result).toEqual({ status: 'blocked' })
    expect((storage.get('pending') as { attemptedAt: number }).attemptedAt).toBe(
      1_000_000 + AUDIT_PENDING_STALE_MS * 2,
    )
  })

  it('过期前序释放后，后序的终态化不再被阻塞', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const do_ = makeAuditSeqDO(storage, database)
    database.failNextEventInsert = true
    await expect(do_.append(makeAuditInput('A'))).rejects.toThrow('d1 unavailable')
    vi.setSystemTime(1_000_000 + AUDIT_PENDING_STALE_MS)

    const result = await do_.terminalize({
      sourceMessageId: 'B',
      messageId: 'queue-B',
      tenantId: 'tenant-1',
      attempts: 5,
      body: { type: 'audit' },
    })

    expect(result).toEqual({ status: 'terminal' })
    expect(database.deadLetterReasons.get('tenant-1:A')).toBe('pending_expired')
    expect(database.deadLetterReasons.get('tenant-1:B')).toBe('max_attempts')
  })
})
