// Cron 路由集成测试:dispatchScheduled 按 wrangler triggers 表达式分发 hourly/daily。
import { afterEach, describe, expect, it, vi } from 'vitest'

const { runHourly, runDaily } = vi.hoisted(() => ({
  runHourly: vi.fn().mockResolvedValue(undefined),
  runDaily: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../hourly', () => ({ runHourly }))
vi.mock('../daily', () => ({ runDaily }))

import { CRON_DAILY, CRON_HOURLY, dispatchScheduled } from '../index'

describe('dispatchScheduled routing', () => {
  afterEach(() => {
    runHourly.mockClear()
    runDaily.mockClear()
  })

  it('delegates 0 * * * * to runHourly only', async () => {
    const env = { DB: {} } as unknown as Env
    await dispatchScheduled(CRON_HOURLY, env)
    expect(runHourly).toHaveBeenCalledOnce()
    expect(runHourly).toHaveBeenCalledWith(env)
    expect(runDaily).not.toHaveBeenCalled()
  })

  it('delegates 0 2 * * * to runDaily only', async () => {
    const env = { DB: {} } as unknown as Env
    await dispatchScheduled(CRON_DAILY, env)
    expect(runDaily).toHaveBeenCalledOnce()
    expect(runDaily).toHaveBeenCalledWith(env)
    expect(runHourly).not.toHaveBeenCalled()
  })
})
