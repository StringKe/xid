// GuestStore DO 单元测试:anonKey -> guest user 绑定的 check-and-set 语义。
// - 串行重试幂等:重复 bind 返回既有 userId(created=false),不覆盖。
// - 并发只建一个:两个不同 userId 竞争同一实例,先到者胜出。
// - TTL:过期绑定 lookup 404 且可被重新 bind;alarm 到期清理。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GuestStore } from '../guest-store'
import { MockDurableObjectState } from './mock-do-state'

function makeDO(): { store: GuestStore; state: MockDurableObjectState } {
  const state = new MockDurableObjectState()
  const store = new GuestStore(state as unknown as DurableObjectState)
  state.setAlarmHandler(() => store.alarm())
  return { store, state }
}

function post(path: string, body: unknown = {}): Request {
  return new Request(`https://guest-store${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const TTL_MS = 60_000

describe('GuestStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('lookup 无绑定返回 404', async () => {
    const { store } = makeDO()
    const res = await store.fetch(post('/lookup'))
    expect(res.status).toBe(404)
  })

  it('bind 首次创建,串行重试幂等返回既有 userId', async () => {
    const { store } = makeDO()

    const first = await store.fetch(post('/bind', { userId: 'user_1', ttlMs: TTL_MS }))
    expect(await first.json()).toEqual({ userId: 'user_1', created: true })

    // 重试(网络重发/串行重试):同一 userId 不重复建,直接命中既有绑定。
    const retry = await store.fetch(post('/bind', { userId: 'user_1', ttlMs: TTL_MS }))
    expect(await retry.json()).toEqual({ userId: 'user_1', created: false })

    const lookup = await store.fetch(post('/lookup'))
    expect(await lookup.json()).toEqual({ userId: 'user_1' })
  })

  it('并发竞争只建一个:后到 bind 拿到先到者的 userId', async () => {
    const { store } = makeDO()

    const [winner, loser] = await Promise.all([
      store.fetch(post('/bind', { userId: 'user_a', ttlMs: TTL_MS })),
      store.fetch(post('/bind', { userId: 'user_b', ttlMs: TTL_MS })),
    ])
    const bodies = [await winner.json(), await loser.json()] as Array<{
      userId: string
      created: boolean
    }>

    expect(bodies.filter((b) => b.created)).toHaveLength(1)
    expect(bodies.every((b) => b.userId === 'user_a' || b.userId === 'user_b')).toBe(true)
    // 绑定唯一:lookup 只能看到胜出的那个。
    const created = bodies.find((b) => b.created)
    const lookup = await store.fetch(post('/lookup'))
    expect(await lookup.json()).toEqual({ userId: created?.userId })
  })

  it('过期绑定 lookup 404,且可被重新 bind', async () => {
    const { store } = makeDO()
    await store.fetch(post('/bind', { userId: 'user_1', ttlMs: TTL_MS }))

    vi.setSystemTime(Date.now() + TTL_MS + 1)

    expect((await store.fetch(post('/lookup'))).status).toBe(404)
    const rebind = await store.fetch(post('/bind', { userId: 'user_2', ttlMs: TTL_MS }))
    expect(await rebind.json()).toEqual({ userId: 'user_2', created: true })
  })

  it('alarm 到期清理绑定;未到期保留并重调度', async () => {
    const { store, state } = makeDO()
    await store.fetch(post('/bind', { userId: 'user_1', ttlMs: TTL_MS }))

    // 未到期:alarm 不删,lookup 仍命中。
    await state.triggerAlarm()
    expect((await store.fetch(post('/lookup'))).status).toBe(200)

    // 到期:alarm 清掉绑定。
    vi.setSystemTime(Date.now() + TTL_MS + 1)
    await state.triggerAlarm()
    expect((await store.fetch(post('/lookup'))).status).toBe(404)
  })

  it('unbind 删除绑定', async () => {
    const { store } = makeDO()
    await store.fetch(post('/bind', { userId: 'user_1', ttlMs: TTL_MS }))
    expect((await store.fetch(post('/unbind'))).status).toBe(204)
    expect((await store.fetch(post('/lookup'))).status).toBe(404)
  })

  it('bind 缺 userId 返回 400', async () => {
    const { store } = makeDO()
    expect((await store.fetch(post('/bind', { ttlMs: TTL_MS }))).status).toBe(400)
  })
})
