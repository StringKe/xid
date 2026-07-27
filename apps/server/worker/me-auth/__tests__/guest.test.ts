// /auth/guest 单测:先查后建 / GuestStore 去重(绑定续签 + 并发落败弃号)/ 裸请求建号补种 anonKey /
// 限流与 Turnstile / 每日铸造上限 / 跨租户(DO 实例名含 tenantId,B 租户绑定对 A 不可见)。
// harness 对齐 passwordless.test.ts:mock @xid-kit/db 查询层,DO/队列走 helpers fake。

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@xid-kit/db', () => ({
  createTenantDb: vi.fn(),
  USER_PROVISIONED_BY_ANONYMOUS: 'anonymous',
  schema: {
    users: { id: 'id', status: 'status', deletedAt: 'deletedAt' },
    sessions: { id: 'id', userId: 'userId' },
  },
}))

import { createTenantDb } from '@xid-kit/db'
import { registerSessionAuthRoutes } from '../index'
import { execCtx, makeApp, makeEnv, makeSession, makeTenant } from './helpers'

const ANON_COOKIE = '__Host-xid.anon=anon-x'

type GuestStoreBehavior = {
  lookupUserId?: string | null
  bindCreated?: boolean
  bindUserId?: string
  bindFailStatus?: number
}

// stateful GuestStore fake:记录 idFromName 入参(断言 tenant 维度)与 bind 请求体,行为按用例配置。
function makeGuestStoreFake(behavior: GuestStoreBehavior = {}) {
  const names: string[] = []
  const bindBodies: Record<string, unknown>[] = []
  const ns = {
    idFromName: (name: string) => {
      names.push(name)
      return name as unknown as DurableObjectId
    },
    get: () =>
      ({
        fetch: async (url: string, init?: RequestInit) => {
          const action = new URL(url).pathname.replace(/^\//, '')
          if (action === 'lookup') {
            return behavior.lookupUserId
              ? Response.json({ userId: behavior.lookupUserId })
              : new Response('Not Found', { status: 404 })
          }
          if (action === 'unbind') return new Response(null, { status: 204 })
          if (behavior.bindFailStatus) {
            return new Response('DO failure', { status: behavior.bindFailStatus })
          }
          const body = JSON.parse(String(init?.body ?? '{}')) as {
            userId?: string
            ttlMs?: number
          }
          bindBodies.push(body)
          const created = behavior.bindCreated ?? true
          return Response.json({
            userId: created ? body.userId : (behavior.bindUserId ?? 'user-winner'),
            created,
          })
        },
      }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace
  return { ns, names, bindBodies }
}

function guestUserRow(id: string) {
  return { id, status: 'active', deletedAt: null, provisionedBy: 'anonymous' }
}

function sessionRow(userId: string) {
  const now = new Date()
  return {
    id: 'sess-new',
    userId,
    status: 'active',
    activeOrgId: null,
    authenticatedAt: now,
    lastActiveAt: now,
    expiresAt: new Date(now.getTime() + 86_400_000),
    rememberMe: false,
    isImpersonation: false,
    impersonatorUserId: null,
    acr: 'urn:xid:aal1',
    amr: ['guest'],
    aal: 1,
  }
}

// createTenantDb 返回值:findOne 的应答按用例注入(默认找不到 user)。
function makeDb(options: { findOne?: ReturnType<typeof vi.fn> } = {}) {
  return {
    users: {
      findOne: options.findOne ?? vi.fn().mockResolvedValue(null),
      insert: vi.fn().mockImplementation((row: Record<string, unknown>) => Promise.resolve(row)),
      update: vi.fn().mockResolvedValue([]),
    },
    sessions: {
      insert: vi
        .fn()
        .mockImplementation((row: { userId: string }) => Promise.resolve(sessionRow(row.userId))),
      update: vi.fn().mockResolvedValue([]),
    },
  }
}

function post(
  app: ReturnType<typeof makeApp>,
  env: Env,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(
    'https://tenant-1.xid.dev/auth/guest',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
    execCtx,
  )
}

describe('POST /auth/guest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('裸请求建号:insert anonymous user + 签发 amr 含 guest 的 session + 补种 anonKey cookie + guest.created 审计', async () => {
    const db = makeDb({ findOne: vi.fn().mockResolvedValue(guestUserRow('user-new')) })
    vi.mocked(createTenantDb).mockReturnValue(db as never)
    const auditSend = vi.fn()
    const env = makeEnv({ auditSend })
    const app = makeApp(registerSessionAuthRoutes)

    const res = await post(app, env, {})

    expect(res.status).toBe(200)
    const body = (await res.json()) as { sessionId?: string }
    expect(typeof body.sessionId).toBe('string')

    expect(db.users.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        provisionedBy: 'anonymous',
        status: 'active',
      }),
    )
    expect(db.sessions.insert).toHaveBeenCalledWith(
      expect.objectContaining({ amr: ['guest'], activeOrgId: null }),
    )
    const setCookies = res.headers.getSetCookie()
    expect(setCookies.some((cookie) => cookie.startsWith('__Host-xid.rt.'))).toBe(true)
    expect(setCookies.some((cookie) => cookie.startsWith('__Host-xid.anon='))).toBe(true)
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', action: 'guest.created' }),
    )
  })

  it('先查:已持有效 guest session -> 200 返回现有 sessionId,不建号、不绑定、不发审计', async () => {
    const db = makeDb({ findOne: vi.fn().mockResolvedValue(guestUserRow('user-guest')) })
    vi.mocked(createTenantDb).mockReturnValue(db as never)
    const auditSend = vi.fn()
    const guestStore = makeGuestStoreFake()
    const env = makeEnv({ auditSend, guestStoreNs: guestStore.ns })
    const app = makeApp(registerSessionAuthRoutes, {
      session: makeSession('user-guest', 'sess-guest'),
    })

    const res = await post(app, env, {}, { cookie: ANON_COOKIE })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      sessionId: 'sess-guest',
      redirectUrl: '/create-organization',
    })
    expect(db.users.insert).not.toHaveBeenCalled()
    expect(db.sessions.insert).not.toHaveBeenCalled()
    expect(guestStore.names).toHaveLength(0)
    expect(auditSend).not.toHaveBeenCalled()
  })

  it('已登录非 guest 用户(session provisioned_by 非 anonymous)-> 仍走建号路径', async () => {
    const db = makeDb({
      findOne: vi.fn().mockResolvedValue({
        id: 'user-regular',
        status: 'active',
        deletedAt: null,
        provisionedBy: 'hosted_password',
      }),
    })
    vi.mocked(createTenantDb).mockReturnValue(db as never)
    const env = makeEnv()
    const app = makeApp(registerSessionAuthRoutes, {
      session: makeSession('user-regular', 'sess-regular'),
    })

    const res = await post(app, env, {})

    expect(res.status).toBe(200)
    expect(db.users.insert).toHaveBeenCalledWith(
      expect.objectContaining({ provisionedBy: 'anonymous' }),
    )
  })

  it('anonKey 已绑定 live guest -> 不建号,对既有 user 续签新 session', async () => {
    const db = makeDb({ findOne: vi.fn().mockResolvedValue(guestUserRow('user-bound')) })
    vi.mocked(createTenantDb).mockReturnValue(db as never)
    const guestStore = makeGuestStoreFake({ lookupUserId: 'user-bound' })
    const env = makeEnv({ guestStoreNs: guestStore.ns })
    const app = makeApp(registerSessionAuthRoutes)

    const res = await post(app, env, {}, { cookie: ANON_COOKIE })

    expect(res.status).toBe(200)
    expect(db.users.insert).not.toHaveBeenCalled()
    expect(db.sessions.insert).toHaveBeenCalledWith(expect.objectContaining({ amr: ['guest'] }))
    expect(res.headers.getSetCookie().some((cookie) => cookie.startsWith('__Host-xid.rt.'))).toBe(
      true,
    )
  })

  it('并发落败:bind 返回 created=false -> 软删刚建用户,改用胜出绑定续签', async () => {
    const db = makeDb({ findOne: vi.fn().mockResolvedValue(guestUserRow('user-winner')) })
    vi.mocked(createTenantDb).mockReturnValue(db as never)
    const guestStore = makeGuestStoreFake({ bindCreated: false, bindUserId: 'user-winner' })
    const auditSend = vi.fn()
    const env = makeEnv({ guestStoreNs: guestStore.ns, auditSend })
    const app = makeApp(registerSessionAuthRoutes)

    const res = await post(app, env, {}, { cookie: ANON_COOKIE })

    expect(res.status).toBe(200)
    expect(db.users.insert).toHaveBeenCalled()
    expect(db.users.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'deleted', deletedAt: expect.any(Date) }),
      expect.anything(),
    )
    // 落败不算铸造成功:不发 guest.created。
    expect(auditSend).not.toHaveBeenCalled()
    expect(db.sessions.insert).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-winner' }),
    )
  })

  it('跨租户:DO 实例名带当前 tenantId,B 租户的 anonKey 绑定对 A 不可见', async () => {
    const db = makeDb({ findOne: vi.fn().mockResolvedValue(guestUserRow('user-new')) })
    vi.mocked(createTenantDb).mockReturnValue(db as never)
    const guestStore = makeGuestStoreFake()
    const env = makeEnv({ guestStoreNs: guestStore.ns })
    const app = makeApp(registerSessionAuthRoutes, {
      tenant: makeTenant('tenant-a') as never,
    })

    const res = await post(app, env, {}, { cookie: ANON_COOKIE })

    expect(res.status).toBe(200)
    expect(guestStore.names).toContain('tenant-a:anon-x')
    expect(guestStore.names.every((name) => name.startsWith('tenant-a:'))).toBe(true)
    expect(db.users.insert).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', provisionedBy: 'anonymous' }),
    )
    // 响应不携带任何既有账号标识(枚举防护)。
    const text = JSON.stringify(await res.json())
    expect(text).not.toContain('user-bound')
  })

  it('RateLimitStore 拒绝 -> rate_limited', async () => {
    const db = makeDb()
    vi.mocked(createTenantDb).mockReturnValue(db as never)
    const env = makeEnv({ rateLimitAllowed: false })
    const app = makeApp(registerSessionAuthRoutes)

    const res = await post(app, env, {}, { 'cf-connecting-ip': '203.0.113.1' })

    expect(res.status).toBe(429)
    expect((await res.json()) as { code?: string }).toMatchObject({ code: 'rate_limited' })
    expect(db.users.insert).not.toHaveBeenCalled()
  })

  it('每日铸造上限:guest:mint 维度拒绝 -> rate_limited 且不建号', async () => {
    const db = makeDb()
    vi.mocked(createTenantDb).mockReturnValue(db as never)
    const mintDenyNs = {
      idFromName: (name: string) => name as unknown as DurableObjectId,
      get: () =>
        ({
          fetch: async (_url: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body ?? '{}')) as { key?: string }
            const allowed = !body.key?.startsWith('guest:mint:day:')
            return Response.json({ allowed, retryAfter: allowed ? 0 : 3600, count: 1 })
          },
        }) as unknown as DurableObjectStub,
    } as unknown as DurableObjectNamespace
    const env = makeEnv()
    ;(env as { RATE_LIMITER: DurableObjectNamespace }).RATE_LIMITER = mintDenyNs
    const app = makeApp(registerSessionAuthRoutes)

    const res = await post(app, env, {})

    expect(res.status).toBe(429)
    expect(db.users.insert).not.toHaveBeenCalled()
  })

  it('TURNSTILE_SECRET 配置后缺 token -> captcha_required', async () => {
    const db = makeDb()
    vi.mocked(createTenantDb).mockReturnValue(db as never)
    const env = makeEnv()
    ;(env as { TURNSTILE_SECRET?: string }).TURNSTILE_SECRET = 'turnstile-secret'
    const app = makeApp(registerSessionAuthRoutes)

    const res = await post(app, env, {})

    expect(res.status).toBe(401)
    expect((await res.json()) as { code?: string }).toMatchObject({ code: 'captcha_required' })
    expect(db.users.insert).not.toHaveBeenCalled()
  })

  it('bind 失败(DO 故障)-> 刚建用户软删不残留孤儿账号,错误上抛', async () => {
    const db = makeDb({ findOne: vi.fn().mockResolvedValue(null) })
    vi.mocked(createTenantDb).mockReturnValue(db as never)
    const guestStore = makeGuestStoreFake({ bindFailStatus: 500 })
    const env = makeEnv({ guestStoreNs: guestStore.ns })
    const app = makeApp(registerSessionAuthRoutes)

    const res = await post(app, env, {}, { cookie: ANON_COOKIE })

    expect(res.status).toBe(500)
    expect(db.users.insert).toHaveBeenCalled()
    expect(db.users.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'deleted', deletedAt: expect.any(Date) }),
      expect.anything(),
    )
    expect(db.sessions.insert).not.toHaveBeenCalled()
  })

  it('guest TTL 取自租户 session policy:bind ttlMs 与 anonKey cookie Max-Age 均按 absoluteTimeoutDays', async () => {
    const base = makeTenant('tenant-1')
    const tenant = {
      ...base,
      policy: {
        ...base.policy,
        session: { idleTimeoutMin: 4320, absoluteTimeoutDays: 7 },
      },
    }
    const db = makeDb({ findOne: vi.fn().mockResolvedValue(guestUserRow('user-new')) })
    vi.mocked(createTenantDb).mockReturnValue(db as never)
    const guestStore = makeGuestStoreFake()
    const env = makeEnv({ guestStoreNs: guestStore.ns })
    const app = makeApp(registerSessionAuthRoutes, { tenant: tenant as never })

    const res = await post(app, env, {}, { cookie: ANON_COOKIE })

    expect(res.status).toBe(200)
    expect(guestStore.bindBodies).toHaveLength(1)
    expect(guestStore.bindBodies[0]).toMatchObject({ ttlMs: 7 * 24 * 60 * 60 * 1000 })
  })

  it('guest TTL 取自租户 session policy:裸请求 anonKey cookie Max-Age 按 absoluteTimeoutDays', async () => {
    const base = makeTenant('tenant-1')
    const tenant = {
      ...base,
      policy: {
        ...base.policy,
        session: { idleTimeoutMin: 4320, absoluteTimeoutDays: 7 },
      },
    }
    const db = makeDb({ findOne: vi.fn().mockResolvedValue(guestUserRow('user-new')) })
    vi.mocked(createTenantDb).mockReturnValue(db as never)
    const env = makeEnv()
    const app = makeApp(registerSessionAuthRoutes, { tenant: tenant as never })

    const res = await post(app, env, {})

    expect(res.status).toBe(200)
    const anonCookie = res.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('__Host-xid.anon='))
    expect(anonCookie).toBeDefined()
    expect(anonCookie).toContain(`Max-Age=${7 * 24 * 60 * 60}`)
  })
})
