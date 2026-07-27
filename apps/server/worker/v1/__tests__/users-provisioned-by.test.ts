// /v1/users provisioned_by 过滤单测:
//   - ?provisioned_by=anonymous 只回 guest;不带过滤回全部本租户用户。
//   - 跨租户:他租户 guest 永不出现在列表(租户层注入 tenant_id,不泄露存在性)。
//   - 非法 provisioned_by(超长)-> 422 validation_failed。
// harness 对齐 v1/__tests__/isolation.test.ts:真实 @xid-kit/db 查询层 + 最小 D1 fake(字符串参数命中行值)。

import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { sha256Hex } from '@xid-kit/crypto'
import type { TenantContext } from '@xid-kit/types'
import type { XidHonoEnv } from '../../lib/types'
import { isAppError } from '../../lib/errors'
import { registerUsersRoutes } from '../users'

const TENANT: TenantContext = {
  tenantId: 't_1',
  issuer: 'https://acme.xid.dev',
  rpId: 'acme.xid.dev',
  signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
  policy: {},
}

function asUnknown<T>(v: unknown): T {
  return v as T
}

type Row = Record<string, unknown>

// 最小 D1 fake:按表名取行,全部字符串绑定参数命中行内某列值才算匹配(模拟 WHERE 收窄)。
function makeFakeD1(tables: { api_keys?: Row[]; users?: Row[] }): D1Database {
  const match = (sql: string, params: unknown[]): Row[] => {
    const rows = sql.includes('api_keys') ? (tables.api_keys ?? []) : (tables.users ?? [])
    let stringParams = params.filter((v): v is string => typeof v === 'string')
    // users 列表的 status <> 'deleted' 是排除语义,不是行值匹配。
    if (/"status"\s*<>\s*\?/i.test(sql)) {
      stringParams = stringParams.filter((v) => v !== 'deleted')
    }
    return rows.filter((row) => stringParams.every((v) => Object.values(row).includes(v)))
  }
  // drizzle d1 的 raw() 按 SQL 投影列顺序取值;mode:json 列需序列化回字符串(对齐 isolation.test.ts)。
  const projectionColumns = (sql: string): string[] => {
    const ret = /returning\s+(.+)$/i.exec(sql)
    const head = ret ? ret[1] : /^select\s+(.+?)\s+from\s/i.exec(sql)?.[1]
    if (!head) return []
    return [...head.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? '')
  }
  const rowToRaw = (sql: string, row: Row): unknown[] =>
    projectionColumns(sql).map((col) => {
      const value = row[col]
      if (Array.isArray(value)) return JSON.stringify(value)
      if (value && typeof value === 'object' && !(value instanceof Date)) {
        return JSON.stringify(value)
      }
      return value ?? null
    })
  const prepare = (sql: string): unknown => {
    let bound: unknown[] = []
    const stmt = {
      bind: (...p: unknown[]) => {
        bound = p
        return stmt
      },
      all: async () => ({ results: match(sql, bound), success: true, meta: {} }),
      first: async () => match(sql, bound)[0] ?? null,
      raw: async () => match(sql, bound).map((row) => rowToRaw(sql, row)),
      run: async () => ({ results: [], success: true, meta: {} }),
    }
    return stmt
  }
  return asUnknown<D1Database>({ prepare, batch: async () => [] })
}

function userRow(id: string, tenantId: string, provisionedBy: string): Row {
  return {
    id,
    tenant_id: tenantId,
    username: null,
    external_id: null,
    first_name: null,
    last_name: null,
    display_name: null,
    avatar_url: null,
    locale: null,
    timezone: null,
    public_metadata: '{}',
    private_metadata: '{}',
    unsafe_metadata: '{}',
    custom_attributes: '{}',
    status: 'active',
    password_change_required: 0,
    provisioned_by: provisionedBy,
    lockout_until: null,
    last_login_at: null,
    deleted_at: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
  }
}

async function makeApiKeyRow(tenantId: string): Promise<{ token: string; row: Row }> {
  const token = 'sk_live_guestfilter'
  return {
    token,
    row: {
      id: 'ak_1',
      tenant_id: tenantId,
      key_hash: await sha256Hex(token),
      scopes: ['*'],
      revoked_at: null,
      expires_at: null,
      created_at: 1_700_000_000_000,
    },
  }
}

function buildApp(): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.onError((err, c) => {
    if (isAppError(err)) return c.json({ code: err.code }, err.httpStatus as 400)
    return c.json({ code: 'server_error' }, 500)
  })
  app.use('*', async (c, next) => {
    c.set('tenant', TENANT)
    c.set('session', null)
    await next()
  })
  registerUsersRoutes(app)
  return app
}

describe('GET /v1/users?provisioned_by=', () => {
  async function setup() {
    const { token, row: apiKey } = await makeApiKeyRow('t_1')
    const db = makeFakeD1({
      api_keys: [apiKey],
      users: [
        userRow('u_guest', 't_1', 'anonymous'),
        userRow('u_pwd', 't_1', 'hosted_password'),
        userRow('u_other_tenant_guest', 't_other', 'anonymous'),
      ],
    })
    const env = asUnknown<Env>({ DB: db })
    const app = buildApp()
    const list = (query = '') =>
      app.request(
        `https://acme.xid.dev/v1/users${query}`,
        { headers: { Authorization: `Bearer ${token}` } },
        env,
      )
    return { list }
  }

  it('?provisioned_by=anonymous 只回本租户 guest', async () => {
    const { list } = await setup()
    const res = await list('?provisioned_by=anonymous')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((u) => u.id)).toEqual(['u_guest'])
  })

  it('不带过滤:回本租户全部用户,不含他租户 guest(不泄露存在性)', async () => {
    const { list } = await setup()
    const res = await list()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((u) => u.id).sort()).toEqual(['u_guest', 'u_pwd'])
  })

  it('provisioned_by 超长 -> 422 validation_failed', async () => {
    const { list } = await setup()
    const res = await list(`?provisioned_by=${'x'.repeat(65)}`)
    expect(res.status).toBe(422)
    expect((await res.json()) as { code?: string }).toMatchObject({ code: 'validation_failed' })
  })
})
