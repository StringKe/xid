// Metering Queue Consumer 测试:Queue 至少一次投递不会重复累计 DAU。

import { describe, expect, it, vi } from 'vitest'
import type { MeteringQueueMessage } from '@xid-kit/types'
import { handleMeteringBatch } from '../metering'

type FakeMessage = {
  body: MeteringQueueMessage
  ack: ReturnType<typeof vi.fn>
  retry: ReturnType<typeof vi.fn>
}

type FakeMeteringState = {
  daySets: Map<string, Set<string>>
  monthSets: Map<string, Set<string>>
}

type FakeUsageDaily = Map<string, number>

function makeMessage(userId: string, ts = Date.UTC(2025, 0, 15)): FakeMessage {
  return {
    body: { tenantId: 'tenant_1', userId, ts },
    ack: vi.fn(),
    retry: vi.fn(),
  }
}

function makeEnv(state: FakeMeteringState, usageDaily: FakeUsageDaily): Env {
  const stub = {
    async recordUser(_tenantId: string, userId: string, yearMonth: string, day: string) {
      const monthSet = state.monthSets.get(yearMonth) ?? new Set<string>()
      const daySet = state.daySets.get(day) ?? new Set<string>()
      monthSet.add(userId)
      daySet.add(userId)
      state.monthSets.set(yearMonth, monthSet)
      state.daySets.set(day, daySet)
      return { dau: daySet.size }
    },
  }
  const db = {
    prepare(sql: string) {
      return {
        bind(tenantId: string, day: string, dau: number) {
          return { tenantId, day, dau, sql }
        },
      }
    },
    async batch(statements: Array<{ tenantId: string; day: string; dau: number; sql: string }>) {
      for (const statement of statements) {
        const key = `${statement.tenantId}:${statement.day}`
        usageDaily.set(key, Math.max(usageDaily.get(key) ?? 0, statement.dau))
      }
    },
  }
  return {
    DB: db,
    METERING: {
      idFromName: () => 'metering:tenant_1',
      get: () => stub,
    },
  } as unknown as Env
}

function makeBatch(messages: FakeMessage[]): MessageBatch<MeteringQueueMessage> {
  return { messages } as unknown as MessageBatch<MeteringQueueMessage>
}

describe('handleMeteringBatch', () => {
  it('D1 成功后 Queue 重投同一事件，DAU 仍为一次', async () => {
    const state = { daySets: new Map(), monthSets: new Map() }
    const usageDaily = new Map<string, number>()
    const message = makeMessage('user_1')
    const env = makeEnv(state, usageDaily)

    await handleMeteringBatch(makeBatch([message]), env)
    await handleMeteringBatch(makeBatch([message]), env)

    expect(usageDaily.get('tenant_1:2025-01-15')).toBe(1)
    expect(message.ack).toHaveBeenCalledTimes(2)
    expect(message.retry).not.toHaveBeenCalled()
  })

  it('同一用户跨 batch 的同日事件只累计一次', async () => {
    const state = { daySets: new Map(), monthSets: new Map() }
    const usageDaily = new Map<string, number>()
    const env = makeEnv(state, usageDaily)

    await handleMeteringBatch(makeBatch([makeMessage('user_1')]), env)
    await handleMeteringBatch(makeBatch([makeMessage('user_1')]), env)

    expect(usageDaily.get('tenant_1:2025-01-15')).toBe(1)
  })

  it('并行 consumer 处理同一用户时，DAU 只累计一次', async () => {
    const state = { daySets: new Map(), monthSets: new Map() }
    const usageDaily = new Map<string, number>()
    const env = makeEnv(state, usageDaily)

    await Promise.all([
      handleMeteringBatch(makeBatch([makeMessage('user_1')]), env),
      handleMeteringBatch(makeBatch([makeMessage('user_1')]), env),
    ])

    expect(usageDaily.get('tenant_1:2025-01-15')).toBe(1)
  })
})
