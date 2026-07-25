// Outbound SCIM sync 门控测试:POST /scim/outbound/:targetId/sync 全量推送(含 deactivation 写下游)
// 只允许 org admin/owner membership 或 org_manager assignment;普通 member -> 403。
// node 池无 Workers binding,用最小 D1 fake(字符串参数全命中行内某列才算匹配,同 v1 isolation 风格)。

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { TenantContext } from '@xid-kit/types'
import type { SessionData, XidHonoEnv } from '../../lib/types'
import { isAppError } from '../../lib/errors'
import { registerOutboundScimRoutes } from '../outbound'

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

type TableSet = Record<string, Record<string, unknown>[]>

function tableNameForSql(sql: string): string {
  const l = sql.toLowerCase()
  if (l.includes('scim_targets')) return 'scim_targets'
  if (l.includes('manager_assignments')) return 'manager_assignments'
  if (l.includes('memberships')) return 'memberships'
  if (l.includes('organizations')) return 'organizations'
  return 'unknown'
}

// SELECT 投影列(行对象 -> 位置数组;drizzle d1 走 raw() 按位置映射,顺序必须与查询字段一致)。
function projectionColumns(sql: string): string[] {
  const ret = /returning\s+(.+)$/i.exec(sql)
  const head = ret ? ret[1] : /^select\s+(.+?)\s+from\s/i.exec(sql)?.[1]
  if (!head) return []
  return [...head.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? '')
}

// 最小 D1 fake:SELECT 按表名取行,字符串绑定参数全部命中行内某列值才算匹配(模拟 WHERE 收窄)。
function makeFakeD1(tables: TableSet): D1Database {
  const match = (sql: string, params: unknown[]): Record<string, unknown>[] => {
    const rows = tables[tableNameForSql(sql)] ?? []
    const sp = params.filter((v): v is string => typeof v === 'string')
    if (sp.length === 0) return rows
    return rows.filter((r) => sp.every((v) => Object.values(r).includes(v)))
  }
  const prepare = (sql: string): unknown => {
    let bound: unknown[] = []
    const stmt = {
      bind: (...p: unknown[]) => {
        bound = p
        return stmt
      },
      all: async () => ({ results: match(sql, bound), success: true, meta: {} }),
      run: async () => ({ results: [], success: true, meta: {} }),
      first: async () => match(sql, bound)[0] ?? null,
      raw: async () =>
        match(sql, bound).map((r) => projectionColumns(sql).map((col) => r[col] ?? null)),
    }
    return stmt
  }
  return asUnknown<D1Database>({ prepare, batch: async () => [] })
}

function makeSession(userId: string): SessionData {
  return {
    sessionId: `sess_${userId}`,
    userId,
    status: 'active',
    activeOrgId: 'org_1',
    authenticatedAt: new Date(),
    lastActiveAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000),
    rememberMe: false,
    isImpersonation: false,
    impersonatorUserId: null,
    acr: null,
    amr: null,
    aal: null,
  }
}

function buildApp(session: SessionData | null): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.onError((err, c) => {
    if (isAppError(err)) return c.json({ code: err.code }, err.httpStatus as 400)
    return c.json({ code: 'server_error' }, 500)
  })
  app.use('*', async (c: Context<XidHonoEnv>, next) => {
    c.set('tenant', TENANT)
    c.set('session', session)
    await next()
  })
  registerOutboundScimRoutes(app)
  return app
}

function targetRow(): Record<string, unknown> {
  return {
    id: 'st_1',
    tenant_id: 't_1',
    org_id: 'org_1',
    provider: 'okta',
    base_url: 'https://downstream.example.com/scim',
    token_secret_ref: 'MISSING_SCIM_SECRET',
    user_filter: '{}',
    status: 'active',
  }
}

// organizations 的 public/private_metadata 是 text-json 列,drizzle 映射时 JSON.parse,缺省 undefined 会炸。
function orgRow(): Record<string, unknown> {
  return {
    id: 'org_1',
    tenant_id: 't_1',
    status: 'active',
    public_metadata: '{}',
    private_metadata: '{}',
  }
}

function membershipRow(role: string): Record<string, unknown> {
  return {
    id: 'mem_1',
    tenant_id: 't_1',
    org_id: 'org_1',
    user_id: 'user_1',
    role,
    status: 'active',
  }
}

function makeEnv(tables: TableSet): Env {
  return asUnknown<Env>({ DB: makeFakeD1(tables) })
}

function postSync(app: Hono<XidHonoEnv>, env: Env): Promise<Response> {
  return app.request('https://acme.xid.dev/scim/outbound/st_1/sync', { method: 'POST' }, env)
}

describe('outbound SCIM sync 门控', () => {
  it('无 session -> 401', async () => {
    const env = makeEnv({ scim_targets: [targetRow()] })
    const res = await postSync(buildApp(null), env)
    expect(res.status).toBe(401)
  })

  it('普通 member 触发全量推送 -> 403 forbidden', async () => {
    const env = makeEnv({
      scim_targets: [targetRow()],
      organizations: [orgRow()],
      memberships: [membershipRow('member')],
      manager_assignments: [],
    })
    const res = await postSync(buildApp(makeSession('user_1')), env)
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('forbidden')
  })

  it('org admin 通过门控(进入同步流程,缺下游 token secret -> 422 而非 403)', async () => {
    const env = makeEnv({
      scim_targets: [targetRow()],
      organizations: [orgRow()],
      memberships: [membershipRow('admin')],
      manager_assignments: [],
    })
    const res = await postSync(buildApp(makeSession('user_1')), env)
    expect(res.status).toBe(422)
  })

  it('org_manager assignment(无 membership)通过门控 -> 422 而非 403', async () => {
    const env = makeEnv({
      scim_targets: [targetRow()],
      organizations: [orgRow()],
      memberships: [],
      manager_assignments: [
        {
          id: 'ma_1',
          tenant_id: 't_1',
          user_id: 'user_1',
          manager_role: 'org_manager',
          scope_type: 'org',
          scope_id: 'org_1',
        },
      ],
    })
    const res = await postSync(buildApp(makeSession('user_1')), env)
    expect(res.status).toBe(422)
  })
})
