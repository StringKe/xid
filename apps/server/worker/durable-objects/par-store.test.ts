// ParStore 单元测试:RFC9126 PAR 一次性 / 过期 / 存储。
// 用内存 mock 替代 DurableObjectStorage,不依赖 Workers 运行时。
import { describe, it, expect, beforeEach } from 'vitest'
import { ParStore } from './par-store'

// --- 内存 storage mock ---

type StorageMap = Map<string, unknown>

function makeStorageMock(map: StorageMap, alarmRef: { value: number | null }) {
  return {
    async put(key: string, value: unknown) {
      map.set(key, value)
    },
    async get<T>(key: string): Promise<T | undefined> {
      return map.get(key) as T | undefined
    },
    async delete(keys: string | string[]) {
      if (Array.isArray(keys)) {
        for (const k of keys) map.delete(k)
      } else {
        map.delete(keys)
      }
    },
    async list<T>(): Promise<Map<string, T>> {
      return map as Map<string, T>
    },
    async getAlarm(): Promise<number | null> {
      return alarmRef.value
    },
    async setAlarm(ts: number) {
      alarmRef.value = ts
    },
  }
}

function makeState() {
  const map: StorageMap = new Map()
  const alarmRef = { value: null as number | null }
  const storage = makeStorageMock(map, alarmRef)
  return { state: { storage } as unknown as DurableObjectState, map, alarmRef }
}

function makeRequest(path: string, body: unknown): Request {
  return new Request(`http://do${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// --- 共享状态 ---

let store: ParStore
let map: StorageMap
let alarmRef: { value: number | null }

function setup() {
  const ctx = makeState()
  store = new ParStore(ctx.state)
  map = ctx.map
  alarmRef = ctx.alarmRef
}

// --- store ---

describe('ParStore: store', () => {
  beforeEach(setup)

  it('存储有效的 PAR 请求', async () => {
    const now = Date.now()
    const requestUri = 'urn:ietf:params:oauth:request_uri:test-123'
    const params = { response_type: 'code', client_id: 'app1', scope: 'openid' }
    const res = await store.fetch(
      makeRequest('/store', { requestUri, params, expiresAt: now + 30_000 }),
    )
    expect(res.status).toBe(200)
    const body = await res.json<{ stored: boolean }>()
    expect(body.stored).toBe(true)
    expect(map.has(requestUri)).toBe(true)
  })

  it('expiresAt 超过 60s 上限时拒绝', async () => {
    const now = Date.now()
    const res = await store.fetch(
      makeRequest('/store', { requestUri: 'urn:test', params: {}, expiresAt: now + 120_000 }),
    )
    expect(res.status).toBe(400)
    const body = await res.json<{ error: string }>()
    expect(body.error).toBe('invalid_request')
  })

  it('expiresAt 已过期时拒绝', async () => {
    const res = await store.fetch(
      makeRequest('/store', { requestUri: 'urn:test', params: {}, expiresAt: Date.now() - 1000 }),
    )
    expect(res.status).toBe(400)
  })

  it('设置 alarm 为 expiresAt', async () => {
    const now = Date.now()
    const expiresAt = now + 30_000
    await store.fetch(
      makeRequest('/store', { requestUri: 'urn:test', params: { client_id: 'c1' }, expiresAt }),
    )
    expect(alarmRef.value).toBe(expiresAt)
  })
})

// --- consume (一次性) ---

describe('ParStore: consume', () => {
  beforeEach(setup)

  it('第一次 consume 返回 params', async () => {
    const now = Date.now()
    const requestUri = 'urn:ietf:params:oauth:request_uri:once'
    const params = { client_id: 'app1', scope: 'openid profile' }
    await store.fetch(makeRequest('/store', { requestUri, params, expiresAt: now + 30_000 }))
    const res = await store.fetch(makeRequest('/consume', { requestUri }))
    expect(res.status).toBe(200)
    const body = await res.json<{ params: Record<string, string> }>()
    expect(body.params).toEqual(params)
  })

  it('consume 后条目被删除(一次性)', async () => {
    const now = Date.now()
    const requestUri = 'urn:ietf:params:oauth:request_uri:del-after'
    await store.fetch(makeRequest('/store', { requestUri, params: {}, expiresAt: now + 30_000 }))
    await store.fetch(makeRequest('/consume', { requestUri }))
    expect(map.has(requestUri)).toBe(false)
  })

  it('重复 consume 同一 request_uri 返回 404', async () => {
    const now = Date.now()
    const requestUri = 'urn:ietf:params:oauth:request_uri:replay'
    await store.fetch(makeRequest('/store', { requestUri, params: {}, expiresAt: now + 30_000 }))
    await store.fetch(makeRequest('/consume', { requestUri }))
    const res2 = await store.fetch(makeRequest('/consume', { requestUri }))
    expect(res2.status).toBe(404)
    const body = await res2.json<{ error: string }>()
    expect(body.error).toBe('invalid_request')
  })

  it('consume 不存在的 request_uri 返回 404', async () => {
    const res = await store.fetch(makeRequest('/consume', { requestUri: 'urn:nonexistent' }))
    expect(res.status).toBe(404)
  })

  it('consume 已过期的 request_uri 返回 expired_token', async () => {
    const requestUri = 'urn:ietf:params:oauth:request_uri:expired'
    map.set(requestUri, { params: {}, expiresAt: Date.now() - 5000 })
    const res = await store.fetch(makeRequest('/consume', { requestUri }))
    expect(res.status).toBe(400)
    const body = await res.json<{ error: string }>()
    expect(body.error).toBe('expired_token')
    expect(map.has(requestUri)).toBe(false)
  })
})

// --- cleanup ---

describe('ParStore: cleanup', () => {
  beforeEach(setup)

  it('删除所有过期条目', async () => {
    const now = Date.now()
    map.set('urn:expired-1', { params: {}, expiresAt: now - 5000 })
    map.set('urn:expired-2', { params: {}, expiresAt: now - 1000 })
    map.set('urn:valid', { params: { x: '1' }, expiresAt: now + 30_000 })
    const res = await store.fetch(makeRequest('/cleanup', {}))
    expect(res.status).toBe(200)
    const body = await res.json<{ deleted: number }>()
    expect(body.deleted).toBe(2)
    expect(map.has('urn:expired-1')).toBe(false)
    expect(map.has('urn:expired-2')).toBe(false)
    expect(map.has('urn:valid')).toBe(true)
  })
})

// --- HTTP 错误 ---

describe('ParStore: HTTP errors', () => {
  beforeEach(setup)

  it('非 POST 方法返回 405', async () => {
    const res = await store.fetch(new Request('http://do/store', { method: 'GET' }))
    expect(res.status).toBe(405)
  })

  it('未知路径返回 404', async () => {
    const res = await store.fetch(makeRequest('/unknown', {}))
    expect(res.status).toBe(404)
  })
})
