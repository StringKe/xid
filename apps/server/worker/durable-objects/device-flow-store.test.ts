// DeviceFlowStore 单元测试:RFC8628 device_code/user_code 分离 / 授权流转 / 轮询限速。
// 用内存 mock 替代 DurableObjectStorage,不依赖 Workers 运行时。
import { describe, it, expect, beforeEach } from 'vitest'
import { DeviceFlowStore } from './device-flow-store'

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

// --- 测试常量 ---

const DEVICE_CODE = 'dev_abc123'
const USER_CODE = 'ABCD-1234'
const CLIENT_ID = 'test_client'
const TENANT_ID = 'tenant_1'
const USER_ID = 'user_xyz'
const SCOPES = ['openid', 'profile']
const UC_KEY = 'uc:' + USER_CODE.toUpperCase()

function defaultCreateBody(overrides: Record<string, unknown> = {}) {
  return {
    deviceCode: DEVICE_CODE,
    userCode: USER_CODE,
    clientId: CLIENT_ID,
    tenantId: TENANT_ID,
    scopes: SCOPES,
    interval: 5,
    expiresAt: Date.now() + 600_000,
    ...overrides,
  }
}

function makePendingEntry(overrides: Record<string, unknown> = {}) {
  return {
    deviceCode: DEVICE_CODE,
    userCode: USER_CODE,
    clientId: CLIENT_ID,
    tenantId: TENANT_ID,
    scopes: SCOPES,
    status: 'pending',
    interval: 5,
    lastPollAt: 0,
    slowDownCount: 0,
    expiresAt: Date.now() + 600_000,
    ...overrides,
  }
}

// --- 共享状态 ---

let store: DeviceFlowStore
let map: StorageMap

function setup() {
  const ctx = makeState()
  store = new DeviceFlowStore(ctx.state)
  map = ctx.map
}

// --- create ---

describe('DeviceFlowStore: create', () => {
  beforeEach(setup)

  it('创建 device grant,存两个索引', async () => {
    const res = await store.fetch(makeRequest('/create', defaultCreateBody()))
    expect(res.status).toBe(200)
    const body = await res.json<{ created: boolean }>()
    expect(body.created).toBe(true)
    expect(map.has(DEVICE_CODE)).toBe(true)
    expect(map.has(UC_KEY)).toBe(true)
  })

  it('expiresAt 在过去时拒绝', async () => {
    const res = await store.fetch(
      makeRequest('/create', defaultCreateBody({ expiresAt: Date.now() - 1000 })),
    )
    expect(res.status).toBe(400)
  })

  it('缺少 deviceCode 时拒绝', async () => {
    const body = defaultCreateBody()
    delete (body as Record<string, unknown>)['deviceCode']
    const res = await store.fetch(makeRequest('/create', body))
    expect(res.status).toBe(400)
  })
})

// --- poll: pending ---

describe('DeviceFlowStore: poll pending', () => {
  beforeEach(setup)

  it('用户未授权时返回 authorization_pending', async () => {
    await store.fetch(makeRequest('/create', defaultCreateBody()))
    const res = await store.fetch(
      makeRequest('/poll', { deviceCode: DEVICE_CODE, clientId: CLIENT_ID }),
    )
    expect(res.status).toBe(400)
    const body = await res.json<{ error: string }>()
    expect(body.error).toBe('authorization_pending')
  })

  it('不存在的 device_code 返回 expired_token', async () => {
    const res = await store.fetch(
      makeRequest('/poll', { deviceCode: 'nonexistent', clientId: CLIENT_ID }),
    )
    expect(res.status).toBe(400)
    const body = await res.json<{ error: string }>()
    expect(body.error).toBe('expired_token')
  })
})

// --- poll: slow_down ---

describe('DeviceFlowStore: poll slow_down', () => {
  beforeEach(setup)

  it('两次 poll 间隔不足 interval 时返回 slow_down', async () => {
    await store.fetch(makeRequest('/create', defaultCreateBody({ interval: 5 })))
    const first = await store.fetch(
      makeRequest('/poll', { deviceCode: DEVICE_CODE, clientId: CLIENT_ID }),
    )
    expect((await first.json<{ error: string }>()).error).toBe('authorization_pending')
    const second = await store.fetch(
      makeRequest('/poll', { deviceCode: DEVICE_CODE, clientId: CLIENT_ID }),
    )
    expect(second.status).toBe(400)
    expect((await second.json<{ error: string }>()).error).toBe('slow_down')
  })

  it('slow_down 后 interval 增加 5s,slowDownCount+1', async () => {
    await store.fetch(makeRequest('/create', defaultCreateBody({ interval: 5 })))
    await store.fetch(makeRequest('/poll', { deviceCode: DEVICE_CODE, clientId: CLIENT_ID }))
    await store.fetch(makeRequest('/poll', { deviceCode: DEVICE_CODE, clientId: CLIENT_ID }))
    const entry = map.get(DEVICE_CODE) as { interval: number; slowDownCount: number }
    expect(entry.interval).toBe(10)
    expect(entry.slowDownCount).toBe(1)
  })

  it('interval 仅首次过快 +5s,后续连续过快不再累加(防自我 DoS)', async () => {
    const now = Date.now()
    map.set(DEVICE_CODE, makePendingEntry({ interval: 5, lastPollAt: now, slowDownCount: 0 }))
    // 第一次过快:5 -> 10
    await store.fetch(makeRequest('/poll', { deviceCode: DEVICE_CODE, clientId: CLIENT_ID }))
    // 第二、三次过快:interval 保持 10,不累加到 15/20
    await store.fetch(makeRequest('/poll', { deviceCode: DEVICE_CODE, clientId: CLIENT_ID }))
    await store.fetch(makeRequest('/poll', { deviceCode: DEVICE_CODE, clientId: CLIENT_ID }))
    const updated = map.get(DEVICE_CODE) as { interval: number; slowDownCount: number }
    expect(updated.interval).toBe(10)
    expect(updated.slowDownCount).toBe(3)
  })

  it('slow_down 不更新 lastPollAt,保留上次合法 poll 作窗口锚点', async () => {
    const anchor = Date.now() - 1000
    map.set(DEVICE_CODE, makePendingEntry({ interval: 5, lastPollAt: anchor, slowDownCount: 0 }))
    await store.fetch(makeRequest('/poll', { deviceCode: DEVICE_CODE, clientId: CLIENT_ID }))
    const updated = map.get(DEVICE_CODE) as { lastPollAt: number }
    expect(updated.lastPollAt).toBe(anchor)
  })

  it('首次过快 +5s 受 30s 上限约束', async () => {
    const now = Date.now()
    map.set(DEVICE_CODE, makePendingEntry({ interval: 28, lastPollAt: now, slowDownCount: 0 }))
    await store.fetch(makeRequest('/poll', { deviceCode: DEVICE_CODE, clientId: CLIENT_ID }))
    const updated = map.get(DEVICE_CODE) as { interval: number }
    expect(updated.interval).toBe(30)
  })
})

// --- authorize -> poll approved ---

describe('DeviceFlowStore: authorize + poll approved', () => {
  beforeEach(setup)

  it('用户授权后 poll 返回 approved 并携带 userId 和 scopes', async () => {
    await store.fetch(makeRequest('/create', defaultCreateBody()))
    const authRes = await store.fetch(
      makeRequest('/authorize', { userCode: USER_CODE, userId: USER_ID }),
    )
    expect(authRes.status).toBe(200)
    const pollRes = await store.fetch(
      makeRequest('/poll', { deviceCode: DEVICE_CODE, clientId: CLIENT_ID }),
    )
    expect(pollRes.status).toBe(200)
    const pollBody = await pollRes.json<{ approved: boolean; userId: string; scopes: string[] }>()
    expect(pollBody.approved).toBe(true)
    expect(pollBody.userId).toBe(USER_ID)
    expect(pollBody.scopes).toEqual(SCOPES)
  })

  it('approved 后 poll 删除两个索引', async () => {
    await store.fetch(makeRequest('/create', defaultCreateBody()))
    await store.fetch(makeRequest('/authorize', { userCode: USER_CODE, userId: USER_ID }))
    await store.fetch(makeRequest('/poll', { deviceCode: DEVICE_CODE, clientId: CLIENT_ID }))
    expect(map.has(DEVICE_CODE)).toBe(false)
    expect(map.has(UC_KEY)).toBe(false)
  })

  it('approved 后再次 poll 返回 expired_token', async () => {
    await store.fetch(makeRequest('/create', defaultCreateBody()))
    await store.fetch(makeRequest('/authorize', { userCode: USER_CODE, userId: USER_ID }))
    await store.fetch(makeRequest('/poll', { deviceCode: DEVICE_CODE, clientId: CLIENT_ID }))
    const res2 = await store.fetch(
      makeRequest('/poll', { deviceCode: DEVICE_CODE, clientId: CLIENT_ID }),
    )
    expect((await res2.json<{ error: string }>()).error).toBe('expired_token')
  })
})

// --- deny -> poll access_denied ---

describe('DeviceFlowStore: deny + poll access_denied', () => {
  beforeEach(setup)

  it('用户拒绝后 poll 返回 access_denied', async () => {
    await store.fetch(makeRequest('/create', defaultCreateBody()))
    await store.fetch(makeRequest('/deny', { userCode: USER_CODE }))
    const res = await store.fetch(
      makeRequest('/poll', { deviceCode: DEVICE_CODE, clientId: CLIENT_ID }),
    )
    expect(res.status).toBe(400)
    expect((await res.json<{ error: string }>()).error).toBe('access_denied')
  })

  it('access_denied 后 poll 删除两个索引', async () => {
    await store.fetch(makeRequest('/create', defaultCreateBody()))
    await store.fetch(makeRequest('/deny', { userCode: USER_CODE }))
    await store.fetch(makeRequest('/poll', { deviceCode: DEVICE_CODE, clientId: CLIENT_ID }))
    expect(map.has(DEVICE_CODE)).toBe(false)
    expect(map.has(UC_KEY)).toBe(false)
  })
})

// --- user_code 大小写不敏感 ---

describe('DeviceFlowStore: user_code case insensitive', () => {
  beforeEach(setup)

  it('小写 user_code 与大写 user_code 对应同一授权', async () => {
    await store.fetch(makeRequest('/create', defaultCreateBody()))
    const res = await store.fetch(
      makeRequest('/authorize', { userCode: USER_CODE.toLowerCase(), userId: USER_ID }),
    )
    expect(res.status).toBe(200)
  })
})

// --- client 绑定 ---

describe('DeviceFlowStore: client binding', () => {
  beforeEach(setup)

  it('poll 时 clientId 与 device_code 绑定不一致返回 invalid_grant', async () => {
    await store.fetch(makeRequest('/create', defaultCreateBody()))
    const res = await store.fetch(
      makeRequest('/poll', { deviceCode: DEVICE_CODE, clientId: 'attacker_client' }),
    )
    expect(res.status).toBe(400)
    expect((await res.json<{ error: string }>()).error).toBe('invalid_grant')
  })

  it('缺少 clientId 的 poll 返回 invalid_request', async () => {
    await store.fetch(makeRequest('/create', defaultCreateBody()))
    const res = await store.fetch(makeRequest('/poll', { deviceCode: DEVICE_CODE }))
    expect(res.status).toBe(400)
    expect((await res.json<{ error: string }>()).error).toBe('invalid_request')
  })
})

// --- expired device_code ---

describe('DeviceFlowStore: expiry', () => {
  beforeEach(setup)

  it('poll 过期的 device_code 返回 expired_token 并清理', async () => {
    map.set(DEVICE_CODE, makePendingEntry({ expiresAt: Date.now() - 1000 }))
    const res = await store.fetch(
      makeRequest('/poll', { deviceCode: DEVICE_CODE, clientId: CLIENT_ID }),
    )
    expect((await res.json<{ error: string }>()).error).toBe('expired_token')
    expect(map.has(DEVICE_CODE)).toBe(false)
  })

  it('authorize 过期的 user_code 返回 expired_token', async () => {
    map.set(DEVICE_CODE, makePendingEntry({ expiresAt: Date.now() - 1000 }))
    map.set(UC_KEY, DEVICE_CODE)
    const res = await store.fetch(
      makeRequest('/authorize', { userCode: USER_CODE, userId: USER_ID }),
    )
    expect((await res.json<{ error: string }>()).error).toBe('expired_token')
  })
})

// --- 重复授权保护 ---

describe('DeviceFlowStore: double authorize protection', () => {
  beforeEach(setup)

  it('已 approved 状态不允许再次 authorize', async () => {
    await store.fetch(makeRequest('/create', defaultCreateBody()))
    await store.fetch(makeRequest('/authorize', { userCode: USER_CODE, userId: USER_ID }))
    const res2 = await store.fetch(
      makeRequest('/authorize', { userCode: USER_CODE, userId: 'other_user' }),
    )
    expect(res2.status).toBe(400)
    expect((await res2.json<{ error: string }>()).error).toBe('invalid_request')
  })
})

// --- HTTP 错误 ---

describe('DeviceFlowStore: HTTP errors', () => {
  beforeEach(setup)

  it('非 POST 方法返回 405', async () => {
    const res = await store.fetch(new Request('http://do/create', { method: 'GET' }))
    expect(res.status).toBe(405)
  })

  it('未知路径返回 404', async () => {
    const res = await store.fetch(makeRequest('/unknown', {}))
    expect(res.status).toBe(404)
  })
})
