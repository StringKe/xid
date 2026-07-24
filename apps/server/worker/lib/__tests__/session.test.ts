// session 辅助测试:issueSession 写 D1(存哈希,不存明文)+ SessionDO add + 设 cookie;
// readSession/readSessionById 走 cookie opaque token -> SHA-256 -> D1 -> SessionDO is-active。
// D1 与 SessionDO 用最小 fake;SHA-256 哈希用真实 Web Crypto(node 全局)。
// 见 05 章 8.2 / 8.4、cloudflare-bindings rule 会话存储。

import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { sha256Hex } from '@xid-kit/crypto'
import type { TenantContext } from '@xid-kit/types'
import { issueSession, readSession, readSessionById, revokeSession } from '../session'
import type { SessionData, XidHonoEnv } from '../types'

vi.mock('@xid-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xid-kit/db')>()
  return {
    ...actual,
    resolveTenantContextBySessionHash: vi.fn(),
  }
})

import { resolveTenantContextBySessionHash } from '@xid-kit/db'

// --- TenantContext 桩(只需 tenantId 驱动租户查询层) ---
const TENANT: TenantContext = {
  tenantId: 't_1',
  issuer: 'https://acme.example.test',
  rpId: 'acme.example.test',
  signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
  policy: {},
}

const ROOT_TENANT: TenantContext = {
  ...TENANT,
  tenantId: 'root_entry',
  issuer: 'https://xid.dev',
  rpId: 'xid.dev',
  resolution: { kind: 'instance_entry', primaryDomain: 'xid.dev', unresolvedRoot: true },
}

type SessionRow = {
  id: string
  tenant_id: string
  user_id: string
  refresh_token_hash: string
  active_org_id: string | null
  device_fingerprint_hash: string | null
  device_name: string | null
  user_agent: string | null
  ip: string | null
  location: string | null
  status: string
  remember_me: number
  is_impersonation: number
  impersonator_user_id: string | null
  acr?: string | null
  amr?: string | null
  aal?: number | null
  authenticated_at: number
  last_active_at: number
  expires_at: number
  created_at: number
}

type UserRow = {
  id: string
  tenant_id: string
  status: string
  deleted_at: number | null
}

type MembershipRow = {
  id: string
  tenant_id: string
  user_id: string
  org_id: string
  status: string
}

type OrganizationRow = {
  id: string
  tenant_id: string
  status: string
  deleted_at: number | null
}

type FakeTables = {
  sessions: SessionRow[]
  users: UserRow[]
  memberships?: MembershipRow[]
  organizations?: OrganizationRow[]
}

type FakeRow = SessionRow | UserRow | MembershipRow | OrganizationRow

// 用 unknown 转换避开 D1 generic 摩擦(测试桩,只实现被调用的方法)。
function asUnknown<T>(value: unknown): T {
  return value as T
}

// drizzle-d1 用 prepare().bind().raw() 取行,raw 返回"按 SQL 投影列顺序排列的值数组"。
// 从 SQL 抽取投影列(select 头部 或 returning 之后)的引号列名,据此把行对象映射成位置数组。
function projectionColumns(sql: string): string[] {
  const ret = /returning\s+(.+)$/i.exec(sql)
  const head = ret ? ret[1] : /^select\s+(.+?)\s+from\s/i.exec(sql)?.[1]
  if (!head) return []
  return [...head.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? '')
}

function rowToRaw(sql: string, row: FakeRow): unknown[] {
  const cols = projectionColumns(sql)
  const record = row as unknown as Record<string, unknown>
  return cols.map((c) => record[c] ?? null)
}

// --- 最小 D1 fake:按 SQL 关键字路由 insert/update/select,raw() 回位置数组 ---
function makeFakeD1(
  table: SessionRow[] | FakeTables,
  capture?: { insertParams: unknown[][] },
): D1Database {
  const tables: FakeTables = Array.isArray(table) ? { sessions: table, users: [] } : table
  const tableForSql = (sql: string): keyof FakeTables => {
    const lower = sql.toLowerCase()
    if (lower.includes('"users"')) return 'users'
    if (lower.includes('"memberships"')) return 'memberships'
    if (lower.includes('"organizations"')) return 'organizations'
    return 'sessions'
  }
  const matchRows = (sql: string, params: unknown[]): FakeRow[] => {
    const lower = sql.toLowerCase()
    const tableName = tableForSql(sql)
    const rows = tables[tableName] ?? []
    if (lower.startsWith('insert')) {
      capture?.insertParams.push(params)
      return rows.slice(-1)
    }
    if (lower.startsWith('update')) {
      // 按 SET 列名单 positional 应用参数;where 过滤沿用字符串参数启发式(同 select)。
      const setPart = /\bset\s+(.+?)\s+where\b/i.exec(sql)?.[1] ?? ''
      const setCols = [...setPart.matchAll(/"([a-z_]+)"\s*=\s*\?/g)].map((m) => m[1] ?? '')
      const setValues = params.slice(0, setCols.length)
      const whereStrings = params
        .slice(setCols.length)
        .filter((v): v is string => typeof v === 'string')
      for (const r of tables.sessions) {
        const values = Object.values(r as unknown as Record<string, unknown>)
        if (!whereStrings.every((v) => values.includes(v))) continue
        setCols.forEach((col, i) => {
          ;(r as unknown as Record<string, unknown>)[col] = setValues[i]
        })
      }
      return []
    }
    // 只用字符串绑定参数过滤(limit 等数值参数忽略);每个字符串参数必须命中某可匹配列。
    const stringParams = params.filter((v): v is string => typeof v === 'string')
    return rows.filter((r) => {
      const values = Object.values(r as unknown as Record<string, unknown>)
      const matchesStrings = stringParams.every((v) => values.includes(v))
      if (!matchesStrings) return false
      if ('deleted_at' in r && lower.includes('"users"."deleted_at" is null')) {
        return r.deleted_at === null
      }
      return true
    })
  }
  const prepare = (sql: string): unknown => {
    let bound: unknown[] = []
    const stmt = {
      bind: (...p: unknown[]) => {
        bound = p
        return stmt
      },
      raw: async () => matchRows(sql, bound).map((r) => rowToRaw(sql, r)),
      all: async () => ({ results: matchRows(sql, bound), success: true, meta: {} }),
      run: async () => ({ results: [], success: true, meta: {} }),
    }
    return stmt
  }
  return asUnknown<D1Database>({ prepare, batch: async () => [] })
}

function activeUser(id = 'u_1'): UserRow {
  return { id, tenant_id: 't_1', status: 'active', deleted_at: null }
}

function tenantUser(id: string, tenantId: string): UserRow {
  return { id, tenant_id: tenantId, status: 'active', deleted_at: null }
}

// --- SessionDO fake:记录 add/revoke,is-active 返回可控值 ---
function makeFakeSessionNs(opts: {
  active: boolean
  onCall?: (action: string, body: unknown) => void
  failOnceAction?: string
  generation?: number
  rejectAdd?: boolean
}): DurableObjectNamespace {
  const failed = new Set<string>()
  const stub = {
    fetch: async (url: string, init?: RequestInit) => {
      const action = new URL(url).pathname.replace(/^\//, '')
      const body = init?.body ? JSON.parse(init.body as string) : undefined
      opts.onCall?.(action, body)
      if (opts.failOnceAction === action && !failed.has(action)) {
        failed.add(action)
        const error = new Error('Network connection lost.') as Error & { retryable: boolean }
        error.retryable = true
        throw error
      }
      if (action === 'generation') return Response.json({ generation: opts.generation ?? 0 })
      if (action === 'add') {
        return Response.json({ ok: true, value: { accepted: opts.rejectAdd !== true } })
      }
      if (action === 'is-active') return Response.json({ active: opts.active })
      return Response.json({ ok: true, value: undefined })
    },
  }
  return asUnknown<DurableObjectNamespace>({ idFromName: (name: string) => name, get: () => stub })
}

function makeEnv(db: D1Database, ns: DurableObjectNamespace): Env {
  return asUnknown<Env>({ DB: db, SESSION_REVOCATION: ns })
}

// fire-and-forget 写(waitUntil 缺 ExecutionContext 时 void promise)全是微任务,宏任务一到即排干。
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const DAY_MS = 24 * 60 * 60 * 1000

function tenantWithSessionPolicy(session: TenantContext['policy']['session']): TenantContext {
  return { ...TENANT, policy: { session } }
}

// 在 Hono app 内执行 handler,拿到 Set-Cookie 与 handler 结果。
async function runWithContext<T>(
  env: Env,
  cookieHeader: string | undefined,
  handler: (c: Context<XidHonoEnv>) => Promise<T>,
  tenant: TenantContext = TENANT,
): Promise<{ result: T; setCookie: string | null }> {
  const app = new Hono<XidHonoEnv>()
  let captured: T
  app.get('/', async (c) => {
    c.set('tenant', tenant)
    captured = await handler(c)
    return c.json({ ok: true })
  })
  const headers: Record<string, string> = {}
  if (cookieHeader) headers.cookie = cookieHeader
  const res = await app.request('http://acme.example.test/', { headers }, env)
  return { result: captured!, setCookie: res.headers.get('set-cookie') }
}

describe('issueSession', () => {
  it('写 D1 存 refresh token 哈希(不存明文)+ SessionDO add + 设 __Host- cookie', async () => {
    const table: SessionRow[] = []
    const capture = { insertParams: [] as unknown[][] }
    const db = makeFakeD1(
      {
        sessions: table,
        users: [activeUser()],
        memberships: [
          { id: 'm_1', tenant_id: 't_1', user_id: 'u_1', org_id: 'o_1', status: 'active' },
        ],
        organizations: [{ id: 'o_1', tenant_id: 't_1', status: 'active', deleted_at: null }],
      },
      capture,
    )
    const calls: { action: string; body: unknown }[] = []
    const ns = makeFakeSessionNs({
      active: true,
      onCall: (action, body) => calls.push({ action, body }),
    })
    const env = makeEnv(db, ns)

    // insert returning() 由 fake 回 table 末行,预置一行供回读。
    const expiresAt = new Date(Date.now() + 3600_000)
    const authenticatedAt = new Date()

    const { result, setCookie } = await runWithContext(env, undefined, async (c) => {
      // 预置 returning 行(fake 取 table 末行)。
      table.push({
        id: 's_1',
        tenant_id: 't_1',
        user_id: 'u_1',
        refresh_token_hash: 'PLACEHOLDER',
        active_org_id: null,
        device_fingerprint_hash: null,
        device_name: null,
        user_agent: null,
        ip: null,
        location: null,
        status: 'active',
        remember_me: 1,
        is_impersonation: 0,
        impersonator_user_id: null,
        acr: 'urn:xid:aal1',
        amr: JSON.stringify(['pwd']),
        aal: 1,
        authenticated_at: authenticatedAt.getTime(),
        last_active_at: Date.now(),
        expires_at: expiresAt.getTime(),
        created_at: Date.now(),
      })
      return issueSession(c, {
        sessionId: 's_1',
        userId: 'u_1',
        authenticatedAt,
        expiresAt,
        rememberMe: true,
        authContext: { acr: 'urn:xid:aal1', amr: ['pwd'], aal: 1 },
      })
    })

    // refresh token 明文进 cookie。
    const cookie = setCookie ?? ''
    expect(cookie).toContain('__Host-xid.rt.s_1=')
    expect(cookie).toContain('Max-Age=2592000')
    const tokenMatch = cookie.match(/__Host-xid\.rt\.s_1=([^;]+)/)
    const plaintext = tokenMatch?.[1] ?? ''
    expect(plaintext.length).toBeGreaterThan(0)

    // 写入 D1 的是哈希,不是明文(枚举防护 + DB 泄露防重放)。
    const expectedHash = await sha256Hex(plaintext)
    const insertParams = capture.insertParams[0] ?? []
    expect(insertParams).toContain(expectedHash)
    expect(insertParams).not.toContain(plaintext)
    expect(insertParams).toContain('urn:xid:aal1')
    expect(insertParams).toContain(JSON.stringify(['pwd']))
    expect(insertParams).toContain(1)

    // SessionDO add 被调用,sessionId 正确。
    expect(calls).toEqual([
      { action: 'generation', body: undefined },
      { action: 'add', body: { sessionId: 's_1', expectedGeneration: 0 } },
    ])

    expect(result.session.sessionId).toBe('s_1')
    expect(result.session.userId).toBe('u_1')
    expect(insertParams).toContain('o_1')
    expect(result.session.acr).toBe('urn:xid:aal1')
    expect(result.session.amr).toEqual(['pwd'])
    expect(result.session.aal).toBe(1)
    expect(result.refreshToken).toBe(plaintext)
  })

  it('retries transient SessionDO add failures before issuing cookie', async () => {
    const table: SessionRow[] = []
    const db = makeFakeD1({ sessions: table, users: [activeUser()] })
    const calls: { action: string; body: unknown }[] = []
    const ns = makeFakeSessionNs({
      active: true,
      failOnceAction: 'add',
      onCall: (action, body) => calls.push({ action, body }),
    })
    const env = makeEnv(db, ns)
    const expiresAt = new Date(Date.now() + 3600_000)
    const authenticatedAt = new Date()

    const { result, setCookie } = await runWithContext(env, undefined, async (c) => {
      table.push({
        id: 's_retry',
        tenant_id: 't_1',
        user_id: 'u_1',
        refresh_token_hash: 'PLACEHOLDER',
        active_org_id: null,
        device_fingerprint_hash: null,
        device_name: null,
        user_agent: null,
        ip: null,
        location: null,
        status: 'active',
        remember_me: 0,
        is_impersonation: 0,
        impersonator_user_id: null,
        authenticated_at: authenticatedAt.getTime(),
        last_active_at: Date.now(),
        expires_at: expiresAt.getTime(),
        created_at: Date.now(),
      })
      return issueSession(c, {
        sessionId: 's_retry',
        userId: 'u_1',
        authenticatedAt,
        expiresAt,
      })
    })

    expect(calls).toEqual([
      { action: 'generation', body: undefined },
      { action: 'add', body: { sessionId: 's_retry', expectedGeneration: 0 } },
      { action: 'add', body: { sessionId: 's_retry', expectedGeneration: 0 } },
    ])
    expect(setCookie ?? '').toContain('__Host-xid.rt.s_retry=')
    expect(result.session.sessionId).toBe('s_retry')
  })

  it('retries transient SessionDO generation failures before issuing a session', async () => {
    const table: SessionRow[] = []
    const db = makeFakeD1({ sessions: table, users: [activeUser()] })
    const calls: { action: string; body: unknown }[] = []
    const ns = makeFakeSessionNs({
      active: true,
      failOnceAction: 'generation',
      onCall: (action, body) => calls.push({ action, body }),
    })
    const env = makeEnv(db, ns)
    const authenticatedAt = new Date()
    const expiresAt = new Date(Date.now() + 3600_000)

    const { result, setCookie } = await runWithContext(env, undefined, async (c) => {
      table.push({
        id: 's_generation_retry',
        tenant_id: 't_1',
        user_id: 'u_1',
        refresh_token_hash: 'PLACEHOLDER',
        active_org_id: null,
        device_fingerprint_hash: null,
        device_name: null,
        user_agent: null,
        ip: null,
        location: null,
        status: 'active',
        remember_me: 0,
        is_impersonation: 0,
        impersonator_user_id: null,
        authenticated_at: authenticatedAt.getTime(),
        last_active_at: Date.now(),
        expires_at: expiresAt.getTime(),
        created_at: Date.now(),
      })
      return issueSession(c, {
        sessionId: 's_generation_retry',
        userId: 'u_1',
        authenticatedAt,
        expiresAt,
      })
    })

    expect(calls).toEqual([
      { action: 'generation', body: undefined },
      { action: 'generation', body: undefined },
      { action: 'add', body: { sessionId: 's_generation_retry', expectedGeneration: 0 } },
    ])
    expect(setCookie ?? '').toContain('__Host-xid.rt.s_genera=')
    expect(result.session.sessionId).toBe('s_generation_retry')
  })

  it('关联 user 已软删除时拒绝签发 session', async () => {
    const table: SessionRow[] = []
    const capture = { insertParams: [] as unknown[][] }
    const calls: { action: string; body: unknown }[] = []
    const env = makeEnv(
      makeFakeD1(
        { sessions: table, users: [{ ...activeUser(), deleted_at: Date.now() }] },
        capture,
      ),
      makeFakeSessionNs({
        active: true,
        onCall: (action, body) => calls.push({ action, body }),
      }),
    )

    const outcome = await runWithContext(env, undefined, (c) =>
      issueSession(c, {
        sessionId: 's_deleted',
        userId: 'u_1',
        authenticatedAt: new Date(),
        expiresAt: new Date(Date.now() + 3600_000),
      }),
    )

    expect(outcome.result).toBeUndefined()
    expect(outcome.setCookie).toBeNull()
    expect(capture.insertParams).toEqual([])
    expect(calls).toEqual([])
  })

  it('revoke-all 发生在 D1 写入和 DO add 之间时拒绝设 cookie', async () => {
    const table: SessionRow[] = [
      {
        id: 's_fenced',
        tenant_id: 't_1',
        user_id: 'u_1',
        refresh_token_hash: 'PLACEHOLDER',
        active_org_id: null,
        device_fingerprint_hash: null,
        device_name: null,
        user_agent: null,
        ip: null,
        location: null,
        status: 'active',
        remember_me: 0,
        is_impersonation: 0,
        impersonator_user_id: null,
        authenticated_at: Date.now(),
        last_active_at: Date.now(),
        expires_at: Date.now() + 3600_000,
        created_at: Date.now(),
      },
    ]
    const calls: { action: string; body: unknown }[] = []
    const env = makeEnv(
      makeFakeD1({ sessions: table, users: [activeUser()] }),
      makeFakeSessionNs({
        active: false,
        rejectAdd: true,
        onCall: (action, body) => calls.push({ action, body }),
      }),
    )

    const outcome = await runWithContext(env, undefined, (c) =>
      issueSession(c, {
        sessionId: 's_fenced',
        userId: 'u_1',
        authenticatedAt: new Date(),
        expiresAt: new Date(Date.now() + 3600_000),
      }),
    )

    expect(outcome.result).toBeUndefined()
    expect(outcome.setCookie).toBeNull()
    expect(table[0]?.status).toBe('revoked')
    expect(calls).toEqual([
      { action: 'generation', body: undefined },
      { action: 'add', body: { sessionId: 's_fenced', expectedGeneration: 0 } },
    ])
  })
})

describe('issueSession 策略 TTL', () => {
  function seedReturningRow(table: SessionRow[], overrides: Partial<SessionRow> = {}): void {
    table.push({
      id: 's_policy',
      tenant_id: 't_1',
      user_id: 'u_1',
      refresh_token_hash: 'PLACEHOLDER',
      active_org_id: null,
      device_fingerprint_hash: null,
      device_name: null,
      user_agent: null,
      ip: null,
      location: null,
      status: 'active',
      remember_me: 0,
      is_impersonation: 0,
      impersonator_user_id: null,
      authenticated_at: Date.now(),
      last_active_at: Date.now(),
      expires_at: Date.now() + DAY_MS,
      created_at: Date.now(),
      ...overrides,
    })
  }

  it('未传 expiresAt 按 policy.session.absoluteTimeoutDays 计算,cookie Max-Age 同源', async () => {
    const table: SessionRow[] = []
    const capture = { insertParams: [] as unknown[][] }
    const env = makeEnv(
      makeFakeD1({ sessions: table, users: [activeUser()] }, capture),
      makeFakeSessionNs({ active: true }),
    )
    const tenant = tenantWithSessionPolicy({ idleTimeoutMin: 60, absoluteTimeoutDays: 7 })
    const before = Date.now()

    const { setCookie } = await runWithContext(
      env,
      undefined,
      async (c) => {
        seedReturningRow(table)
        return issueSession(c, {
          sessionId: 's_policy',
          userId: 'u_1',
          authenticatedAt: new Date(),
          rememberMe: true,
        })
      },
      tenant,
    )

    const inserted = capture.insertParams[0] ?? []
    const expiresParam = inserted.find(
      (v): v is number =>
        typeof v === 'number' && v > before + 6 * DAY_MS && v < Date.now() + 8 * DAY_MS,
    )
    expect(expiresParam).toBeDefined()
    expect(setCookie ?? '').toContain('Max-Age=604800')
  })

  it('显式 expiresAt 覆盖策略默认(短期会话保留入口)', async () => {
    const table: SessionRow[] = []
    const capture = { insertParams: [] as unknown[][] }
    const env = makeEnv(
      makeFakeD1({ sessions: table, users: [activeUser()] }, capture),
      makeFakeSessionNs({ active: true }),
    )
    const explicit = new Date(Date.now() + 15 * 60 * 1000)

    const { setCookie } = await runWithContext(env, undefined, async (c) => {
      seedReturningRow(table)
      return issueSession(c, {
        sessionId: 's_policy',
        userId: 'u_1',
        authenticatedAt: new Date(),
        expiresAt: explicit,
        rememberMe: true,
      })
    })

    expect(capture.insertParams[0]).toContain(explicit.getTime())
    // cookie Max-Age 仍取策略 absolute(默认 30d),不随显式 expiresAt 缩。
    expect(setCookie ?? '').toContain('Max-Age=2592000')
  })
})

describe('idle 强制与滑动续期', () => {
  async function seedIdleRow(
    token: string,
    overrides: Partial<SessionRow> = {},
  ): Promise<SessionRow> {
    const hash = await sha256Hex(token)
    return {
      id: 's_idle',
      tenant_id: 't_1',
      user_id: 'u_1',
      refresh_token_hash: hash,
      active_org_id: null,
      device_fingerprint_hash: null,
      device_name: null,
      user_agent: null,
      ip: null,
      location: null,
      status: 'active',
      remember_me: 0,
      is_impersonation: 0,
      impersonator_user_id: null,
      authenticated_at: Date.now() - 10 * DAY_MS,
      last_active_at: Date.now(),
      expires_at: Date.now() + DAY_MS,
      created_at: Date.now(),
      ...overrides,
    }
  }

  it('readSessionById:idle 超阈值返回 null 并异步置 expired', async () => {
    const token = 'tok_idle_expired'
    const row = await seedIdleRow(token, { last_active_at: Date.now() - (4320 + 1) * 60_000 })
    const env = makeEnv(
      makeFakeD1({ sessions: [row], users: [activeUser()] }),
      makeFakeSessionNs({ active: true }),
    )

    const { result } = await runWithContext(env, `__Host-xid.rt.s_idle=${token}`, (c) =>
      readSessionById(c, 's_idle'),
    )

    expect(result).toBeNull()
    await flushAsync()
    expect(row.status).toBe('expired')
  })

  it('readSessionById:idle 未超阈值放行', async () => {
    const token = 'tok_idle_ok'
    const row = await seedIdleRow(token, { last_active_at: Date.now() - 5 * 60_000 })
    const env = makeEnv(
      makeFakeD1({ sessions: [row], users: [activeUser()] }),
      makeFakeSessionNs({ active: true }),
    )
    const tenant = tenantWithSessionPolicy({ idleTimeoutMin: 10, absoluteTimeoutDays: 30 })

    const { result } = await runWithContext(
      env,
      `__Host-xid.rt.s_idle=${token}`,
      (c) => readSessionById(c, 's_idle'),
      tenant,
    )

    expect((result as SessionData | null)?.sessionId).toBe('s_idle')
  })

  it('readSession 枚举路径:idle 超时跳过该 cookie 并置 expired', async () => {
    const token = 'tok_idle_enum'
    const row = await seedIdleRow(token, { last_active_at: Date.now() - (4320 + 1) * 60_000 })
    const env = makeEnv(
      makeFakeD1({ sessions: [row], users: [activeUser()] }),
      makeFakeSessionNs({ active: true }),
    )

    const { result } = await runWithContext(env, `__Host-xid.rt.s_idle=${token}`, (c) =>
      readSession(c),
    )

    expect(result).toBeNull()
    await flushAsync()
    expect(row.status).toBe('expired')
  })

  it('距上次活跃 <5min 不回写 lastActiveAt(节流)', async () => {
    const lastActive = Date.now() - 4 * 60_000
    const token = 'tok_touch_skip'
    const row = await seedIdleRow(token, { last_active_at: lastActive })
    const env = makeEnv(
      makeFakeD1({ sessions: [row], users: [activeUser()] }),
      makeFakeSessionNs({ active: true }),
    )

    const { result } = await runWithContext(env, `__Host-xid.rt.s_idle=${token}`, (c) =>
      readSessionById(c, 's_idle'),
    )

    expect(result).not.toBeNull()
    await flushAsync()
    expect(row.last_active_at).toBe(lastActive)
  })

  it('距上次活跃 >5min 回写 lastActiveAt(滑动续期)', async () => {
    const lastActive = Date.now() - 6 * 60_000
    const token = 'tok_touch_write'
    const row = await seedIdleRow(token, { last_active_at: lastActive })
    const env = makeEnv(
      makeFakeD1({ sessions: [row], users: [activeUser()] }),
      makeFakeSessionNs({ active: true }),
    )

    const { result } = await runWithContext(env, `__Host-xid.rt.s_idle=${token}`, (c) =>
      readSessionById(c, 's_idle'),
    )

    expect(result).not.toBeNull()
    await flushAsync()
    expect(row.last_active_at).toBeGreaterThan(lastActive)
  })
})

describe('readSessionById', () => {
  async function seedRow(token: string, overrides: Partial<SessionRow> = {}): Promise<SessionRow> {
    const hash = await sha256Hex(token)
    return {
      id: 's_1',
      tenant_id: 't_1',
      user_id: 'u_1',
      refresh_token_hash: hash,
      active_org_id: null,
      device_fingerprint_hash: null,
      device_name: null,
      user_agent: null,
      ip: null,
      location: null,
      status: 'active',
      remember_me: 0,
      is_impersonation: 0,
      impersonator_user_id: null,
      authenticated_at: Date.now() - 1000,
      last_active_at: Date.now(),
      expires_at: Date.now() + 3600_000,
      created_at: Date.now(),
      ...overrides,
    }
  }

  it('cookie token 哈希匹配 + active + 未过期 + DO is-active -> SessionData', async () => {
    const token = 'tok_valid'
    const row = await seedRow(token)
    const env = makeEnv(
      makeFakeD1({ sessions: [row], users: [activeUser()] }),
      makeFakeSessionNs({ active: true }),
    )
    const { result } = await runWithContext(env, `__Host-xid.rt.s_1=${token}`, (c) =>
      readSessionById(c, 's_1'),
    )
    const session = result as SessionData | null
    expect(session?.sessionId).toBe('s_1')
    expect(session?.userId).toBe('u_1')
  })

  it('读取 session 时保留 ACR/AMR/AAL auth context', async () => {
    const token = 'tok_auth_context'
    const row = await seedRow(token, {
      acr: 'urn:xid:aal2',
      amr: JSON.stringify(['pwd', 'otp', 'mfa']),
      aal: 2,
    })
    const env = makeEnv(
      makeFakeD1({ sessions: [row], users: [activeUser()] }),
      makeFakeSessionNs({ active: true }),
    )
    const { result } = await runWithContext(env, `__Host-xid.rt.s_1=${token}`, (c) =>
      readSessionById(c, 's_1'),
    )
    const session = result as SessionData | null
    expect(session?.acr).toBe('urn:xid:aal2')
    expect(session?.amr).toEqual(['pwd', 'otp', 'mfa'])
    expect(session?.aal).toBe(2)
  })

  it('无 cookie 返回 null', async () => {
    const row = await seedRow('tok')
    const env = makeEnv(
      makeFakeD1({ sessions: [row], users: [activeUser()] }),
      makeFakeSessionNs({ active: true }),
    )
    const { result } = await runWithContext(env, undefined, (c) => readSessionById(c, 's_1'))
    expect(result).toBeNull()
  })

  it('cookie token 哈希不匹配返回 null(枚举防护)', async () => {
    const row = await seedRow('real_token')
    const env = makeEnv(
      makeFakeD1({ sessions: [row], users: [activeUser()] }),
      makeFakeSessionNs({ active: true }),
    )
    const { result } = await runWithContext(env, '__Host-xid.rt.s_1=wrong_token', (c) =>
      readSessionById(c, 's_1'),
    )
    expect(result).toBeNull()
  })

  it('status 非 active 返回 null', async () => {
    const token = 'tok'
    const row = await seedRow(token, { status: 'revoked' })
    const env = makeEnv(
      makeFakeD1({ sessions: [row], users: [activeUser()] }),
      makeFakeSessionNs({ active: true }),
    )
    const { result } = await runWithContext(env, `__Host-xid.rt.s_1=${token}`, (c) =>
      readSessionById(c, 's_1'),
    )
    expect(result).toBeNull()
  })

  it('pending_mfa 默认不可读,但显式允许时可读', async () => {
    const token = 'tok_pending'
    const row = await seedRow(token, { status: 'pending_mfa' })
    const env = makeEnv(
      makeFakeD1({ sessions: [row], users: [activeUser()] }),
      makeFakeSessionNs({ active: true }),
    )

    const denied = await runWithContext(env, `__Host-xid.rt.s_1=${token}`, (c) =>
      readSessionById(c, 's_1'),
    )
    const allowed = await runWithContext(env, `__Host-xid.rt.s_1=${token}`, (c) =>
      readSessionById(c, 's_1', ['active', 'pending_mfa']),
    )

    expect(denied.result).toBeNull()
    expect((allowed.result as SessionData | null)?.status).toBe('pending_mfa')
  })

  it('已过期返回 null', async () => {
    const token = 'tok'
    const row = await seedRow(token, { expires_at: Date.now() - 1000 })
    const env = makeEnv(
      makeFakeD1({ sessions: [row], users: [activeUser()] }),
      makeFakeSessionNs({ active: true }),
    )
    const { result } = await runWithContext(env, `__Host-xid.rt.s_1=${token}`, (c) =>
      readSessionById(c, 's_1'),
    )
    expect(result).toBeNull()
  })

  it('DO is-active=false(已撤销)返回 null', async () => {
    const token = 'tok'
    const row = await seedRow(token)
    const env = makeEnv(
      makeFakeD1({ sessions: [row], users: [activeUser()] }),
      makeFakeSessionNs({ active: false }),
    )
    const { result } = await runWithContext(env, `__Host-xid.rt.s_1=${token}`, (c) =>
      readSessionById(c, 's_1'),
    )
    expect(result).toBeNull()
  })

  it('关联 user status 非 active 时返回 null', async () => {
    const token = 'tok_deleted_user_status'
    const row = await seedRow(token)
    const calls: { action: string; body: unknown }[] = []
    const env = makeEnv(
      makeFakeD1({
        sessions: [row],
        users: [{ ...activeUser(), status: 'deleted' }],
      }),
      makeFakeSessionNs({
        active: true,
        onCall: (action, body) => calls.push({ action, body }),
      }),
    )
    const { result } = await runWithContext(env, `__Host-xid.rt.s_1=${token}`, (c) =>
      readSessionById(c, 's_1'),
    )
    expect(result).toBeNull()
    expect(calls.some((x) => x.action === 'is-active')).toBe(false)
  })

  it('关联 user deleted_at 非空时返回 null', async () => {
    const token = 'tok_deleted_user_timestamp'
    const row = await seedRow(token)
    const env = makeEnv(
      makeFakeD1({
        sessions: [row],
        users: [{ ...activeUser(), deleted_at: Date.now() }],
      }),
      makeFakeSessionNs({ active: true }),
    )
    const { result } = await runWithContext(env, `__Host-xid.rt.s_1=${token}`, (c) =>
      readSessionById(c, 's_1'),
    )
    expect(result).toBeNull()
  })
})

describe('readSession (多 cookie 枚举)', () => {
  it('root instance entry resolves session tenant from refresh token hash', async () => {
    const token = 'tok_root_admin'
    const hash = await sha256Hex(token)
    const row: SessionRow = {
      id: 's_admin',
      tenant_id: 'tenant_admin',
      user_id: 'u_admin',
      refresh_token_hash: hash,
      active_org_id: null,
      device_fingerprint_hash: null,
      device_name: null,
      user_agent: null,
      ip: null,
      location: null,
      status: 'active',
      remember_me: 0,
      is_impersonation: 0,
      impersonator_user_id: null,
      authenticated_at: Date.now() - 1000,
      last_active_at: Date.now(),
      expires_at: Date.now() + 3600_000,
      created_at: Date.now(),
    }
    const resolvedTenant: TenantContext = { ...TENANT, tenantId: 'tenant_admin' }
    const resolvedSession = {
      id: 's_admin',
      tenantId: 'tenant_admin',
      userId: 'u_admin',
      refreshTokenHash: hash,
      activeOrgId: null,
      deviceFingerprintHash: null,
      deviceName: null,
      userAgent: null,
      ip: null,
      location: null,
      status: 'active',
      rememberMe: false,
      isImpersonation: false,
      impersonatorUserId: null,
      acr: null,
      amr: null,
      aal: null,
      authenticatedAt: new Date(row.authenticated_at),
      lastActiveAt: new Date(row.last_active_at),
      expiresAt: new Date(row.expires_at),
      createdAt: new Date(row.created_at),
    }
    vi.mocked(resolveTenantContextBySessionHash).mockResolvedValueOnce({
      ok: true,
      value: { status: 'resolved', tenant: resolvedTenant, session: resolvedSession },
    })
    const env = makeEnv(
      makeFakeD1({ sessions: [], users: [tenantUser('u_admin', 'tenant_admin')] }),
      makeFakeSessionNs({ active: true }),
    )

    const { result } = await runWithContext(
      env,
      `__Host-xid.rt.s_admin=${token}`,
      (c) => readSession(c),
      ROOT_TENANT,
    )

    expect(resolveTenantContextBySessionHash).toHaveBeenCalledWith(expect.any(Request), env, hash)
    const session = result as SessionData | null
    expect(session?.sessionId).toBe('s_admin')
    expect(session?.userId).toBe('u_admin')
  })

  it('从多个 __Host-xid.rt.* cookie 中返回首个有效 session', async () => {
    const token = 'tok_b'
    const hash = await sha256Hex(token)
    const row: SessionRow = {
      id: 's_2',
      tenant_id: 't_1',
      user_id: 'u_2',
      refresh_token_hash: hash,
      active_org_id: null,
      device_fingerprint_hash: null,
      device_name: null,
      user_agent: null,
      ip: null,
      location: null,
      status: 'active',
      remember_me: 0,
      is_impersonation: 0,
      impersonator_user_id: null,
      authenticated_at: Date.now() - 1000,
      last_active_at: Date.now(),
      expires_at: Date.now() + 3600_000,
      created_at: Date.now(),
    }
    const env = makeEnv(
      makeFakeD1({ sessions: [row], users: [activeUser('u_2')] }),
      makeFakeSessionNs({ active: true }),
    )
    const { result } = await runWithContext(
      env,
      `__Host-xid.rt.s_1=tok_unknown; __Host-xid.rt.s_2=${token}`,
      (c) => readSession(c),
    )
    expect((result as SessionData | null)?.userId).toBe('u_2')
  })

  it('跳过关联 user 已软删除的 cookie session', async () => {
    const token = 'tok_deleted'
    const hash = await sha256Hex(token)
    const row: SessionRow = {
      id: 's_deleted',
      tenant_id: 't_1',
      user_id: 'u_deleted',
      refresh_token_hash: hash,
      active_org_id: null,
      device_fingerprint_hash: null,
      device_name: null,
      user_agent: null,
      ip: null,
      location: null,
      status: 'active',
      remember_me: 0,
      is_impersonation: 0,
      impersonator_user_id: null,
      authenticated_at: Date.now() - 1000,
      last_active_at: Date.now(),
      expires_at: Date.now() + 3600_000,
      created_at: Date.now(),
    }
    const env = makeEnv(
      makeFakeD1({
        sessions: [row],
        users: [{ id: 'u_deleted', tenant_id: 't_1', status: 'deleted', deleted_at: Date.now() }],
      }),
      makeFakeSessionNs({ active: true }),
    )
    const { result } = await runWithContext(env, `__Host-xid.rt.s_deleted=${token}`, (c) =>
      readSession(c),
    )
    expect(result).toBeNull()
  })
})

describe('revokeSession', () => {
  it('调用 DO revoke + D1 update status=revoked + 清 cookie', async () => {
    const calls: { action: string; body: unknown }[] = []
    const env = makeEnv(
      makeFakeD1([]),
      makeFakeSessionNs({ active: true, onCall: (action, body) => calls.push({ action, body }) }),
    )
    const session: SessionData = {
      sessionId: 's_9',
      userId: 'u_9',
      status: 'active',
      activeOrgId: null,
      authenticatedAt: new Date(),
      lastActiveAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
      rememberMe: false,
      isImpersonation: false,
      impersonatorUserId: null,
      acr: null,
      amr: null,
      aal: null,
    }
    const { setCookie } = await runWithContext(env, undefined, async (c) => {
      await revokeSession(c, session)
      return null
    })
    expect(calls.some((x) => x.action === 'revoke')).toBe(true)
    expect(setCookie ?? '').toContain('__Host-xid.rt.s_9=;')
    expect(setCookie ?? '').toContain('Max-Age=0')
  })
})
