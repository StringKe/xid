// ChallengeStore 单元测试:一次性消费 / 过期失效 / 重放拒绝 / alarm 清理。
// 见 webauthn rule 四验证 challenge;challenge 存 DO 验证后销毁。

import { describe, it, expect, vi } from 'vitest'
import { ChallengeStore } from '../challenge-store'
import { MockDurableObjectState } from './mock-do-state'

function makeStore(): { store: ChallengeStore; state: MockDurableObjectState } {
  const state = new MockDurableObjectState()
  const store = new ChallengeStore(state as unknown as DurableObjectState)
  state.setAlarmHandler(() => (store as unknown as { alarm(): Promise<void> }).alarm())
  return { store, state }
}

async function post(store: ChallengeStore, path: string, body: unknown): Promise<Response> {
  return store.fetch(
    new Request(`http://do${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

describe('ChallengeStore.create', () => {
  it('returns 201 on valid create', async () => {
    const { store } = makeStore()
    const res = await post(store, '/create', { key: 'k1', value: 'challenge-abc', ttlMs: 60_000 })
    expect(res.status).toBe(201)
  })

  it('returns 400 when key is missing', async () => {
    const { store } = makeStore()
    const res = await post(store, '/create', { value: 'v', ttlMs: 60_000 })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('invalid_request')
  })

  it('returns 400 when value is missing', async () => {
    const { store } = makeStore()
    const res = await post(store, '/create', { key: 'k1', ttlMs: 60_000 })
    expect(res.status).toBe(400)
  })
})

describe('ChallengeStore.consume - 一次性', () => {
  it('returns value on first consume', async () => {
    const { store } = makeStore()
    await post(store, '/create', { key: 'k2', value: 'my-challenge', ttlMs: 60_000 })

    const res = await post(store, '/consume', { key: 'k2' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { value: string }
    expect(body.value).toBe('my-challenge')
  })

  it('returns 404 on second consume (replay denied)', async () => {
    const { store } = makeStore()
    await post(store, '/create', { key: 'k3', value: 'challenge-x', ttlMs: 60_000 })

    const first = await post(store, '/consume', { key: 'k3' })
    expect(first.status).toBe(200)

    // 第二次消费即重放,必须拒绝
    const second = await post(store, '/consume', { key: 'k3' })
    expect(second.status).toBe(404)
    const body = (await second.json()) as { code: string }
    expect(body.code).toBe('challenge_invalid')
  })

  it('returns 404 when key does not exist', async () => {
    const { store } = makeStore()
    const res = await post(store, '/consume', { key: 'nonexistent' })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('challenge_invalid')
  })
})

describe('ChallengeStore.claim - 重放栅栏', () => {
  it('only accepts the first unexpired assertion key', async () => {
    const { store } = makeStore()
    const first = await post(store, '/claim', { key: 'assertion-1', value: '1', ttlMs: 60_000 })
    const replay = await post(store, '/claim', { key: 'assertion-1', value: '1', ttlMs: 60_000 })

    expect(first.status).toBe(201)
    expect(replay.status).toBe(409)
    expect((await replay.json()) as { code: string }).toMatchObject({ code: 'replay_detected' })
  })

  it('keeps a claim longer than the create cap until its requested ttl', async () => {
    vi.useFakeTimers()
    try {
      const { store } = makeStore()
      const ttlMs = 70 * 60 * 1000
      await post(store, '/claim', { key: 'assertion-long', value: '1', ttlMs })

      vi.advanceTimersByTime(ttlMs - 1000)
      const replay = await post(store, '/claim', { key: 'assertion-long', value: '1', ttlMs })

      expect(replay.status).toBe(409)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([0, -1, 24 * 60 * 60 * 1000 + 1, 'soon'])(
    'rejects ttlMs=%s instead of falling back to the default',
    async (ttlMs) => {
      const { store, state } = makeStore()

      const res = await post(store, '/claim', { key: 'assertion-bad', value: '1', ttlMs })

      expect(res.status).toBe(400)
      expect(await state.storage.get('assertion-bad')).toBeUndefined()
    },
  )

  it('does not widen the create ttl cap', async () => {
    const { store, state } = makeStore()

    await post(store, '/create', { key: 'k-long', value: 'v', ttlMs: 60 * 60 * 1000 })

    const record = (await state.storage.get('k-long')) as { expiresAt: number }
    expect(record.expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000)
  })
})

describe('ChallengeStore.consume - 过期失效', () => {
  it('returns 410 when challenge is expired', async () => {
    const { store, state } = makeStore()
    // ttlMs=1 -> 立即过期
    await post(store, '/create', { key: 'k-exp', value: 'exp-val', ttlMs: 1 })

    // 等 ttl 过去
    await new Promise((r) => setTimeout(r, 5))

    const res = await post(store, '/consume', { key: 'k-exp' })
    expect(res.status).toBe(410)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('challenge_invalid')

    // 过期后 key 应被删除
    const record = await state.storage.get('k-exp')
    expect(record).toBeUndefined()
  })

  it('alarm clears expired entries and storage becomes empty', async () => {
    const { store, state } = makeStore()
    await post(store, '/create', { key: 'k-alarm', value: 'v', ttlMs: 1 })

    await new Promise((r) => setTimeout(r, 5))

    expect(state.storage.size()).toBe(1)
    await state.triggerAlarm()
    expect(state.storage.size()).toBe(0)
  })

  it('alarm 单次 list 扫描,按剩余最早过期时间 + 60s 再调度', async () => {
    const { state } = makeStore()
    const now = Date.now()
    await state.storage.put('k-expired', { value: 'v', expiresAt: now - 1000 })
    await state.storage.put('k-later', { value: 'v', expiresAt: now + 300_000 })
    await state.storage.put('k-sooner', { value: 'v', expiresAt: now + 120_000 })
    const listSpy = vi.spyOn(state.storage, 'list')

    await state.triggerAlarm()

    expect(listSpy).toHaveBeenCalledTimes(1)
    expect(await state.storage.get('k-expired')).toBeUndefined()
    expect(await state.storage.getAlarm()).toBe(now + 120_000 + 60_000)
  })

  it('alarm 清空全部过期记录后不再调度', async () => {
    const { state } = makeStore()
    await state.storage.put('k-expired', { value: 'v', expiresAt: Date.now() - 1000 })

    await state.triggerAlarm()

    expect(state.storage.size()).toBe(0)
    expect(await state.storage.getAlarm()).toBeNull()
  })

  it('alarm 过期记录超过 128 个时分批删除', async () => {
    const { state } = makeStore()
    const expiresAt = Date.now() - 1000
    for (let i = 0; i < 300; i++) {
      await state.storage.put(`k-${i}`, { value: 'v', expiresAt })
    }
    const deleteSpy = vi.spyOn(state.storage, 'delete')

    await state.triggerAlarm()

    expect(state.storage.size()).toBe(0)
    expect(deleteSpy).toHaveBeenCalledTimes(3)
  })
})

describe('ChallengeStore.create - alarm 取最早过期', () => {
  it('先长 TTL 后短 TTL,alarm 推回到短记录的过期时间', async () => {
    const { store, state } = makeStore()
    // 长 TTL 先创建 -> alarm 设到长过期
    await post(store, '/create', { key: 'k-long', value: 'v', ttlMs: 600_000 })
    const afterLong = await state.storage.getAlarm()
    expect(afterLong).not.toBeNull()

    // 短 TTL 后创建 -> alarm 应被拉早到短过期
    await post(store, '/create', { key: 'k-short', value: 'v', ttlMs: 1000 })
    const afterShort = await state.storage.getAlarm()
    expect(afterShort).not.toBeNull()
    expect(afterShort as number).toBeLessThan(afterLong as number)
  })

  it('先短 TTL 后长 TTL,alarm 不被长记录推迟', async () => {
    const { store, state } = makeStore()
    await post(store, '/create', { key: 'k-short', value: 'v', ttlMs: 1000 })
    const afterShort = await state.storage.getAlarm()

    await post(store, '/create', { key: 'k-long', value: 'v', ttlMs: 600_000 })
    const afterLong = await state.storage.getAlarm()
    expect(afterLong).toBe(afterShort)
  })
})

describe('ChallengeStore - 400 on bad JSON', () => {
  it('returns 400 on non-JSON body for create', async () => {
    const { store } = makeStore()
    const res = await store.fetch(
      new Request('http://do/create', { method: 'POST', body: 'not-json' }),
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 on non-JSON body for consume', async () => {
    const { store } = makeStore()
    const res = await store.fetch(
      new Request('http://do/consume', { method: 'POST', body: 'not-json' }),
    )
    expect(res.status).toBe(400)
  })
})

describe('ChallengeStore - unknown path', () => {
  it('returns 404 for unknown path', async () => {
    const { store } = makeStore()
    const res = await store.fetch(new Request('http://do/unknown', { method: 'POST' }))
    expect(res.status).toBe(404)
  })
})
