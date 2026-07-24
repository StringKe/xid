// RateLimitStore 单元测试
// 验证:阈值触发、指数退避阶梯、IP 锁定、OTP 限流、reset 清除计数
// mock DurableObjectStorage 用 Map 实现最小接口,不依赖 Workers runtime。

import { describe, it, expect } from 'vitest'
import { RateLimitStore, POLICIES } from '../rate-limit-store'
import type { RateLimitPolicy } from '../rate-limit-store'

// 最小 DurableObjectStorage mock,返回内部 Map 供测试直接观察/操作
function makeMockStorage(store: Map<string, unknown>): DurableObjectStorage {
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

function makeState(map: Map<string, unknown>): DurableObjectState {
  return { storage: makeMockStorage(map) } as unknown as DurableObjectState
}

function makeStore(): RateLimitStore {
  return new RateLimitStore(makeState(new Map()))
}

function makeStoreWithMap(): { store: RateLimitStore; map: Map<string, unknown> } {
  const map = new Map<string, unknown>()
  return { store: new RateLimitStore(makeState(map)), map }
}

// 小窗口策略,便于测试
const TEST_POLICY: RateLimitPolicy = {
  windowMs: 60_000,
  maxRequests: 3,
  lockDurationMs: 0,
}

const TEST_POLICY_WITH_LOCK: RateLimitPolicy = {
  windowMs: 60_000,
  maxRequests: 3,
  lockDurationMs: 10_000,
}

describe('RateLimitStore: basic counting', () => {
  it('allows requests up to maxRequests', async () => {
    const store = makeStore()
    const key = 'user:abc'

    for (let i = 1; i <= 3; i++) {
      const result = await store.checkAndIncrement(key, TEST_POLICY)
      expect(result.allowed).toBe(true)
      expect(result.count).toBe(i)
    }
  })

  it('blocks the (maxRequests+1)th request', async () => {
    const store = makeStore()
    const key = 'user:abc'

    for (let i = 0; i < 3; i++) {
      await store.checkAndIncrement(key, TEST_POLICY)
    }

    const result = await store.checkAndIncrement(key, TEST_POLICY)
    expect(result.allowed).toBe(false)
    expect(result.retryAfter).toBeGreaterThan(0)
  })

  it('atomically reserves a requested positive batch size', async () => {
    const store = makeStore()
    const key = 'tenant:invitations'

    const first = await store.checkAndIncrement(key, TEST_POLICY, 2)
    const blocked = await store.checkAndIncrement(key, TEST_POLICY, 2)

    expect(first).toMatchObject({ allowed: true, count: 2 })
    expect(blocked).toMatchObject({ allowed: false, count: 4 })
  })

  it('reset clears counter, subsequent requests succeed', async () => {
    const store = makeStore()
    const key = 'user:abc'

    for (let i = 0; i < 4; i++) {
      await store.checkAndIncrement(key, TEST_POLICY)
    }

    await store.reset(key)

    const result = await store.checkAndIncrement(key, TEST_POLICY)
    expect(result.allowed).toBe(true)
    expect(result.count).toBe(1)
  })
})

describe('RateLimitStore: combined window reservation', () => {
  const HOUR_POLICY: RateLimitPolicy = {
    windowMs: 60 * 60 * 1000,
    maxRequests: 1,
    lockDurationMs: 0,
  }

  it('reserves minute and hour quotas together', async () => {
    const store = makeStore()

    const result = await store.reserveWindows([
      { key: 'otp:min:tenant:user@example.com', policy: POLICIES.OTP_SEND },
      { key: 'otp:hour:tenant:user@example.com', policy: HOUR_POLICY },
    ])

    expect(result).toEqual({ allowed: true, retryAfter: 0, counts: [1, 1] })
  })

  it('does not consume minute quota when the hour window rejects', async () => {
    const store = makeStore()
    const minuteKey = 'otp:min:tenant:user@example.com'
    const hourKey = 'otp:hour:tenant:user@example.com'
    await store.checkAndIncrement(hourKey, HOUR_POLICY)

    const rejected = await store.reserveWindows([
      { key: minuteKey, policy: POLICIES.OTP_SEND },
      { key: hourKey, policy: HOUR_POLICY },
    ])
    const minuteAfterReject = await store.checkAndIncrement(minuteKey, POLICIES.OTP_SEND)

    expect(rejected.allowed).toBe(false)
    expect(minuteAfterReject).toMatchObject({ allowed: true, count: 1 })
  })
})

describe('RateLimitStore: lock duration', () => {
  it('writes lockExpiry when lockDurationMs > 0 and blocks with retryAfter', async () => {
    const store = makeStore()
    const key = 'ip:1.2.3.4'

    for (let i = 0; i < 3; i++) {
      await store.checkAndIncrement(key, TEST_POLICY_WITH_LOCK)
    }

    const result = await store.checkAndIncrement(key, TEST_POLICY_WITH_LOCK)
    expect(result.allowed).toBe(false)
    // retryAfter ~= lockDurationMs / 1000
    expect(result.retryAfter).toBeGreaterThanOrEqual(9)
    expect(result.retryAfter).toBeLessThanOrEqual(11)
  })

  it('continues to block while lock is active', async () => {
    const store = makeStore()
    const key = 'ip:1.2.3.4'

    for (let i = 0; i < 4; i++) {
      await store.checkAndIncrement(key, TEST_POLICY_WITH_LOCK)
    }

    // 再次调用仍被锁定
    const result = await store.checkAndIncrement(key, TEST_POLICY_WITH_LOCK)
    expect(result.allowed).toBe(false)
  })

  it('reset clears lock and allows requests again', async () => {
    const store = makeStore()
    const key = 'ip:1.2.3.4'

    for (let i = 0; i < 4; i++) {
      await store.checkAndIncrement(key, TEST_POLICY_WITH_LOCK)
    }

    await store.reset(key)

    const result = await store.checkAndIncrement(key, TEST_POLICY_WITH_LOCK)
    expect(result.allowed).toBe(true)
  })
})

// backoff 阶梯并入 checkAndIncrement:每次超限后 reset 退避档,重新超限取下一阶梯
const BACKOFF_POLICY: RateLimitPolicy = {
  windowMs: 60_000,
  maxRequests: 3,
  lockDurationMs: 0,
  backoffStepsMs: [5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000],
}

// 触发一次超限,返回该次锁定的 retryAfter(秒);触发后清窗口与锁但保留退避档
// 模拟攻击者等锁自然过期后再次冲击,backoff_count 应单调升级
async function triggerLock(
  store: RateLimitStore,
  map: Map<string, unknown>,
  key: string,
): Promise<number> {
  for (let i = 0; i < 3; i++) {
    await store.checkAndIncrement(key, BACKOFF_POLICY)
  }
  const blocked = await store.checkAndIncrement(key, BACKOFF_POLICY)
  map.delete(`rl:${key}`)
  map.delete(`lock:${key}`)
  return blocked.retryAfter
}

describe('RateLimitStore: account backoff steps (并入 checkAndIncrement)', () => {
  it('first lock uses 5min step', async () => {
    const { store, map } = makeStoreWithMap()
    const r = await triggerLock(store, map, 'user:x')
    expect(r).toBeGreaterThanOrEqual(5 * 60 - 1)
    expect(r).toBeLessThanOrEqual(5 * 60)
  })

  it('escalates 5/15/30/60min across consecutive lockouts', async () => {
    const { store, map } = makeStoreWithMap()
    const key = 'user:y'
    const expected = [5 * 60, 15 * 60, 30 * 60, 60 * 60]
    for (const seconds of expected) {
      const r = await triggerLock(store, map, key)
      expect(r).toBeGreaterThanOrEqual(seconds - 1)
      expect(r).toBeLessThanOrEqual(seconds)
    }
  })

  it('caps at the last step (60min) on further lockouts', async () => {
    const { store, map } = makeStoreWithMap()
    const key = 'user:z'
    // 用完全部阶梯
    for (let i = 0; i < 4; i++) {
      await triggerLock(store, map, key)
    }
    const r = await triggerLock(store, map, key)
    expect(r).toBeGreaterThanOrEqual(60 * 60 - 1)
    expect(r).toBeLessThanOrEqual(60 * 60)
  })

  it('reset clears backoff ladder, next lockout restarts at 5min', async () => {
    const { store, map } = makeStoreWithMap()
    const key = 'user:reset'
    // 升到第三档
    await triggerLock(store, map, key)
    await triggerLock(store, map, key)
    await triggerLock(store, map, key)

    // 登录成功 reset,退避档应清零
    await store.reset(key)
    expect(map.has(`backoff_count:${key}`)).toBe(false)

    const r = await triggerLock(store, map, key)
    expect(r).toBeGreaterThanOrEqual(5 * 60 - 1)
    expect(r).toBeLessThanOrEqual(5 * 60)
  })
})

describe('RateLimitStore: policy presets', () => {
  it('ACCOUNT_FAILURE policy: allows 10 then blocks with 5min backoff', async () => {
    const store = makeStore()
    const key = 'account:uid-test'

    for (let i = 0; i < 10; i++) {
      const r = await store.checkAndIncrement(key, POLICIES.ACCOUNT_FAILURE)
      expect(r.allowed).toBe(true)
    }

    const r = await store.checkAndIncrement(key, POLICIES.ACCOUNT_FAILURE)
    expect(r.allowed).toBe(false)
    // 首次锁定取退避阶梯第一档 5min
    expect(r.retryAfter).toBeGreaterThanOrEqual(5 * 60 - 1)
    expect(r.retryAfter).toBeLessThanOrEqual(5 * 60)
  })

  it('IP_FAILURE policy: allows 50 then blocks with 1h lock', async () => {
    const store = makeStore()
    const key = 'ip:10.0.0.1'

    for (let i = 0; i < 50; i++) {
      await store.checkAndIncrement(key, POLICIES.IP_FAILURE)
    }

    const r = await store.checkAndIncrement(key, POLICIES.IP_FAILURE)
    expect(r.allowed).toBe(false)
    // lockDurationMs = 1h, retryAfter ~3600s
    expect(r.retryAfter).toBeGreaterThanOrEqual(3590)
    expect(r.retryAfter).toBeLessThanOrEqual(3601)
  })

  it('OTP_SEND policy: allows 1 then blocks', async () => {
    const store = makeStore()
    const key = 'otp:recipient@example.com'

    const first = await store.checkAndIncrement(key, POLICIES.OTP_SEND)
    expect(first.allowed).toBe(true)

    const second = await store.checkAndIncrement(key, POLICIES.OTP_SEND)
    expect(second.allowed).toBe(false)
  })

  it('different keys are independent', async () => {
    const store = makeStore()

    const a = await store.checkAndIncrement('key:a', POLICIES.OTP_SEND)
    const b = await store.checkAndIncrement('key:b', POLICIES.OTP_SEND)

    expect(a.allowed).toBe(true)
    expect(b.allowed).toBe(true)
  })
})
