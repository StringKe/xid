// platform-console 越权与门控测试(契约冻结:cookie-session + instance_manager 门控,跨租户独立管理路径)。
// 覆盖每个 GET 端点:happy path(instance_manager 放行 + 响应形状)、cookie 缺失 401、
// 越权(org A 普通用户 session 无 instance_manager 分配 -> 403,不泄露存在性)。
// node 池无 Workers binding:用最小 D1 / KV / DO / Queue fake(按 SQL 关键字 + 字符串参数路由)。
// 见 tenant-isolation rule、cloudflare-bindings rule、testing rule。

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { sha256Hex } from '@xid-kit/crypto'
import type { TenantContext } from '@xid-kit/types'
import type { XidHonoEnv } from '../../lib/types'
import { rtCookieName } from '../../lib/cookies'
import { isAppError } from '../../lib/errors'
import { registerPlatformConsoleRoutes } from '../index'

const ADMIN_TENANT: TenantContext = {
  tenantId: 'org_admin',
  issuer: 'https://xid.dev',
  rpId: 'xid.dev',
  signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
  policy: {},
}

function asUnknown<T>(v: unknown): T {
  return v as T
}

type Rows = Record<string, unknown>[]
type TableSet = {
  sessions?: Rows
  manager_assignments?: Rows
  organizations?: Rows
  memberships?: Rows
  users?: Rows
  user_emails?: Rows
  audit_events?: Rows
  usage_daily?: Rows
  usage_monthly?: Rows
  instances?: Rows
  queue_dead_letters?: Rows
  organization_plans?: Rows
  organization_quotas?: Rows
  platform_audit_outbox?: Rows
}

function tableNameForSql(sql: string): keyof TableSet | 'unknown' {
  const l = sql.toLowerCase()
  const mutationTarget = /^\s*(?:update|delete\s+from|insert\s+into)\s+"?([a-z_]+)"?/u.exec(l)?.[1]
  if (
    mutationTarget &&
    [
      'sessions',
      'manager_assignments',
      'organizations',
      'memberships',
      'users',
      'user_emails',
      'audit_events',
      'usage_daily',
      'usage_monthly',
      'instances',
      'queue_dead_letters',
      'organization_plans',
      'organization_quotas',
      'platform_audit_outbox',
    ].includes(mutationTarget)
  ) {
    return mutationTarget as keyof TableSet
  }
  if (/^\s*insert\s+into\s+platform_audit_outbox\b/u.test(l)) {
    return 'platform_audit_outbox'
  }
  const from = /\bfrom\s+"?([a-z_]+)"?/i.exec(l)?.[1]
  if (from === 'memberships') return 'memberships'
  if (from === 'users') return 'users'
  if (from === 'organizations') return 'organizations'
  if (from === 'sessions') return 'sessions'
  if (from === 'manager_assignments') return 'manager_assignments'
  if (from === 'user_emails') return 'user_emails'
  if (from === 'audit_events') return 'audit_events'
  if (from === 'usage_daily') return 'usage_daily'
  if (from === 'usage_monthly') return 'usage_monthly'
  if (from === 'instances') return 'instances'
  if (from === 'queue_dead_letters') return 'queue_dead_letters'
  if (from === 'organization_plans') return 'organization_plans'
  if (from === 'organization_quotas') return 'organization_quotas'
  if (from === 'platform_audit_outbox') return 'platform_audit_outbox'
  // 顺序敏感:更具体的表名先判,避免 'users' 命中 'user_emails'。
  if (l.includes('memberships')) return 'memberships'
  if (l.includes('manager_assignments')) return 'manager_assignments'
  if (l.includes('user_emails')) return 'user_emails'
  if (l.includes('audit_events')) return 'audit_events'
  if (l.includes('usage_daily')) return 'usage_daily'
  if (l.includes('usage_monthly')) return 'usage_monthly'
  if (l.includes('instances')) return 'instances'
  if (l.includes('queue_dead_letters')) return 'queue_dead_letters'
  if (l.includes('organization_plans')) return 'organization_plans'
  if (l.includes('organization_quotas')) return 'organization_quotas'
  if (l.includes('platform_audit_outbox')) return 'platform_audit_outbox'
  if (l.includes('organizations')) return 'organizations'
  if (l.includes('sessions')) return 'sessions'
  if (l.includes('users')) return 'users'
  return 'unknown'
}

function isAggregateCount(sql: string): boolean {
  return /count\(/i.test(sql)
}

// 投影列名(drizzle d1 select 走 .raw() 返回值数组,需按投影顺序回值,见 isolation.test.ts 同款)。
function projectionColumns(sql: string): string[] {
  const ret = /returning\s+(.+)$/i.exec(sql)
  const head = ret ? ret[1] : /^select\s+(.+?)\s+from\s/i.exec(sql)?.[1]
  if (!head) return []
  return head
    .split(',')
    .map((segment) => {
      const matches = [...segment.matchAll(/"([a-z_]+)"/g)]
      return matches[matches.length - 1]?.[1] ?? ''
    })
    .filter((column) => column.length > 0)
}

// 行 -> 投影顺序的值数组(left-join 的他表列不在本行 -> null,形状测试可接受)。
function rowToRaw(sql: string, row: Record<string, unknown>): unknown[] {
  const cols = projectionColumns(sql)
  if (cols.length === 0) return Object.values(row)
  return cols.map((c) => row[c] ?? null)
}

function updateSetColumns(sql: string): string[] {
  const match = /^update\s+"?[a-z_]+"?\s+set\s+(.+?)\s+where\s/i.exec(sql.toLowerCase())
  const setClause = match?.[1]
  if (!setClause) return []
  return [...setClause.matchAll(/"?([a-z_]+)"?\s*=/g)].map((m) => m[1] ?? '')
}

function filterNoParamPredicates(sql: string, table: keyof TableSet | 'unknown', rows: Rows): Rows {
  const l = sql.toLowerCase()
  let filtered = rows
  if (table === 'users' && l.includes('"users"."deleted_at" is null')) {
    filtered = filtered.filter((r) => r['deleted_at'] === null)
  }
  if (table === 'users' && l.includes('"users"."status" <>')) {
    filtered = filtered.filter((r) => r['status'] !== 'deleted')
  }
  return filtered
}

function rowMatchesParam(row: Record<string, unknown>, sql: string, param: string): boolean {
  const l = sql.toLowerCase()
  if (param === 'deleted' && l.includes('"users"."status" <>')) return true
  if (param.startsWith('%') && param.endsWith('%')) {
    const needle = param.slice(1, -1).toLowerCase()
    return Object.values(row).some((value) =>
      typeof value === 'string' ? value.toLowerCase().includes(needle) : false,
    )
  }
  return Object.values(row).includes(param)
}

function groupedCountRows(sql: string, rows: Rows): unknown[][] | null {
  const l = sql.toLowerCase()
  if (!isAggregateCount(sql) || !l.includes('group by') || !l.includes('"tenant_id"')) return null
  const counts = new Map<unknown, number>()
  const distinctUsers = new Map<unknown, Set<unknown>>()
  for (const row of rows) {
    const tenantId = row['tenant_id']
    if (l.includes('count(distinct')) {
      const users = distinctUsers.get(tenantId) ?? new Set()
      users.add(row['user_id'])
      distinctUsers.set(tenantId, users)
      continue
    }
    counts.set(tenantId, (counts.get(tenantId) ?? 0) + 1)
  }
  if (l.includes('count(distinct')) {
    return [...distinctUsers.entries()].map(([tenantId, users]) => [tenantId, users.size])
  }
  return [...counts.entries()].map(([tenantId, value]) => [tenantId, value])
}

// 最小 D1 fake:按 from 主表取行;字符串绑定参数全部命中行内某列值才算匹配(模拟 WHERE 收窄)。
// drizzle d1 的 select 经 .raw() 返回值数组(见 drizzle-orm/d1 session values());count(*) 聚合回单值 [[N]]。
function makeFakeD1(tables: TableSet): D1Database {
  const get = (t: keyof TableSet | 'unknown'): Rows => (t === 'unknown' ? [] : (tables[t] ?? []))

  const match = (sql: string, params: unknown[], skipParams = 0): Rows => {
    const table = tableNameForSql(sql)
    let rows = filterNoParamPredicates(sql, table, get(table))
    // 旧 happy-path fixture 未声明邮箱状态；仅在门禁查询时补 verified primary，显式邮箱行仍优先。
    if (table === 'user_emails' && /"is_primary"\s*=\s*\?/i.test(sql)) {
      const explicitPrimaryUsers = new Set(
        rows.filter((row) => row['is_primary'] === 1).map((row) => row['user_id']),
      )
      const verifiedDefaults = get('users')
        .filter(
          (user) =>
            user['status'] === 'active' &&
            user['deleted_at'] == null &&
            !explicitPrimaryUsers.has(user['id']),
        )
        .map((user) => ({
          id: `email_${String(user['id'])}`,
          tenant_id: user['tenant_id'],
          user_id: user['id'],
          email: `${String(user['id'])}@example.test`,
          verified: 1,
          verification_status: 'verified',
          is_primary: 1,
          verified_at: Date.now(),
          created_at: Date.now(),
          updated_at: Date.now(),
        }))
      rows = [...rows, ...verifiedDefaults]
    }
    const predicateParams = params
      .slice(skipParams)
      .slice(0, sql.includes('mutation_audit_gate') ? -1 : undefined)
    const stringParams = predicateParams.filter((v): v is string => typeof v === 'string')
    return stringParams.length === 0
      ? rows
      : rows.filter((r) => stringParams.every((v) => rowMatchesParam(r, sql, v)))
  }

  const applyUpdate = (sql: string, params: unknown[]): Rows => {
    const cols = updateSetColumns(sql)
    const rows = match(sql, params, cols.length)
    for (const row of rows) {
      cols.forEach((col, i) => {
        row[col] = params[i]
      })
    }
    return rows
  }

  const applyInsert = (sql: string, params: unknown[]): number => {
    const table = tableNameForSql(sql)
    if (table === 'organization_plans') {
      const target = (tables.organization_plans ??= [])
      const tenantId = String(params[0])
      const row =
        target.find((candidate) => candidate['tenant_id'] === tenantId) ??
        (() => {
          const created: Record<string, unknown> = { tenant_id: tenantId }
          target.push(created)
          return created
        })()
      Object.assign(row, {
        plan: params[1],
        status: params[2],
        source: 'manual',
        trial_ends_at: params[3],
        effective_at: params[4],
        updated_by: params[5],
        created_at: row['created_at'] ?? params[6],
        updated_at: params[7],
      })
      return 1
    }
    if (table === 'organization_quotas') {
      const target = (tables.organization_quotas ??= [])
      const tenantId = String(params[0])
      const quotaKey = String(params[1])
      const row =
        target.find(
          (candidate) => candidate['tenant_id'] === tenantId && candidate['quota_key'] === quotaKey,
        ) ??
        (() => {
          const created: Record<string, unknown> = {
            tenant_id: tenantId,
            quota_key: quotaKey,
          }
          target.push(created)
          return created
        })()
      Object.assign(row, {
        limit: params[2],
        enforcement: params[3],
        updated_by: params[4],
        created_at: row['created_at'] ?? params[5],
        updated_at: params[6],
      })
      return 1
    }
    if (table === 'platform_audit_outbox') {
      const target = (tables.platform_audit_outbox ??= [])
      target.push({
        id: params[0],
        tenant_id: params[1],
        org_id: params[2],
        action: params[3],
        actor_id: params[4],
        payload: params[5],
        status: 'pending',
      })
      return 1
    }
    return 1
  }

  const rawRows = (sql: string, params: unknown[]): unknown[][] => {
    const matched = sql.toLowerCase().startsWith('update')
      ? applyUpdate(sql, params)
      : match(sql, params)
    const grouped = groupedCountRows(sql, matched)
    if (grouped) return grouped
    if (isAggregateCount(sql)) return [[matched.length]]
    return matched.map((r) => rowToRaw(sql, r))
  }

  const prepare = (sql: string): unknown => {
    let bound: unknown[] = []
    const stmt = {
      bind: (...p: unknown[]) => {
        bound = p
        return stmt
      },
      raw: async () => rawRows(sql, bound),
      all: async () => ({ results: match(sql, bound), success: true, meta: {} }),
      run: async () => {
        const statementType = sql.trimStart().toLowerCase()
        const changes = statementType.startsWith('update')
          ? applyUpdate(sql, bound).length
          : statementType.startsWith('insert')
            ? applyInsert(sql, bound)
            : 0
        return { results: [], success: true, meta: { changes } }
      },
      first: async () => match(sql, bound)[0] ?? null,
    }
    return stmt
  }
  return asUnknown<D1Database>({
    prepare,
    batch: async (statements: D1PreparedStatement[]) =>
      Promise.all(statements.map((statement) => statement.run())),
  })
}

// SessionDO fake:is-active 永远 true(测试关注门控分支,非 DO 撤销逻辑)。
function makeFakeSessionNs(): DurableObjectNamespace {
  const stub = {
    fetch: async () => new Response(JSON.stringify({ active: true }), { status: 200 }),
  }
  return asUnknown<DurableObjectNamespace>({
    idFromName: (n: string) => n,
    get: () => stub,
  })
}

// KV fake:get 返回 null(flag 默认 false);list 返回空(无 tenant override)。
function makeFakeKv(): KVNamespace {
  const store = new Map<string, string>()
  return asUnknown<KVNamespace>({
    get: async (key: string) => store.get(key) ?? null,
    list: async (opts?: { prefix?: string }) => ({
      keys: [...store.keys()]
        .filter((name) => !opts?.prefix || name.startsWith(opts.prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    }),
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
  })
}

function makeFakeQueue(): Queue<unknown> {
  return asUnknown<Queue<unknown>>({ send: async () => undefined })
}

// 构造一条有效 session 行 + 对应 cookie token(refresh_token_hash 必须等于 sha256Hex(token))。
async function makeSessionRow(opts: {
  tenantId: string
  userId: string
}): Promise<{ token: string; cookieName: string; row: Record<string, unknown> }> {
  const sessionId = 'sess_abcdef0123456789'
  const token = 'rt_test_token_value_123'
  const row = {
    id: sessionId,
    tenant_id: opts.tenantId,
    user_id: opts.userId,
    refresh_token_hash: await sha256Hex(token),
    active_org_id: null,
    status: 'active',
    remember_me: 0,
    is_impersonation: 0,
    impersonator_user_id: null,
    authenticated_at: Date.now(),
    expires_at: Date.now() + 3_600_000,
  }
  return { token, cookieName: rtCookieName(sessionId), row }
}

function managerAssignmentRow(userId: string): Record<string, unknown> {
  return {
    id: 'mgr_1',
    tenant_id: 'org_admin',
    user_id: userId,
    manager_role: 'instance_manager',
    scope_type: 'instance',
    scope_id: null,
  }
}

function activeUserRow(userId: string, tenantId = 'org_admin'): Record<string, unknown> {
  return {
    id: userId,
    tenant_id: tenantId,
    status: 'active',
    deleted_at: null,
    created_at: Date.now(),
  }
}

// 测试用最小 onError:直读 AppError.code/httpStatus,避免引入 middleware/error 触发 lingui macro。
function buildApp(): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.onError((err, c) => {
    if (isAppError(err)) return c.json({ code: err.code }, err.httpStatus as 400)
    return c.json({ code: 'server_error' }, 500)
  })
  app.use('*', async (c: Context<XidHonoEnv>, next) => {
    c.set('tenant', ADMIN_TENANT)
    c.set('session', null)
    c.set('locale', asUnknown<XidHonoEnv['Variables']['locale']>('en'))
    await next()
  })
  registerPlatformConsoleRoutes(app)
  return app
}

function makeEnv(tables: TableSet): Env {
  return asUnknown<Env>({
    DB: makeFakeD1(tables),
    CACHE: makeFakeKv(),
    SESSION_REVOCATION: makeFakeSessionNs(),
    AUDIT_QUEUE: makeFakeQueue(),
  })
}

function reqInit(cookie?: { name: string; value: string }): RequestInit {
  return cookie ? { headers: { Cookie: `${cookie.name}=${cookie.value}` } } : {}
}

function jsonReqInit(
  body: Record<string, unknown>,
  cookie?: { name: string; value: string },
): RequestInit {
  return {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: `${cookie.name}=${cookie.value}` } : {}),
    },
    body: JSON.stringify(body),
  }
}

// 测试用 ExecutionContext fake:waitUntil 直接吞 promise(handler 的 GDPR 审计走 waitUntil)。
const execCtx = asUnknown<ExecutionContext>({
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
})

// 统一请求入口:始终传 env + execCtx(users 端点 GDPR 审计走 c.executionCtx.waitUntil)。
function doRequest(
  app: Hono<XidHonoEnv>,
  env: Env,
  path: string,
  cookie?: { name: string; value: string },
): Promise<Response> {
  return Promise.resolve(app.request(`https://xid.dev${path}`, reqInit(cookie), env, execCtx))
}

function doPatch(opts: {
  app: Hono<XidHonoEnv>
  env: Env
  path: string
  body: Record<string, unknown>
  cookie?: { name: string; value: string }
}): Promise<Response> {
  return Promise.resolve(
    opts.app.request(
      `https://xid.dev${opts.path}`,
      jsonReqInit(opts.body, opts.cookie),
      opts.env,
      execCtx,
    ),
  )
}

function doPost(
  app: Hono<XidHonoEnv>,
  env: Env,
  path: string,
  cookie?: { name: string; value: string },
): Promise<Response> {
  return Promise.resolve(
    app.request(
      `https://xid.dev${path}`,
      {
        method: 'POST',
        headers: cookie ? { Cookie: `${cookie.name}=${cookie.value}` } : undefined,
      },
      env,
      execCtx,
    ),
  )
}

const GET_ENDPOINTS = [
  '/v1/platform/stats',
  '/v1/platform/organizations',
  '/v1/platform/users?q=alice',
  '/v1/platform/audit-events',
  '/v1/platform/audit/verify?tenant_id=org_admin',
  '/v1/platform/billing',
  '/v1/platform/feature-flags',
  '/v1/platform/settings',
  '/v1/platform/dead-letters',
  '/v1/platform/plans/org_admin',
] as const

describe('platform-console 门控:cookie 缺失 -> 401 unauthorized', () => {
  for (const path of GET_ENDPOINTS) {
    it(`GET ${path} 无 session cookie -> 401`, async () => {
      const env = makeEnv({})
      const app = buildApp()
      const res = await doRequest(app, env, path)
      expect(res.status).toBe(401)
      const body = (await res.json()) as Record<string, unknown>
      expect(body['code']).toBe('unauthorized')
    })
  }
})

describe('platform-console 越权:org A 普通用户(无 instance_manager 分配)-> 403 forbidden,不泄露存在性', () => {
  for (const path of GET_ENDPOINTS) {
    it(`GET ${path} 有效 session 但非 instance_manager -> 403`, async () => {
      // session 在当前租户上下文(org_admin)内有效,readSession 通过;但 user_a 无 instance_manager 分配。
      const { token, cookieName, row } = await makeSessionRow({
        tenantId: 'org_admin',
        userId: 'user_a',
      })
      // manager_assignments 为空:user_a 非 instance_manager,门控拒绝。
      // 即使预置了 org_b 的数据,403 在数据访问前抛出,不泄露 org_b 资源存在性。
      const env = makeEnv({
        sessions: [row],
        organizations: [
          {
            id: 'org_b',
            tenant_id: 'org_b',
            parent_org_id: null,
            status: 'active',
            slug: 'beta',
            name: 'Beta',
            seat_used: 0,
            seat_limit: null,
            created_at: Date.now(),
          },
        ],
        users: [
          activeUserRow('user_a'),
          {
            id: 'user_b',
            tenant_id: 'org_b',
            status: 'active',
            deleted_at: null,
            created_at: Date.now(),
          },
        ],
      })
      const app = buildApp()
      const res = await doRequest(app, env, path, { name: cookieName, value: token })
      expect(res.status).toBe(403)
      const body = (await res.json()) as Record<string, unknown>
      expect(body['code']).toBe('forbidden')
    })
  }
})

describe('platform dead-letter replay authorization', () => {
  it('POST replay without a session is rejected before record lookup', async () => {
    const response = await doPost(
      buildApp(),
      makeEnv({ queue_dead_letters: [{ id: 'dlq_1' }] }),
      '/v1/platform/dead-letters/dlq_1/replay',
    )
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: 'unauthorized' })
  })

  it('POST replay rejects an organization user without instance_manager', async () => {
    const { token, cookieName, row } = await makeSessionRow({
      tenantId: 'org_admin',
      userId: 'user_a',
    })
    const response = await doPost(
      buildApp(),
      makeEnv({
        sessions: [row],
        users: [activeUserRow('user_a')],
        queue_dead_letters: [{ id: 'dlq_1' }],
      }),
      '/v1/platform/dead-letters/dlq_1/replay',
      { name: cookieName, value: token },
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'forbidden' })
  })
})

describe('platform-console happy path:instance_manager 放行 + 契约响应形状', () => {
  async function instanceManagerEnv(extra: TableSet): Promise<{
    env: Env
    cookie: { name: string; value: string }
  }> {
    const { token, cookieName, row } = await makeSessionRow({
      tenantId: 'org_admin',
      userId: 'user_mgr',
    })
    const env = makeEnv({
      sessions: [row],
      manager_assignments: [managerAssignmentRow('user_mgr')],
      users: [activeUserRow('user_mgr')],
      ...extra,
    })
    return { env, cookie: { name: cookieName, value: token } }
  }

  it('GET /v1/platform/stats -> 200 + PlatformStats 全字段', async () => {
    const now = Date.now()
    const { env, cookie } = await instanceManagerEnv({
      organizations: [
        {
          id: 'org_admin',
          tenant_id: 'org_admin',
          parent_org_id: null,
          status: 'active',
          slug: 'admin',
          name: 'Admin',
          created_at: now,
        },
      ],
      users: [
        {
          id: 'user_mgr',
          tenant_id: 'org_admin',
          status: 'active',
          deleted_at: null,
          created_at: now,
        },
        {
          id: 'user_deleted_status',
          tenant_id: 'org_admin',
          status: 'deleted',
          deleted_at: null,
          created_at: now,
        },
        {
          id: 'user_deleted_at',
          tenant_id: 'org_admin',
          status: 'active',
          deleted_at: now,
          created_at: now,
        },
      ],
    })
    const app = buildApp()
    const res = await doRequest(app, env, '/v1/platform/stats', cookie)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    for (const key of [
      'organizationCount',
      'totalUsers',
      'dau',
      'mau',
      'loginSuccessRate',
      'activeOrgCount',
    ]) {
      expect(body[key]).toBeTypeOf('number')
    }
    // 无登录审计事件 -> loginSuccessRate 默认 1。
    expect(body['loginSuccessRate']).toBe(1)
    expect(body['totalUsers']).toBe(1)
  })

  it('GET /v1/platform/organizations -> 200 + Page<OrganizationItem>(nextCursor + total)', async () => {
    const now = Date.now()
    const { env, cookie } = await instanceManagerEnv({
      organizations: [
        {
          id: 'org_admin',
          tenant_id: 'org_admin',
          parent_org_id: null,
          status: 'active',
          slug: 'admin',
          name: 'Admin',
          seat_used: 0,
          seat_limit: null,
          created_at: now,
        },
      ],
      users: [
        activeUserRow('user_mgr'),
        {
          id: 'user_deleted_status',
          tenant_id: 'org_admin',
          status: 'deleted',
          deleted_at: null,
          created_at: now,
        },
        {
          id: 'user_deleted_at',
          tenant_id: 'org_admin',
          status: 'active',
          deleted_at: now,
          created_at: now,
        },
      ],
    })
    const app = buildApp()
    const res = await doRequest(app, env, '/v1/platform/organizations', cookie)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(Array.isArray(body['data'])).toBe(true)
    expect('nextCursor' in body).toBe(true)
    expect(body['total']).toBeTypeOf('number')
    const data = body['data'] as Record<string, unknown>[]
    expect(data[0]?.['userCount']).toBe(1)
  })

  it('GET /v1/platform/users?q=alice -> 200 + Page<GlobalUser>', async () => {
    const { env, cookie } = await instanceManagerEnv({})
    const app = buildApp()
    const res = await doRequest(app, env, '/v1/platform/users?q=alice', cookie)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(Array.isArray(body['data'])).toBe(true)
    expect('nextCursor' in body).toBe(true)
    expect(body['total']).toBeTypeOf('number')
  })

  it('GET /v1/platform/users 过滤 soft deleted users', async () => {
    const now = Date.now()
    const { env, cookie } = await instanceManagerEnv({
      users: [
        activeUserRow('user_mgr'),
        {
          id: 'user_active_alice',
          tenant_id: 'org_a',
          status: 'active',
          deleted_at: null,
          display_name: 'Alice Active',
          first_name: 'Alice',
          last_name: 'Active',
          email: 'alice@example.com',
          name: 'Acme',
          created_at: now,
        },
        {
          id: 'user_deleted_status',
          tenant_id: 'org_a',
          status: 'deleted',
          deleted_at: null,
          display_name: 'Alice Deleted Status',
          first_name: 'Alice',
          last_name: 'Deleted',
          email: 'alice-deleted-status@example.com',
          name: 'Acme',
          created_at: now,
        },
        {
          id: 'user_deleted_at',
          tenant_id: 'org_a',
          status: 'active',
          deleted_at: now,
          display_name: 'Alice Deleted At',
          first_name: 'Alice',
          last_name: 'Deleted',
          email: 'alice-deleted-at@example.com',
          name: 'Acme',
          created_at: now,
        },
      ],
      memberships: [
        {
          user_id: 'user_active_alice',
          tenant_id: 'org_a',
          id: 'org_child_1',
          slug: 'alpha',
          name: 'Alpha',
          status: 'active',
          deleted_at: null,
        },
        {
          user_id: 'user_active_alice',
          tenant_id: 'org_a',
          id: 'org_child_2',
          slug: 'beta',
          name: 'Beta',
          status: 'active',
          deleted_at: null,
        },
        {
          user_id: 'user_active_alice',
          tenant_id: 'org_other',
          id: 'org_cross_tenant',
          slug: 'cross-tenant',
          name: 'Cross tenant',
          status: 'active',
          deleted_at: null,
        },
      ],
    })
    const app = buildApp()

    const res = await doRequest(app, env, '/v1/platform/users?q=alice', cookie)

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    const data = body['data'] as Record<string, unknown>[]
    expect(data.map((row) => row['id'])).toEqual(['user_active_alice'])
    expect(data[0]?.['organizations']).toEqual([
      { id: 'org_child_1', slug: 'alpha', name: 'Alpha' },
      { id: 'org_child_2', slug: 'beta', name: 'Beta' },
    ])
    expect(data[0]).not.toHaveProperty('organizationId')
    expect(body['total']).toBe(1)
  })

  it('GET /v1/platform/audit-events -> 200 + Page<AuditEvent>', async () => {
    const { env, cookie } = await instanceManagerEnv({})
    const app = buildApp()
    const res = await doRequest(app, env, '/v1/platform/audit-events', cookie)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(Array.isArray(body['data'])).toBe(true)
    expect('nextCursor' in body).toBe(true)
    expect(body['total']).toBeTypeOf('number')
  })

  it('GET /v1/platform/audit/verify -> 200 + empty valid chain contract', async () => {
    const { env, cookie } = await instanceManagerEnv({})
    const res = await doRequest(
      buildApp(),
      env,
      '/v1/platform/audit/verify?tenant_id=org_admin',
      cookie,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      tenant_id: 'org_admin',
      verified_range: { from: 1, to: 0 },
      chain_valid: true,
      broken_at_seq: null,
      failure_reason: null,
      record_count: 0,
    })
  })

  it('GET /v1/platform/audit/verify rejects an explicit non-empty range for an empty chain', async () => {
    const { env, cookie } = await instanceManagerEnv({})
    const res = await doRequest(
      buildApp(),
      env,
      '/v1/platform/audit/verify?tenant_id=org_admin&to_seq=1',
      cookie,
    )

    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({
      code: 'validation_failed',
    })
  })

  it('GET /v1/platform/dead-letters -> 200 + redacted Page<QueueDeadLetter>', async () => {
    const { env, cookie } = await instanceManagerEnv({
      queue_dead_letters: [
        {
          id: 'dlq_1',
          source_queue: 'xid-email',
          dead_letter_queue: 'xid-email-dlq',
          message_id: 'message_1',
          tenant_id: 'org_admin',
          org_id: null,
          event_type: 'verify_email',
          error_code: 'consumer_retries_exhausted',
          status: 'pending',
          attempts: 1,
          payload_iv: 'secret-iv',
          payload_ciphertext: 'secret-ciphertext',
          payload_tag: 'secret-tag',
          payload_kek_version: 1,
          source_enqueued_at: Date.now() - 1000,
          failed_at: Date.now(),
          replay_requested_at: null,
          replayed_at: null,
          replayed_by: null,
          replay_count: 0,
          last_replay_error_code: null,
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ],
    })
    const app = buildApp()
    const res = await doRequest(app, env, '/v1/platform/dead-letters', cookie)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(Array.isArray(body['data'])).toBe(true)
    expect('nextCursor' in body).toBe(true)
    expect(body['total']).toBeTypeOf('number')
    const serialized = JSON.stringify(body)
    expect(serialized).toContain('xid-email')
    expect(serialized).not.toContain('payloadCiphertext')
    expect(serialized).not.toContain('secret-ciphertext')
  })

  it('GET /v1/platform/billing -> 200 + Page<BillingOverview>', async () => {
    const { env, cookie } = await instanceManagerEnv({
      organizations: [
        {
          id: 'org_admin',
          tenant_id: 'org_admin',
          parent_org_id: null,
          status: 'active',
          slug: 'admin',
          name: 'Admin',
          seat_used: 3,
          seat_limit: 10,
          created_at: Date.now(),
        },
      ],
      organization_quotas: [
        {
          tenant_id: 'org_admin',
          quota_key: 'seats',
          limit: 2,
          enforcement: 'block_creation',
        },
      ],
      memberships: [
        {
          id: 'mem_1',
          tenant_id: 'org_admin',
          org_id: 'org_admin',
          user_id: 'user_a',
          status: 'active',
        },
        {
          id: 'mem_2',
          tenant_id: 'org_admin',
          org_id: 'org_child',
          user_id: 'user_a',
          status: 'active',
        },
        {
          id: 'mem_3',
          tenant_id: 'org_admin',
          org_id: 'org_child',
          user_id: 'user_b',
          status: 'active',
        },
        {
          id: 'mem_4',
          tenant_id: 'org_admin',
          org_id: 'org_admin',
          user_id: 'user_c',
          status: 'inactive',
        },
      ],
    })
    const app = buildApp()
    const res = await doRequest(app, env, '/v1/platform/billing', cookie)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(Array.isArray(body['data'])).toBe(true)
    expect('nextCursor' in body).toBe(true)
    expect(body['total']).toBeTypeOf('number')
    expect(body['data']).toEqual([
      expect.objectContaining({ organizationId: 'org_admin', seatUsed: 2, seatLimit: 2 }),
    ])
  })

  it('GET /v1/platform/plans/:tenantId -> 200 + default accounting label without feature gating', async () => {
    const { env, cookie } = await instanceManagerEnv({
      organizations: [
        {
          id: 'org_admin',
          tenant_id: 'org_admin',
          parent_org_id: null,
          status: 'active',
          slug: 'admin',
          name: 'Admin',
          seat_used: 1,
          seat_limit: null,
          created_at: Date.now(),
        },
      ],
    })
    const response = await doRequest(buildApp(), env, '/v1/platform/plans/org_admin', cookie)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      tenantId: 'org_admin',
      plan: 'free',
      status: 'active',
      supportLabel: 'community',
      seatLimit: null,
      quotas: [{ key: 'seats', limit: null, enforcement: 'block_creation' }],
    })
  })

  it('PATCH /v1/platform/plans/:tenantId atomically persists plan, seat, quota and audit outbox', async () => {
    const organization = {
      id: 'org_admin',
      tenant_id: 'org_admin',
      parent_org_id: null,
      status: 'active',
      slug: 'admin',
      name: 'Admin',
      seat_used: 1,
      seat_limit: null,
      created_at: Date.now(),
    }
    const tables: TableSet = {
      organizations: [organization],
      organization_plans: [],
      organization_quotas: [],
      platform_audit_outbox: [],
    }
    const { env, cookie } = await instanceManagerEnv(tables)
    const response = await doPatch({
      app: buildApp(),
      env,
      path: '/v1/platform/plans/org_admin',
      body: {
        plan: 'starter',
        status: 'trialing',
        seatLimit: 50,
        quotas: [{ key: 'api_calls', limit: 1_000_000, enforcement: 'observe' }],
      },
      cookie,
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      tenantId: 'org_admin',
      plan: 'starter',
      status: 'trialing',
      seatLimit: 50,
      quotas: expect.arrayContaining([
        { key: 'seats', limit: 50, enforcement: 'block_creation' },
        { key: 'api_calls', limit: 1_000_000, enforcement: 'observe' },
      ]),
    })
    expect(organization['seat_limit']).toBe(50)
    expect(tables.organization_plans).toHaveLength(1)
    expect(tables.organization_quotas).toHaveLength(2)
    expect(tables.platform_audit_outbox).toHaveLength(1)
  })

  it('PATCH plan-only applies the accounting label defaults without a license gate', async () => {
    const organization = {
      id: 'org_admin',
      tenant_id: 'org_admin',
      parent_org_id: null,
      status: 'active',
      slug: 'admin',
      name: 'Admin',
      seat_used: 1,
      seat_limit: null,
      created_at: Date.now(),
    }
    const { env, cookie } = await instanceManagerEnv({
      organizations: [organization],
      organization_plans: [],
      organization_quotas: [],
      platform_audit_outbox: [],
    })
    const response = await doPatch({
      app: buildApp(),
      env,
      path: '/v1/platform/plans/org_admin',
      body: { plan: 'pro' },
      cookie,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      plan: 'pro',
      supportLabel: 'priority',
      seatLimit: 250,
      quotas: expect.arrayContaining([
        { key: 'seats', limit: 250, enforcement: 'block_creation' },
        { key: 'api_calls', limit: 10_000_000, enforcement: 'observe' },
      ]),
    })
  })

  it.each(['api_calls', 'emails', 'mau'])(
    'PATCH rejects block_creation for observational quota %s',
    async (key) => {
      const { env, cookie } = await instanceManagerEnv({
        organizations: [
          {
            id: 'org_admin',
            tenant_id: 'org_admin',
            parent_org_id: null,
            status: 'active',
            slug: 'admin',
            name: 'Admin',
            seat_used: 1,
            seat_limit: null,
            created_at: Date.now(),
          },
        ],
        organization_plans: [],
        organization_quotas: [],
        platform_audit_outbox: [],
      })
      const response = await doPatch({
        app: buildApp(),
        env,
        path: '/v1/platform/plans/org_admin',
        body: { quotas: [{ key, limit: 1, enforcement: 'block_creation' }] },
        cookie,
      })

      expect(response.status).toBe(422)
    },
  )

  it('PATCH rejects an observational seats quota alias', async () => {
    const { env, cookie } = await instanceManagerEnv({
      organizations: [
        {
          id: 'org_admin',
          tenant_id: 'org_admin',
          parent_org_id: null,
          status: 'active',
          slug: 'admin',
          name: 'Admin',
          seat_used: 1,
          seat_limit: null,
          created_at: Date.now(),
        },
      ],
      organization_plans: [],
      organization_quotas: [],
      platform_audit_outbox: [],
    })
    const response = await doPatch({
      app: buildApp(),
      env,
      path: '/v1/platform/plans/org_admin',
      body: { quotas: [{ key: 'seats', limit: 10, enforcement: 'observe' }] },
      cookie,
    })

    expect(response.status).toBe(422)
  })

  it('PATCH rejects conflicting seatLimit and seats quota aliases', async () => {
    const { env, cookie } = await instanceManagerEnv({
      organizations: [
        {
          id: 'org_admin',
          tenant_id: 'org_admin',
          parent_org_id: null,
          status: 'active',
          slug: 'admin',
          name: 'Admin',
          seat_used: 1,
          seat_limit: null,
          created_at: Date.now(),
        },
      ],
      organization_plans: [],
      organization_quotas: [],
      platform_audit_outbox: [],
    })
    const response = await doPatch({
      app: buildApp(),
      env,
      path: '/v1/platform/plans/org_admin',
      body: {
        seatLimit: 10,
        quotas: [{ key: 'seats', limit: 20, enforcement: 'block_creation' }],
      },
      cookie,
    })

    expect(response.status).toBe(422)
  })

  it('GET /v1/platform/feature-flags -> 200 + FeatureFlag[](裸数组)', async () => {
    const { env, cookie } = await instanceManagerEnv({})
    const app = buildApp()
    const res = await doRequest(app, env, '/v1/platform/feature-flags', cookie)
    expect(res.status).toBe(200)
    const body = (await res.json()) as unknown[]
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThan(0)
    const first = body[0] as Record<string, unknown>
    for (const key of ['key', 'label', 'description', 'globalDefault', 'organizationOverrides']) {
      expect(key in first).toBe(true)
    }
  })

  it('PATCH /v1/platform/feature-flags/:key -> 200 + updates globalDefault in KV', async () => {
    const { env, cookie } = await instanceManagerEnv({})
    const app = buildApp()

    const res = await doPatch({
      app,
      env,
      path: '/v1/platform/feature-flags/passkey_autofill',
      body: { globalDefault: true },
      cookie,
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ key: 'passkey_autofill', globalDefault: true })
    expect(await env.CACHE.get('flag:global:passkey_autofill')).toBe('1')
  })

  it('PATCH /v1/platform/organizations/:organizationId -> 200 + updates top-level organization status', async () => {
    const row = {
      id: 'org_acme',
      tenant_id: 'org_acme',
      parent_org_id: null,
      status: 'active',
      slug: 'acme',
      name: 'Acme',
      seat_used: 0,
      seat_limit: null,
      deleted_at: null,
      created_at: Date.now(),
    }
    const { env, cookie } = await instanceManagerEnv({ organizations: [row] })
    const app = buildApp()

    const res = await doPatch({
      app,
      env,
      path: '/v1/platform/organizations/org_acme',
      body: { status: 'suspended' },
      cookie,
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ id: 'org_acme', status: 'suspended' })
    expect(row['status']).toBe('suspended')
  })

  it('PATCH /v1/platform/organizations/:organizationId rejects suspending default organization', async () => {
    const row = {
      id: 'org_admin',
      tenant_id: 'org_admin',
      parent_org_id: null,
      status: 'active',
      slug: 'default',
      name: 'Default Organization',
      seat_used: 0,
      seat_limit: null,
      deleted_at: null,
      created_at: Date.now(),
    }
    const { env, cookie } = await instanceManagerEnv({ organizations: [row] })
    const app = buildApp()

    const res = await doPatch({
      app,
      env,
      path: '/v1/platform/organizations/org_admin',
      body: { status: 'suspended' },
      cookie,
    })

    expect(res.status).toBe(409)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('conflict')
    expect(row['status']).toBe('active')
  })

  it('GET /v1/platform/settings -> 200 + instance defaults', async () => {
    const instanceRow = {
      id: 'inst_1',
      name: 'XID',
      primary_domain: 'xid.dev',
      mode: 'multi_tenant',
      default_locale: 'en',
      data_residency: 'us',
      mfa_policy: 'optional',
      password_policy: '{"min_length":12}',
      session_policy: '{"idle_timeout_min":30}',
      status: 'active',
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const { env, cookie } = await instanceManagerEnv({ instances: [instanceRow] })
    const app = buildApp()

    const res = await doRequest(app, env, '/v1/platform/settings', cookie)

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      id: 'inst_1',
      name: 'XID',
      defaultLocale: 'en',
      mfaPolicy: 'optional',
    })
  })

  it('PATCH /v1/platform/settings -> 200 + updates mfaPolicy', async () => {
    const instanceRow = {
      id: 'inst_1',
      name: 'XID',
      primary_domain: 'xid.dev',
      mode: 'multi_tenant',
      default_locale: 'en',
      data_residency: 'us',
      mfa_policy: 'optional',
      password_policy: '{}',
      session_policy: '{}',
      status: 'active',
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const { env, cookie } = await instanceManagerEnv({ instances: [instanceRow] })
    const app = buildApp()

    const res = await doPatch({
      app,
      env,
      path: '/v1/platform/settings',
      body: { mfaPolicy: 'required', defaultLocale: 'zh-Hans' },
      cookie,
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ mfaPolicy: 'required', defaultLocale: 'zh-Hans' })
    expect(instanceRow['mfa_policy']).toBe('required')
    expect(instanceRow['default_locale']).toBe('zh-Hans')
  })

  function makeSettingsInstanceRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'inst_1',
      name: 'XID',
      primary_domain: 'xid.dev',
      mode: 'multi_tenant',
      default_locale: 'en',
      data_residency: 'us',
      mfa_policy: 'optional',
      password_policy: '{}',
      session_policy: '{}',
      token_policy: null,
      status: 'active',
      created_at: Date.now(),
      updated_at: Date.now(),
      ...extra,
    }
  }

  it('GET /v1/platform/settings 返回 normalize 后的 camelCase sessionPolicy/tokenPolicy', async () => {
    const instanceRow = makeSettingsInstanceRow({
      session_policy:
        '{"idle_timeout_min":60,"absolute_timeout_days":14,"remember_me_default":true}',
      token_policy: '{"access_token_ttl_sec":300,"session_token_ttl_sec":45}',
    })
    const { env, cookie } = await instanceManagerEnv({ instances: [instanceRow] })
    const app = buildApp()

    const res = await doRequest(app, env, '/v1/platform/settings', cookie)

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['sessionPolicy']).toEqual({
      idleTimeoutMin: 60,
      absoluteTimeoutDays: 14,
      rememberMeDefault: true,
    })
    expect(body['tokenPolicy']).toEqual({
      accessTokenTtlSec: 300,
      sessionTokenTtlSec: 45,
      refreshIdleTimeoutDays: 30,
      refreshAbsoluteTimeoutDays: 7,
    })
  })

  it('PATCH /v1/platform/settings sessionPolicy 校验 BOUNDS 并 snake_case 落库', async () => {
    const instanceRow = makeSettingsInstanceRow({
      session_policy: '{"idle_timeout_min":120,"absolute_timeout_days":30}',
    })
    const { env, cookie } = await instanceManagerEnv({ instances: [instanceRow] })
    const app = buildApp()

    const res = await doPatch({
      app,
      env,
      path: '/v1/platform/settings',
      body: { sessionPolicy: { idleTimeoutMin: 60, rememberMeDefault: true } },
      cookie,
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['sessionPolicy']).toEqual({
      idleTimeoutMin: 60,
      absoluteTimeoutDays: 30,
      rememberMeDefault: true,
    })
    expect(JSON.parse(String(instanceRow['session_policy']))).toEqual({
      idle_timeout_min: 60,
      absolute_timeout_days: 30,
      remember_me_default: true,
    })
  })

  it('PATCH /v1/platform/settings sessionPolicy 越界 -> 422 paramName 精确到字段', async () => {
    const instanceRow = makeSettingsInstanceRow()
    const { env, cookie } = await instanceManagerEnv({ instances: [instanceRow] })
    const app = buildApp()

    const res = await doPatch({
      app,
      env,
      path: '/v1/platform/settings',
      body: { sessionPolicy: { idleTimeoutMin: 1 } },
      cookie,
    })

    expect(res.status).toBe(422)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('validation_failed')
    expect(instanceRow['session_policy']).toBe('{}')
  })

  it('PATCH /v1/platform/settings tokenPolicy 逐字段合并并 snake_case 落库', async () => {
    const instanceRow = makeSettingsInstanceRow({
      token_policy: '{"access_token_ttl_sec":600,"refresh_absolute_timeout_days":14}',
    })
    const { env, cookie } = await instanceManagerEnv({ instances: [instanceRow] })
    const app = buildApp()

    const res = await doPatch({
      app,
      env,
      path: '/v1/platform/settings',
      body: { tokenPolicy: { accessTokenTtlSec: 300 } },
      cookie,
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['tokenPolicy']).toEqual({
      accessTokenTtlSec: 300,
      sessionTokenTtlSec: 60,
      refreshIdleTimeoutDays: 30,
      refreshAbsoluteTimeoutDays: 14,
    })
    expect(JSON.parse(String(instanceRow['token_policy']))).toEqual({
      access_token_ttl_sec: 300,
      session_token_ttl_sec: 60,
      refresh_idle_timeout_days: 30,
      refresh_absolute_timeout_days: 14,
    })
  })

  it('PATCH /v1/platform/settings tokenPolicy 越界 -> 422', async () => {
    const instanceRow = makeSettingsInstanceRow()
    const { env, cookie } = await instanceManagerEnv({ instances: [instanceRow] })
    const app = buildApp()

    const res = await doPatch({
      app,
      env,
      path: '/v1/platform/settings',
      body: { tokenPolicy: { sessionTokenTtlSec: 10 } },
      cookie,
    })

    expect(res.status).toBe(422)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('validation_failed')
    expect(instanceRow['token_policy']).toBeNull()
  })

  it('PATCH /v1/platform/organizations/:organizationId rejects invalid status with paramName', async () => {
    const { env, cookie } = await instanceManagerEnv({})
    const app = buildApp()

    const res = await doPatch({
      app,
      env,
      path: '/v1/platform/organizations/org_admin',
      body: { status: 'paused' },
      cookie,
    })

    expect(res.status).toBe(422)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('validation_failed')
  })
})
