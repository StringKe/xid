// SessionDO 单元测试
// 验证:addSession/revokeSession/revokeAll/listActive/isActive 语义
// 以及 DO 串行保证(sequential calls on same instance share state)

import { afterEach, describe, it, expect, vi } from 'vitest'
import { SessionDO } from '../session-do'

const HOUR_MS = 3600_000

function future(): number {
  return Date.now() + HOUR_MS
}

// 最小 DurableObjectStorage mock
function makeMockStorage(): DurableObjectStorage {
  const store = new Map<string, unknown>()

  return {
    get: async <T>(key: string) => store.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      store.set(key, value)
    },
    delete: async (key: string) => store.delete(key),
    list: async () => new Map(),
    deleteAll: async () => {
      store.clear()
    },
    getAlarm: async () => null,
    setAlarm: async () => {},
    deleteAlarm: async () => {},
    sync: async () => {},
    transaction: async (closure: (txn: DurableObjectTransaction) => Promise<void>) => {
      await closure({} as DurableObjectTransaction)
    },
    sql: {} as SqlStorage,
    getCurrentBookmark: () => {
      throw new Error('not implemented')
    },
    getBookmarkForTime: async () => {
      throw new Error('not implemented')
    },
    onNextSessionRestoreBookmark: () => {},
  } as unknown as DurableObjectStorage
}

function makeDO(): SessionDO {
  const state = { storage: makeMockStorage() } as unknown as DurableObjectState
  return new SessionDO(state)
}

describe('SessionDO: addSession', () => {
  it('adds a session and isActive returns true', async () => {
    const do_ = makeDO()
    await do_.addSession('sess-001', future())
    expect(await do_.isActive('sess-001')).toBe(true)
  })

  it('adding same session twice is idempotent (set semantics)', async () => {
    const do_ = makeDO()
    await do_.addSession('sess-001', future())
    await do_.addSession('sess-001', future())
    const list = await do_.listActive()
    expect(list).toHaveLength(1)
  })

  it('rejects an add from the generation before revokeAll', async () => {
    const do_ = makeDO()
    const generation = await do_.currentGeneration()
    await do_.revokeAll()

    const result = await do_.addSession('sess-stale', future(), generation)

    expect(result).toEqual({ ok: true, value: { accepted: false } })
    expect(await do_.isActive('sess-stale')).toBe(false)
  })

  it('multiple sessions are tracked independently', async () => {
    const do_ = makeDO()
    await do_.addSession('sess-001', future())
    await do_.addSession('sess-002', future())
    await do_.addSession('sess-003', future())

    expect(await do_.isActive('sess-001')).toBe(true)
    expect(await do_.isActive('sess-002')).toBe(true)
    expect(await do_.isActive('sess-003')).toBe(true)

    const list = await do_.listActive()
    expect(list).toHaveLength(3)
  })
})

describe('SessionDO: revokeSession', () => {
  it('revoked session is no longer active', async () => {
    const do_ = makeDO()
    await do_.addSession('sess-001', future())
    await do_.revokeSession('sess-001')
    expect(await do_.isActive('sess-001')).toBe(false)
  })

  it('revokeSession returns revoked=true when session existed', async () => {
    const do_ = makeDO()
    await do_.addSession('sess-001', future())
    const result = await do_.revokeSession('sess-001')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.revoked).toBe(true)
    }
  })

  it('revokeSession returns revoked=false for non-existent session', async () => {
    const do_ = makeDO()
    const result = await do_.revokeSession('non-existent')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.revoked).toBe(false)
    }
  })

  it('revoking one session does not affect others', async () => {
    const do_ = makeDO()
    await do_.addSession('sess-001', future())
    await do_.addSession('sess-002', future())
    await do_.revokeSession('sess-001')

    expect(await do_.isActive('sess-001')).toBe(false)
    expect(await do_.isActive('sess-002')).toBe(true)
  })
})

describe('SessionDO: revokeAll', () => {
  it('revokeAll clears all sessions', async () => {
    const do_ = makeDO()
    await do_.addSession('sess-001', future())
    await do_.addSession('sess-002', future())
    await do_.addSession('sess-003', future())

    const result = await do_.revokeAll()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.count).toBe(3)
    }

    const list = await do_.listActive()
    expect(list).toHaveLength(0)
  })

  it('revokeAll on empty set returns count=0', async () => {
    const do_ = makeDO()
    const result = await do_.revokeAll()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.count).toBe(0)
    }
  })

  it('increments generation so a later issuance can use the new epoch', async () => {
    const do_ = makeDO()
    const before = await do_.currentGeneration()
    await do_.revokeAll()

    const result = await do_.addSession('sess-new', future(), await do_.currentGeneration())

    expect(await do_.currentGeneration()).toBe(before + 1)
    expect(result).toEqual({ ok: true, value: { accepted: true } })
    expect(await do_.isActive('sess-new')).toBe(true)
  })

  it('isActive returns false for all sessions after revokeAll', async () => {
    const do_ = makeDO()
    await do_.addSession('sess-001', future())
    await do_.addSession('sess-002', future())
    await do_.revokeAll()

    expect(await do_.isActive('sess-001')).toBe(false)
    expect(await do_.isActive('sess-002')).toBe(false)
  })
})

describe('SessionDO: listActive', () => {
  it('returns empty array when no sessions', async () => {
    const do_ = makeDO()
    const list = await do_.listActive()
    expect(list).toEqual([])
  })

  it('returns all active session ids', async () => {
    const do_ = makeDO()
    await do_.addSession('sess-a', future())
    await do_.addSession('sess-b', future())
    const list = await do_.listActive()
    expect(list.sort()).toEqual(['sess-a', 'sess-b'].sort())
  })
})

describe('SessionDO: revokeAllExcept', () => {
  it('keeps the current session and increments the generation', async () => {
    const do_ = makeDO()
    await do_.addSession('sess-current', future())
    await do_.addSession('sess-other-1', future())
    await do_.addSession('sess-other-2', future())

    const before = await do_.currentGeneration()
    const result = await do_.revokeAllExcept('sess-current')

    expect(result).toEqual({ ok: true, value: { count: 2 } })
    expect(await do_.currentGeneration()).toBe(before + 1)
    expect(await do_.isActive('sess-current')).toBe(true)
    expect(await do_.isActive('sess-other-1')).toBe(false)
    expect(await do_.isActive('sess-other-2')).toBe(false)
  })
})

describe('SessionDO: isActive (quasi-realtime)', () => {
  it('returns false for unknown session', async () => {
    const do_ = makeDO()
    expect(await do_.isActive('unknown')).toBe(false)
  })

  it('reflects revocation immediately in same instance', async () => {
    const do_ = makeDO()
    await do_.addSession('sess-001', future())
    expect(await do_.isActive('sess-001')).toBe(true)

    await do_.revokeSession('sess-001')
    // 同实例内存缓存立即更新,无需额外 storage 往返
    expect(await do_.isActive('sess-001')).toBe(false)
  })
})

describe('SessionDO: serial operation guarantee (same DO instance)', () => {
  // 真实 DO 的 fetch 由运行时串行调度,此处验证顺序(awaited)调用的正确状态转换。
  // Note: Promise.all 在 Node/Vitest 中会暴露实现的竞态,真实 DO 不存在此问题(单线程串行)。
  it('sequential awaited ops produce consistent state', async () => {
    const do_ = makeDO()

    await do_.addSession('s1', future())
    await do_.addSession('s2', future())
    await do_.addSession('s3', future())

    const list = await do_.listActive()
    expect(list).toHaveLength(3)
  })

  it('add then revoke sequence is consistent', async () => {
    const do_ = makeDO()
    await do_.addSession('s1', future())
    await do_.addSession('s2', future())
    await do_.revokeSession('s1')
    await do_.addSession('s3', future())

    const list = await do_.listActive()
    expect(list.sort()).toEqual(['s2', 's3'].sort())
    expect(await do_.isActive('s1')).toBe(false)
  })
})

describe('SessionDO: persistence across storage reads', () => {
  it('sessions persisted to storage survive cache reinit', async () => {
    // 用相同 storage 创建两个 DO 实例,模拟重启/新 isolate
    const storage = makeMockStorage()
    const state1 = { storage } as unknown as DurableObjectState
    const do1 = new SessionDO(state1)

    await do1.addSession('sess-persistent', future())

    // 新实例复用相同 storage
    const state2 = { storage } as unknown as DurableObjectState
    const do2 = new SessionDO(state2)

    expect(await do2.isActive('sess-persistent')).toBe(true)
  })
})

describe('SessionDO: expiry pruning', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('treats a session past its expiresAt as inactive', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const do_ = makeDO()
    await do_.addSession('sess-short', Date.now() + HOUR_MS)

    vi.setSystemTime(Date.now() + HOUR_MS + 1)

    expect(await do_.isActive('sess-short')).toBe(false)
    expect(await do_.listActive()).toEqual([])
  })

  it('drops expired entries from storage on the next add', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const storage = makeMockStorage()
    const do_ = new SessionDO({ storage } as unknown as DurableObjectState)
    await do_.addSession('sess-old-1', Date.now() + HOUR_MS)
    await do_.addSession('sess-old-2', Date.now() + HOUR_MS)
    vi.setSystemTime(Date.now() + 2 * HOUR_MS)

    await do_.addSession('sess-new', Date.now() + HOUR_MS)

    expect(await storage.get('sessions')).toEqual({ 'sess-new': Date.now() + HOUR_MS })
  })

  it('keeps a legacy array entry active and stores it with a bounded expiry', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const storage = makeMockStorage()
    await storage.put('sessions', ['sess-legacy'])
    const do_ = new SessionDO({ storage } as unknown as DurableObjectState)

    await do_.addSession('sess-new', Date.now() + HOUR_MS)

    expect(await do_.isActive('sess-legacy')).toBe(true)
    const stored = (await storage.get('sessions')) as Record<string, number>
    expect(stored['sess-legacy']).toBe(Date.now() + 365 * 24 * HOUR_MS)
  })

  it('rejects an add request without a numeric expiresAt', async () => {
    const do_ = makeDO()

    const response = await do_.fetch(
      new Request('https://session-do/add', {
        method: 'POST',
        body: JSON.stringify({ sessionId: 'sess-no-expiry', expectedGeneration: 0 }),
      }),
    )

    expect(response.status).toBe(400)
    expect(await do_.isActive('sess-no-expiry')).toBe(false)
  })
})
