// OIDC 端点测试共享辅助:真实 ES256 签名密钥 + 已知 KEK 的 TenantContext / 最小 D1 / KV / DO fake。
// 不导出 vitest 断言,只导出 factory。D1 fake 按 SQL 关键字路由 select/insert/update,raw() 回位置数组。

import { generateTenantSigningKey } from '@xid-kit/crypto'
import type { TenantContext } from '@xid-kit/types'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { SessionData, XidHonoEnv } from '../../lib/types'

export type TestTenant = { ctx: TenantContext; kekB64: string }

// base64 标准编码(decodeKek 用 atob 解码)。
function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

// 构建带真实 active ES256 密钥 + 已知 KEK 的 TenantContext(loadActiveSigner 可解密签名)。
export async function buildTestTenant(): Promise<TestTenant> {
  const kekRaw = crypto.getRandomValues(new Uint8Array(32))
  const { material } = await generateTenantSigningKey({
    kid: 'kid-test',
    kekRaw,
    kekVersion: 1,
    alg: 'ES256',
    status: 'active',
  })
  const ctx: TenantContext = {
    tenantId: 't_1',
    issuer: 'https://acme.xid.dev',
    rpId: 'acme.xid.dev',
    signingKeys: { activeKid: 'kid-test', defaultAlg: 'ES256', keys: [material] },
    policy: {},
  }
  return { ctx, kekB64: toBase64(kekRaw) }
}

function asUnknown<T>(v: unknown): T {
  return v as T
}

// 从 SQL 投影列(select 头 或 returning 之后)抽列名,把行对象映射为位置数组。
function projectionColumns(sql: string): string[] {
  const ret = /returning\s+(.+)$/i.exec(sql)
  const head = ret ? ret[1] : /^select\s+(.+?)\s+from\s/i.exec(sql)?.[1]
  if (!head) return []
  return [...head.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? '')
}

function rowToRaw(sql: string, row: Record<string, unknown>): unknown[] {
  return projectionColumns(sql).map((c) => row[c] ?? null)
}

export type TableSet = {
  applications?: Record<string, unknown>[]
  authorization_codes?: Record<string, unknown>[]
  refresh_tokens?: Record<string, unknown>[]
  access_token_issuances?: Record<string, unknown>[]
  access_token_revocations?: Record<string, unknown>[]
  resource_servers?: Record<string, unknown>[]
  users?: Record<string, unknown>[]
  user_emails?: Record<string, unknown>[]
  user_phones?: Record<string, unknown>[]
  oauth_consents?: Record<string, unknown>[]
  organizations?: Record<string, unknown>[]
  memberships?: Record<string, unknown>[]
  projects?: Record<string, unknown>[]
  project_grants?: Record<string, unknown>[]
  user_grants?: Record<string, unknown>[]
  role_permissions?: Record<string, unknown>[]
  permissions?: Record<string, unknown>[]
  manager_assignments?: Record<string, unknown>[]
}

export type D1Capture = { inserts: { table: string; params: unknown[] }[]; updates: string[] }

function tableForSql(sql: string): keyof TableSet {
  const l = sql.toLowerCase()
  const insertTarget = /^\s*insert(?:\s+or\s+ignore)?\s+into\s+([a-z_]+)/iu.exec(sql)?.[1]
  if (insertTarget === 'refresh_tokens') return 'refresh_tokens'
  if (insertTarget === 'access_token_issuances') return 'access_token_issuances'
  if (insertTarget === 'access_token_revocations') return 'access_token_revocations'
  if (l.includes('access_token_issuances')) return 'access_token_issuances'
  if (l.includes('access_token_revocations')) return 'access_token_revocations'
  if (l.includes('authorization_codes')) return 'authorization_codes'
  if (l.includes('refresh_tokens')) return 'refresh_tokens'
  if (l.includes('resource_servers')) return 'resource_servers'
  if (l.includes('user_emails')) return 'user_emails'
  if (l.includes('user_phones')) return 'user_phones'
  if (l.includes('oauth_consents')) return 'oauth_consents'
  if (l.includes('memberships')) return 'memberships'
  if (l.includes('project_grants')) return 'project_grants'
  if (l.includes('role_permissions')) return 'role_permissions'
  if (l.includes('user_grants')) return 'user_grants'
  if (l.includes('permissions')) return 'permissions'
  if (l.includes('manager_assignments')) return 'manager_assignments'
  if (l.includes('organizations')) return 'organizations'
  if (l.includes('projects')) return 'projects'
  if (l.includes('users')) return 'users'
  return 'applications'
}

// 最小 D1 fake:按表名 + SQL 关键字路由;字符串绑定参数做相等过滤(任一列命中即匹配)。
export function makeFakeD1(tables: TableSet, capture?: D1Capture): D1Database {
  const get = (t: keyof TableSet): Record<string, unknown>[] => tables[t] ?? []
  const match = (sql: string, params: unknown[]): Record<string, unknown>[] => {
    const table = tableForSql(sql)
    const rows = get(table)
    const lower = sql.trimStart().toLowerCase()
    if (lower.startsWith('insert')) {
      capture?.inserts.push({ table, params })
      return rows.slice(-1)
    }
    if (lower.startsWith('update')) {
      capture?.updates.push(sql)
      return rows.slice(-1)
    }
    if (table === 'organizations' && lower.includes('"organizations"."id" in')) {
      const ids = new Set(
        params.filter((value): value is string => rows.some((row) => row['id'] === value)),
      )
      return rows.filter(
        (row) =>
          ids.has(String(row['id'])) && row['status'] === 'active' && row['deleted_at'] == null,
      )
    }
    const sp = params.filter((v): v is string => typeof v === 'string')
    return rows.filter((r) => {
      if (!sp.every((v) => Object.values(r).includes(v))) return false
      if (table === 'users' && lower.includes('"users"."deleted_at" is null')) {
        return r['deleted_at'] === null
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
      raw: async () => match(sql, bound).map((r) => rowToRaw(sql, r)),
      all: async () => ({ results: match(sql, bound), success: true, meta: {} }),
      run: async () => ({ results: match(sql, bound), success: true, meta: {} }),
    }
    return stmt
  }
  return asUnknown<D1Database>({
    prepare,
    batch: async (statements: D1PreparedStatement[]) =>
      Promise.all(statements.map(async (statement) => statement.run())),
  })
}

// 内存 KV fake(get json / put)。
export function makeFakeKv(): KVNamespace {
  const store = new Map<string, string>()
  return asUnknown<KVNamespace>({
    get: async (key: string, type?: string) => {
      const v = store.get(key)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
  })
}

// DO namespace fake:idFromName -> name;get -> stub.fetch 由 handler 控制。
export function makeFakeDoNs(
  handler: (path: string, body: unknown) => Response | Promise<Response>,
): DurableObjectNamespace {
  const stub = {
    fetch: async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname
      const body = init?.body ? JSON.parse(init.body as string) : undefined
      return handler(path, body)
    },
  }
  return asUnknown<DurableObjectNamespace>({ idFromName: (n: string) => n, get: () => stub })
}

export function makeStatefulFakeDoNs(): { ns: DurableObjectNamespace; stored: unknown[] } {
  const records = new Map<string, unknown>()
  const stored: unknown[] = []
  const ns = makeFakeDoNs((path, body) => {
    const parsed = (body ?? {}) as { state?: string }
    const state = parsed.state ?? ''
    if (path === '/store') {
      stored.push(body)
      records.set(state, body)
      return new Response(null, { status: 201 })
    }
    if (path === '/consume') {
      if (!records.has(state)) return new Response('{}', { status: 404 })
      const record = records.get(state)
      records.delete(state)
      return new Response(JSON.stringify({ record }), { status: 200 })
    }
    if (path === '/claim') {
      if (records.has(state)) return new Response('{}', { status: 409 })
      records.set(state, body)
      return new Response(null, { status: 201 })
    }
    return new Response('{}', { status: 404 })
  })
  return { ns, stored }
}

export type EnvOverrides = {
  ENVIRONMENT?: string
  DB?: D1Database
  CACHE?: KVNamespace
  KEK?: string
  PEPPER?: string
  AUDIT_QUEUE?: Queue
  OAUTH_STATE?: DurableObjectNamespace
  PAR_STORE?: DurableObjectNamespace
  DEVICE_FLOW?: DurableObjectNamespace
  SESSION_REVOCATION?: DurableObjectNamespace
  RATE_LIMITER?: DurableObjectNamespace
}

export function makeEnv(overrides: EnvOverrides): Env {
  return asUnknown<Env>({
    ENVIRONMENT: overrides.ENVIRONMENT ?? 'development',
    DB: overrides.DB,
    CACHE: overrides.CACHE,
    KEK: overrides.KEK,
    PEPPER: overrides.PEPPER,
    AUDIT_QUEUE: overrides.AUDIT_QUEUE ?? { send: async () => undefined },
    OAUTH_STATE: overrides.OAUTH_STATE ?? makeOauthStateNs(),
    PAR_STORE: overrides.PAR_STORE,
    DEVICE_FLOW: overrides.DEVICE_FLOW,
    SESSION_REVOCATION: overrides.SESSION_REVOCATION,
    RATE_LIMITER: overrides.RATE_LIMITER,
  })
}

// OAUTH_STATE DO fake:claim 首次 201,同 key 重放 409。
// 用于 private_key_jwt jti 一次性占用测试。
export function makeOauthStateNs(): DurableObjectNamespace {
  const seen = new Set<string>()
  const stub = {
    fetch: async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname
      const body = init?.body
        ? (JSON.parse(init.body as string) as { state: string })
        : { state: '' }
      if (path !== '/claim') return new Response('{}', { status: 404 })
      if (seen.has(body.state))
        return new Response(JSON.stringify({ code: 'replay_detected' }), { status: 409 })
      seen.add(body.state)
      return new Response(null, { status: 201 })
    },
  }
  return asUnknown<DurableObjectNamespace>({ idFromName: (n: string) => n, get: () => stub })
}

// 在 Hono app 内挂 tenant(+ 可选 session)中间件后执行 register 函数,返回可 .request 的 app。
export function makeApp(
  ctx: TenantContext,
  register: (app: Hono<XidHonoEnv>) => void,
  session: SessionData | null = null,
): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.use('*', async (c: Context<XidHonoEnv>, next) => {
    c.set('tenant', ctx)
    c.set('session', session)
    await next()
  })
  register(app)
  return app
}
