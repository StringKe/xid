// Metering Queue Consumer 测试:Queue 至少一次投递不会重复累计 DAU/MAU,当月 MAU 不低于当日 DAU。

import { describe, expect, it, vi } from 'vitest'
import type { MeteringQueueEnvelope, MeteringQueueMessage } from '@xid-kit/types'
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

type FakeUsage = {
  daily: Map<string, number>
  monthly: Map<string, number>
}

type FakeStatement = {
  table: 'usage_daily' | 'usage_monthly'
  tenantId: string
  period: string
  value: number
}

function makeMessage(
  userId: string,
  ts = Date.UTC(2025, 0, 15),
  tenantId = 'tenant_1',
): FakeMessage {
  return {
    body: { tenantId, userId, ts },
    ack: vi.fn(),
    retry: vi.fn(),
  }
}

function makeUsage(): FakeUsage {
  return { daily: new Map(), monthly: new Map() }
}

function makeState(): FakeMeteringState {
  return { daySets: new Map(), monthSets: new Map() }
}

function makeEnv(state: FakeMeteringState, usage: FakeUsage): Env {
  const stub = {
    async recordUser(tenantId: string, userId: string, yearMonth: string, day: string) {
      const monthKey = `${tenantId}:${yearMonth}`
      const dayKey = `${tenantId}:${day}`
      const monthSet = state.monthSets.get(monthKey) ?? new Set<string>()
      const daySet = state.daySets.get(dayKey) ?? new Set<string>()
      monthSet.add(userId)
      daySet.add(userId)
      state.monthSets.set(monthKey, monthSet)
      state.daySets.set(dayKey, daySet)
      return { dau: daySet.size, mau: monthSet.size }
    },
  }
  const db = {
    prepare(sql: string) {
      const table = sql.includes('INTO usage_monthly') ? 'usage_monthly' : 'usage_daily'
      return {
        bind(tenantId: string, period: string, value: number): FakeStatement {
          return { table, tenantId, period, value }
        },
      }
    },
    async batch(statements: FakeStatement[]) {
      for (const statement of statements) {
        const rows = statement.table === 'usage_monthly' ? usage.monthly : usage.daily
        const key = `${statement.tenantId}:${statement.period}`
        rows.set(key, Math.max(rows.get(key) ?? 0, statement.value))
      }
    },
  }
  return {
    DB: db,
    METERING: {
      idFromName: (name: string) => name,
      get: () => stub,
    },
  } as unknown as Env
}

function makeBatch(messages: FakeMessage[]): MessageBatch<MeteringQueueEnvelope> {
  return { messages } as unknown as MessageBatch<MeteringQueueEnvelope>
}

describe('handleMeteringBatch', () => {
  it('D1 成功后 Queue 重投同一事件，DAU 仍为一次', async () => {
    const usage = makeUsage()
    const message = makeMessage('user_1')
    const env = makeEnv(makeState(), usage)

    await handleMeteringBatch(makeBatch([message]), env)
    await handleMeteringBatch(makeBatch([message]), env)

    expect(usage.daily.get('tenant_1:2025-01-15')).toBe(1)
    expect(usage.monthly.get('tenant_1:2025-01')).toBe(1)
    expect(message.ack).toHaveBeenCalledTimes(2)
    expect(message.retry).not.toHaveBeenCalled()
  })

  it('同一用户跨 batch 的同日事件只累计一次', async () => {
    const usage = makeUsage()
    const env = makeEnv(makeState(), usage)

    await handleMeteringBatch(makeBatch([makeMessage('user_1')]), env)
    await handleMeteringBatch(makeBatch([makeMessage('user_1')]), env)

    expect(usage.daily.get('tenant_1:2025-01-15')).toBe(1)
  })

  it('并行 consumer 处理同一用户时，DAU 只累计一次', async () => {
    const usage = makeUsage()
    const env = makeEnv(makeState(), usage)

    await Promise.all([
      handleMeteringBatch(makeBatch([makeMessage('user_1')]), env),
      handleMeteringBatch(makeBatch([makeMessage('user_1')]), env),
    ])

    expect(usage.daily.get('tenant_1:2025-01-15')).toBe(1)
  })

  it('新租户在首月首日的第一次登录同时写入 DAU 1 和当月 MAU 1，不等待每日 Cron', async () => {
    const usage = makeUsage()
    const env = makeEnv(makeState(), usage)
    const firstSignIn = Date.UTC(2026, 9, 9, 8, 30)

    await handleMeteringBatch(makeBatch([makeMessage('owner', firstSignIn, 'tenant_new')]), env)

    expect(usage.daily.get('tenant_new:2026-10-09')).toBe(1)
    expect(usage.monthly.get('tenant_new:2026-10')).toBe(1)
  })

  it('同月多日登录时当月 MAU 按用户去重且不低于任一日 DAU', async () => {
    const usage = makeUsage()
    const env = makeEnv(makeState(), usage)

    await handleMeteringBatch(
      makeBatch([
        makeMessage('user_1', Date.UTC(2025, 0, 15)),
        makeMessage('user_2', Date.UTC(2025, 0, 15)),
        makeMessage('user_1', Date.UTC(2025, 0, 16)),
      ]),
      env,
    )

    expect(usage.daily.get('tenant_1:2025-01-15')).toBe(2)
    expect(usage.daily.get('tenant_1:2025-01-16')).toBe(1)
    expect(usage.monthly.get('tenant_1:2025-01')).toBe(2)
  })

  it('不同租户的计量互不影响', async () => {
    const usage = makeUsage()
    const env = makeEnv(makeState(), usage)

    await handleMeteringBatch(
      makeBatch([
        makeMessage('user_1', Date.UTC(2025, 0, 15), 'tenant_a'),
        makeMessage('user_1', Date.UTC(2025, 0, 15), 'tenant_b'),
      ]),
      env,
    )

    expect(usage.monthly.get('tenant_a:2025-01')).toBe(1)
    expect(usage.monthly.get('tenant_b:2025-01')).toBe(1)
  })

  it('MeteringDO 不可用时记录错误并重试，不写 D1', async () => {
    const usage = makeUsage()
    const env = makeEnv(makeState(), usage)
    const failing = { recordUser: () => Promise.reject(new Error('do unavailable')) }
    ;(env.METERING as unknown as { get: () => unknown }).get = () => failing
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const message = makeMessage('user_1')

    await handleMeteringBatch(makeBatch([message]), env)

    expect(message.retry).toHaveBeenCalledTimes(1)
    expect(message.ack).not.toHaveBeenCalled()
    expect(usage.daily.size + usage.monthly.size).toBe(0)
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'metering.record_failed' }),
    )
    errorLog.mockRestore()
  })
})
