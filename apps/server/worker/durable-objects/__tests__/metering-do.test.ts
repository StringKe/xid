// MeteringDO 单元测试。
// 使用可失败 DO storage 验证 membership key 和 count 同次写入时的精确性。

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    protected ctx: DurableObjectState

    constructor(ctx: DurableObjectState, ..._args: unknown[]) {
      this.ctx = ctx
    }
  },
}))

import { MeteringDO } from '../metering-do'

type TestStorage = {
  data: Map<string, boolean | number>
  shouldFailNextPut: boolean
}

function makeStorage(): TestStorage {
  return { data: new Map(), shouldFailNextPut: false }
}

function makeState(storage: TestStorage): DurableObjectState {
  type ListOptions = {
    prefix?: string
    limit?: number
    startAfter?: string
  }

  const durableStorage = {
    get: async <T>(key: string): Promise<T | undefined> => storage.data.get(key) as T | undefined,
    put: async (entries: Record<string, boolean | number>): Promise<void> => {
      if (storage.shouldFailNextPut) {
        storage.shouldFailNextPut = false
        throw new Error('storage unavailable')
      }
      for (const [key, value] of Object.entries(entries)) {
        storage.data.set(key, value)
      }
    },
    list: async <T>(options: ListOptions): Promise<Map<string, T>> => {
      const entries = Array.from(storage.data.entries())
        .filter(([key]) => options.prefix === undefined || key.startsWith(options.prefix))
        .filter(([key]) => options.startAfter === undefined || key > options.startAfter)
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, options.limit)
      return new Map(entries) as Map<string, T>
    },
    delete: async (input: string | string[]): Promise<number> => {
      const keys = typeof input === 'string' ? [input] : input
      let count = 0
      for (const key of keys) {
        if (storage.data.delete(key)) count += 1
      }
      return count
    },
  }
  return { storage: durableStorage } as unknown as DurableObjectState
}

function makeDO(storage: TestStorage): MeteringDO {
  return new MeteringDO(makeState(storage), {} as Env)
}

describe('MeteringDO', () => {
  let storage: TestStorage

  beforeEach(() => {
    storage = makeStorage()
  })

  it('同用户跨日只计一次 MAU，每个日期各计一次 DAU', async () => {
    const do_ = makeDO(storage)

    await expect(do_.recordUser('tenant_1', 'user_1', '2025-01', '2025-01-15')).resolves.toEqual({
      dau: 1,
    })
    await expect(do_.recordUser('tenant_1', 'user_1', '2025-01', '2025-01-16')).resolves.toEqual({
      dau: 1,
    })
    await expect(do_.recordUser('tenant_1', 'user_1', '2025-01', '2025-01-16')).resolves.toEqual({
      dau: 1,
    })

    expect(await do_.getMau('tenant_1', '2025-01')).toBe(1)
  })

  it('storage.put 失败后不写 membership 或 count，重试和重启后保持精确一致', async () => {
    const firstInstance = makeDO(storage)
    storage.shouldFailNextPut = true

    await expect(
      firstInstance.recordUser('tenant_1', 'user_1', '2025-01', '2025-01-15'),
    ).rejects.toThrow('storage unavailable')

    expect(await firstInstance.getMau('tenant_1', '2025-01')).toBe(0)
    expect(storage.data.size).toBe(0)

    await expect(
      firstInstance.recordUser('tenant_1', 'user_1', '2025-01', '2025-01-15'),
    ).resolves.toEqual({ dau: 1 })

    const restartedInstance = makeDO(storage)
    await expect(
      restartedInstance.recordUser('tenant_1', 'user_1', '2025-01', '2025-01-15'),
    ).resolves.toEqual({ dau: 1 })
    expect(await restartedInstance.getMau('tenant_1', '2025-01')).toBe(1)
  })

  it('evictMonth 清理月度和日度 membership 与 count', async () => {
    const do_ = makeDO(storage)
    await do_.recordUser('tenant_1', 'user_1', '2025-01', '2025-01-15')
    await do_.recordUser('tenant_1', 'user_2', '2025-01', '2025-01-16')

    await do_.evictMonth('2025-01')

    expect(await do_.getMau('tenant_1', '2025-01')).toBe(0)
    expect(storage.data.size).toBe(0)
  })

  it('evictMonth 分页清理超过 1000 个 membership', async () => {
    storage.data.set('count:month:2025-01', 1001)
    for (let index = 0; index < 1001; index += 1) {
      storage.data.set(`member:month:2025-01:user_${index}`, true)
    }
    const do_ = makeDO(storage)

    await do_.evictMonth('2025-01')

    expect(storage.data.size).toBe(0)
  })

  it('500000 membership 在 storage 中保留，实例不反序列化或缓存用户全集', async () => {
    storage.data.set('count:month:2025-01', 500000)
    for (let index = 0; index < 500000; index += 1) {
      storage.data.set(`member:month:2025-01:user_${index}`, true)
    }

    const do_ = makeDO(storage)

    expect(await do_.getMau('tenant_1', '2025-01')).toBe(500000)
    expect(Object.getOwnPropertyNames(do_)).not.toContain('sets')
    expect(Object.getOwnPropertyNames(do_)).not.toContain('memberships')
  })
})
