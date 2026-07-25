// SCIM 2.0 端点测试:Bearer token 鉴权、Users CRUD、Groups PATCH(含 unknown member)、deprovisioning 序列。
// 覆盖:authBearer hash+宽限期、PATCH 原子性 invalidSyntax/noTarget/mutability、unknown member pending 幂等、
// active=false deprovisioning 撤销 session DO 调用。
// node 池无 Workers binding,用 makeFakeD1 / makeFakeDoNs stub。

import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { sha256Hex } from '@xid-kit/crypto'
import type { TenantContext } from '@xid-kit/types'
import { registerScimRoutes } from '../index'
import type { XidHonoEnv } from '../../lib/types'
import { buildTestTenant, makeEnv, makeFakeDoNs, makeFakeKv } from '../../oidc/__tests__/helpers'
import {
  parsePatchOps,
  applyUserPatch,
  parseScimProjection,
  projectScimResource,
  parseScimFilter,
  evaluateScimFilter,
  getUserFilterValue,
  parseScimSort,
  parseScimPagination,
  SCIM_USER_SORT_ATTRS,
  SCIM_BULK_MAX_PAYLOAD_SIZE,
  buildVersion,
} from '../shared'

// --- 测试辅助 ---

function asUnknown<T>(v: unknown): T {
  return v as T
}

// 构建 scim_token_hash
async function makeTokenHash(token: string): Promise<string> {
  return sha256Hex(token)
}

// 简单 in-memory D1 fake for SCIM tables
type ScimTableSet = {
  directories?: Record<string, unknown>[]
  directory_users?: Record<string, unknown>[]
  directory_groups?: Record<string, unknown>[]
  directory_group_members?: Record<string, unknown>[]
  directory_pending_members?: Record<string, unknown>[]
  sessions?: Record<string, unknown>[]
  users?: Record<string, unknown>[]
}

function tableNameForSql(sql: string): string {
  const l = sql.toLowerCase()
  if (l.includes('directory_pending_members')) return 'directory_pending_members'
  if (l.includes('directory_group_members')) return 'directory_group_members'
  if (l.includes('directory_groups')) return 'directory_groups'
  if (l.includes('directory_users')) return 'directory_users'
  if (l.includes('directories')) return 'directories'
  if (l.includes('sessions')) return 'sessions'
  if (l.includes('"users"')) return 'users'
  return 'unknown'
}

// 从 SQL 投影列抽列名(SELECT head 或 RETURNING 之后),把行对象映射为位置数组(与 makeFakeD1 相同逻辑)
function projectionColumnsScim(sql: string): string[] {
  const ret = /returning\s+(.+)$/i.exec(sql)
  const head = ret ? ret[1] : /^select\s+(.+?)\s+from\s/i.exec(sql)?.[1]
  if (!head) return []
  return [...head.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? '')
}

function rowToRawScim(sql: string, row: Record<string, unknown>): unknown[] {
  return projectionColumnsScim(sql).map((c) => row[c] ?? null)
}

type ScimOrder = { column: string; descending: boolean }

function scimOrderBy(sql: string): ScimOrder[] {
  const clause = /order\s+by\s+(.+?)(?:\s+limit\s+\?|\s+offset\s+\?|\s*$)/i.exec(sql)?.[1]
  if (!clause) return []
  return [...clause.matchAll(/"[a-z_]+"\."([a-z_]+)"\s+(asc|desc)/gi)].map((match) => ({
    column: match[1] ?? '',
    descending: (match[2] ?? '').toLowerCase() === 'desc',
  }))
}

function compareScimValues(left: unknown, right: unknown): number {
  if (left === right) return 0
  if (left == null) return -1
  if (right == null) return 1
  if (left instanceof Date && right instanceof Date) return left.getTime() - right.getTime()
  if (typeof left === 'number' && typeof right === 'number') return left - right
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return Number(left) - Number(right)
  }
  return String(left).localeCompare(String(right))
}

function orderScimRows(sql: string, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const order = scimOrderBy(sql)
  if (order.length === 0) return rows
  return [...rows].sort((left, right) => {
    for (const item of order) {
      const comparison = compareScimValues(left[item.column], right[item.column])
      if (comparison !== 0) return item.descending ? -comparison : comparison
    }
    return 0
  })
}

function updateSetColumns(sql: string): string[] {
  const match = /^update\s+"?[a-z_]+"?\s+set\s+(.+?)\s+where\s/i.exec(sql.toLowerCase())
  const setClause = match?.[1]
  if (!setClause) return []
  return [...setClause.matchAll(/"([a-z_]+)"\s*=/g)].map((m) => m[1] ?? '')
}

function updatedAtMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  return null
}

function updatedAtValuesMatch(rowValue: unknown, guardValue: unknown): boolean {
  const rowMs = updatedAtMs(rowValue)
  const guardMs = updatedAtMs(guardValue)
  return rowMs !== null && guardMs !== null && rowMs === guardMs
}

function updatedAtGuardParam(
  sql: string,
  params: unknown[],
  setColCount: number,
): unknown | undefined {
  if (!/"updated_at"\s*=\s*\?/i.test(sql)) return undefined
  const wherePart = sql.split(/where\s/i)[1] ?? ''
  const beforeUpdatedAt = wherePart.split(/"updated_at"\s*=\s*\?/i)[0] ?? ''
  const placeholdersBefore = (beforeUpdatedAt.match(/\?/g) ?? []).length
  return params[setColCount + placeholdersBefore]
}

type ScimD1Options = {
  /** Simulate concurrent write: version guard passes in-memory but SQL update matches zero rows. */
  simulateVersionRaceOnUpdate?: boolean
}

function makeScimD1(
  tables: ScimTableSet,
  capture?: { inserts: Record<string, unknown>[]; updates: string[]; deletes?: string[] },
  options: ScimD1Options = {},
): D1Database {
  if (tables.directories) {
    for (const dir of tables.directories) {
      if (dir['status'] === undefined) dir['status'] = 'active'
    }
  }
  if (tables.directory_users) {
    for (const user of tables.directory_users) {
      if (user['status'] === undefined) user['status'] = 'active'
    }
  }
  if (tables.directory_groups) {
    for (const group of tables.directory_groups) {
      if (group['status'] === undefined) group['status'] = 'active'
    }
  }
  const get = (t: string): Record<string, unknown>[] =>
    (tables as Record<string, Record<string, unknown>[]>)[t] ?? []

  const match = (
    sql: string,
    params: unknown[],
    opts: { skipParams?: number } = {},
  ): Record<string, unknown>[] => {
    const t = tableNameForSql(sql)
    const rows = get(t)
    const lower = sql.toLowerCase()
    if (lower.startsWith('insert') || lower.startsWith('with')) {
      const newRow = { id: crypto.randomUUID() }
      if (capture) capture.inserts.push(newRow)
      return rows.slice(-1).length ? rows.slice(-1) : [newRow]
    }
    if (lower.startsWith('delete')) {
      capture?.deletes?.push(sql)
      return []
    }
    const activeParams = opts.skipParams ? params.slice(opts.skipParams) : params
    const hasStatusNotDeleted = /"status"\s*<>\s*\?/i.test(sql) && activeParams.includes('deleted')
    const sp = activeParams.filter(
      (v): v is string => typeof v === 'string' && !(hasStatusNotDeleted && v === 'deleted'),
    )
    const filtered =
      sp.length === 0
        ? rows
        : rows.filter((r) => {
            if (hasStatusNotDeleted && r['status'] === 'deleted') return false
            return sp.every((v) => Object.values(r).includes(v))
          })
    return orderScimRows(sql, filtered)
  }

  const applyUpdate = (sql: string, params: unknown[]): Record<string, unknown>[] => {
    if (capture) capture.updates.push(sql)
    const cols = updateSetColumns(sql)
    const guardValue = updatedAtGuardParam(sql, params, cols.length)
    let rows = match(sql, params, { skipParams: cols.length })
    if (guardValue !== undefined) {
      rows = rows.filter((row) => updatedAtValuesMatch(row['updated_at'], guardValue))
    }
    if (options.simulateVersionRaceOnUpdate && guardValue !== undefined && rows.length > 0) {
      return []
    }
    for (const row of rows) {
      cols.forEach((col, i) => {
        row[col] = params[i]
      })
    }
    return rows
  }

  const prepare = (sql: string): unknown => {
    let bound: unknown[] = []
    const stmt = {
      bind: (...p: unknown[]) => {
        bound = p
        return stmt
      },
      // raw() 供 Drizzle SELECT 走位置数组路径(与 makeFakeD1 一致)
      raw: async () => {
        const rows = sql.toLowerCase().startsWith('update')
          ? applyUpdate(sql, bound)
          : match(sql, bound)
        return rows.map((r) => rowToRawScim(sql, r))
      },
      all: async () => ({ results: match(sql, bound), success: true, meta: {} }),
      run: async () => {
        const rows = sql.toLowerCase().startsWith('update')
          ? applyUpdate(sql, bound)
          : match(sql, bound)
        return { results: rows, success: true, meta: {} }
      },
      first: async () => match(sql, bound)[0] ?? null,
    }
    return stmt
  }
  return asUnknown<D1Database>({ prepare, batch: async () => [] })
}

// 构建测试 app(挂 tenant stub + SCIM 路由)
function buildScimApp(ctx: TenantContext, env: Env): { app: Hono<XidHonoEnv>; env: Env } {
  const app = new Hono<XidHonoEnv>()
  app.use('*', async (c: Context<XidHonoEnv>, next) => {
    c.set('tenant', ctx)
    c.set('session', null)
    await next()
  })
  registerScimRoutes(app)
  return { app, env }
}

// --- 单元测试:parsePatchOps / applyUserPatch ---

describe('parsePatchOps', () => {
  it('解析合法 Operations 数组', () => {
    const ops = parsePatchOps([
      { op: 'replace', path: 'active', value: false },
      { op: 'Add', path: 'title', value: 'Engineer' },
    ])
    expect(ops).not.toBeNull()
    expect(ops?.[0]?.op).toBe('replace')
    expect(ops?.[1]?.op).toBe('add')
  })

  it('op 不合法返回 null', () => {
    const ops = parsePatchOps([{ op: 'invalid', path: 'active' }])
    expect(ops).toBeNull()
  })

  it('非数组返回 null', () => {
    expect(parsePatchOps(null)).toBeNull()
    expect(parsePatchOps('ops')).toBeNull()
  })
})

describe('applyUserPatch', () => {
  it('replace active=false', () => {
    const staged = { active: true, userName: 'alice' }
    const ops = [{ op: 'replace' as const, path: 'active', value: false }]
    const r = applyUserPatch(staged, ops)
    expect(r.ok).toBe(true)
    expect(staged['active']).toBe(false)
  })

  it('remove 不存在的属性幂等', () => {
    const staged = { userName: 'alice' }
    const ops = [{ op: 'remove' as const, path: 'title' }]
    const r = applyUserPatch(staged, ops)
    expect(r.ok).toBe(true)
  })

  it('remove 缺 path -> noTarget', () => {
    const staged = { userName: 'alice' }
    const ops = [{ op: 'remove' as const }]
    const r = applyUserPatch(staged, ops)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.scimType).toBe('noTarget')
  })

  it('修改 readOnly id -> mutability', () => {
    const staged = { userName: 'alice' }
    const ops = [{ op: 'replace' as const, path: 'id', value: 'new-id' }]
    const r = applyUserPatch(staged, ops)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.scimType).toBe('mutability')
  })

  it('无 path replace 批量替换属性', () => {
    const staged: Record<string, unknown> = { userName: 'alice', active: true }
    const ops = [{ op: 'replace' as const, value: { active: false, title: 'Manager' } }]
    const r = applyUserPatch(staged, ops)
    expect(r.ok).toBe(true)
    expect(staged['active']).toBe(false)
    expect(staged['title']).toBe('Manager')
  })
})

describe('parseScimFilter', () => {
  it('解析 AND/OR/NOT 与比较运算符', () => {
    const parsed = parseScimFilter(
      'userName eq "alice@example.com" and (active eq true or active eq false)',
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok || !parsed.expr) throw new Error('filter parse failed')
    expect(parsed.expr.kind).toBe('and')
  })

  it('拒绝非法 filter 表达式', () => {
    const parsed = parseScimFilter('emails.value co example.com')
    expect(parsed.ok).toBe(false)
    const unknownOp = parseScimFilter('userName unknown "alice"')
    expect(unknownOp.ok).toBe(false)
  })

  it('evaluateScimFilter 支持 co/sw 比较', () => {
    const parsed = parseScimFilter('userName sw "alice"')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok || !parsed.expr) throw new Error('filter parse failed')
    const row = {
      id: 'u1',
      tenantId: 't_1',
      directoryId: 'dir_1',
      userId: null,
      externalId: null,
      userName: 'alice@example.com',
      scimRaw: {},
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    expect(evaluateScimFilter(parsed.expr, row, getUserFilterValue)).toBe(true)
  })
})

describe('parseScimSort', () => {
  it('接受 userName sortBy', () => {
    const parsed = parseScimSort('userName', 'descending', SCIM_USER_SORT_ATTRS)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('sort parse failed')
    expect(parsed.sortBy).toBe('username')
    expect(parsed.sortOrder).toBe('descending')
  })

  it('拒绝未知 sortBy', () => {
    const parsed = parseScimSort('title', 'ascending', SCIM_USER_SORT_ATTRS)
    expect(parsed.ok).toBe(false)
  })

  it('sortOrder 无 sortBy -> 错误', () => {
    const parsed = parseScimSort(undefined, 'descending', SCIM_USER_SORT_ATTRS)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error('expected sort parse failure')
    expect(parsed.detail).toContain('sortOrder requires sortBy')
  })

  it('无效 sortOrder -> 错误', () => {
    const parsed = parseScimSort('userName', 'invalid', SCIM_USER_SORT_ATTRS)
    expect(parsed.ok).toBe(false)
  })
})

describe('parseScimPagination', () => {
  it('拒绝非数字 startIndex', () => {
    const parsed = parseScimPagination('abc', undefined)
    expect(parsed.ok).toBe(false)
  })

  it('拒绝非数字 count', () => {
    const parsed = parseScimPagination(undefined, 'xyz')
    expect(parsed.ok).toBe(false)
  })

  it('count 上限 100', () => {
    const parsed = parseScimPagination('1', '500')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('pagination parse failed')
    expect(parsed.count).toBe(100)
  })
})

describe('buildVersion', () => {
  it('null updatedAt 返回稳定 W/"0"', () => {
    expect(buildVersion(null)).toBe('W/"0"')
    expect(buildVersion(undefined)).toBe('W/"0"')
    expect(buildVersion(null)).toBe(buildVersion(undefined))
  })
})

describe('SCIM attributes projection', () => {
  it('attributes 只返回最小属性和请求属性', () => {
    const parsed = parseScimProjection(
      'userName,emails.value,urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department',
      undefined,
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('projection parse failed')

    const resource = {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      id: 'user_1',
      userName: 'alice@example.com',
      active: true,
      emails: [{ value: 'alice@example.com', primary: true }],
      'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': {
        department: 'Engineering',
        manager: { value: 'manager_1' },
      },
      meta: { resourceType: 'User' },
    }

    const projected = projectScimResource(resource, parsed.projection)
    expect(projected).toEqual({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      id: 'user_1',
      userName: 'alice@example.com',
      emails: [{ value: 'alice@example.com' }],
      'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': {
        department: 'Engineering',
      },
    })
  })

  it('excludedAttributes 删除请求属性但保留 schemas 和 id', () => {
    const parsed = parseScimProjection(undefined, 'emails,meta,id')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('projection parse failed')

    const projected = projectScimResource(
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        id: 'user_1',
        userName: 'alice@example.com',
        emails: [{ value: 'alice@example.com' }],
        meta: { resourceType: 'User' },
      },
      parsed.projection,
    )

    expect(projected).toEqual({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      id: 'user_1',
      userName: 'alice@example.com',
    })
  })

  it('attributes 和 excludedAttributes 同时存在 -> invalidValue', () => {
    const parsed = parseScimProjection('userName', 'emails')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error.scimType).toBe('invalidValue')
  })
})

// --- 集成测试:SCIM 路由 ---

describe('SCIM ServiceProviderConfig', () => {
  it('GET /scim/v2/ServiceProviderConfig -> 200', async () => {
    const { ctx } = await buildTestTenant()
    const env = makeEnv({ DB: makeScimD1({}), CACHE: makeFakeKv() })
    const { app } = buildScimApp(ctx, env)
    const res = await app.request('https://acme.xid.dev/scim/v2/ServiceProviderConfig', {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['schemas']).toContain('urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig')
    expect((body['patch'] as Record<string, unknown>)?.['supported']).toBe(true)
    expect((body['bulk'] as Record<string, unknown>)?.['supported']).toBe(true)
    expect((body['sort'] as Record<string, unknown>)?.['supported']).toBe(true)
    expect((body['etag'] as Record<string, unknown>)?.['supported']).toBe(true)
  })
})

describe('SCIM Schemas and ResourceTypes', () => {
  it('GET /Schemas includes enterprise user extension metadata', async () => {
    const { ctx } = await buildTestTenant()
    const env = makeEnv({ DB: makeScimD1({}), CACHE: makeFakeKv() })
    const { app } = buildScimApp(ctx, env)
    const res = await app.request('https://acme.xid.dev/scim/v2/Schemas', {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    const resources = body['Resources'] as Record<string, unknown>[]
    const enterprise = resources.find(
      (r) => r['id'] === 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User',
    )
    expect(enterprise).toBeDefined()
    expect(enterprise?.['name']).toBe('EnterpriseUser')
    const attrs = enterprise?.['attributes'] as Record<string, unknown>[]
    expect(attrs.some((a) => a['name'] === 'department')).toBe(true)
    expect(attrs.some((a) => a['name'] === 'manager')).toBe(true)
  })

  it('GET /ResourceTypes declares User schemaExtensions for enterprise user', async () => {
    const { ctx } = await buildTestTenant()
    const env = makeEnv({ DB: makeScimD1({}), CACHE: makeFakeKv() })
    const { app } = buildScimApp(ctx, env)
    const res = await app.request('https://acme.xid.dev/scim/v2/ResourceTypes', {}, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    const resources = body['Resources'] as Record<string, unknown>[]
    const userType = resources.find((r) => r['id'] === 'User')
    const extensions = userType?.['schemaExtensions'] as Record<string, unknown>[]
    expect(extensions).toContainEqual({
      schema: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User',
      required: false,
    })
  })
})

describe('SCIM Bearer token 鉴权', () => {
  it('无 token -> 401 WWW-Authenticate: Bearer', async () => {
    const { ctx } = await buildTestTenant()
    const token = 'scim_testtoken123'
    const hash = await makeTokenHash(token)
    const dir = {
      id: 'dir_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      provider: 'okta',
      scim_token_hash: hash,
      scim_token_hash_prev: null,
      scim_token_prev_expires: null,
      sync_status: 'idle',
      last_sync_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const env = makeEnv({ DB: makeScimD1({ directories: [dir] }), CACHE: makeFakeKv() })
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users',
      { method: 'GET' },
      env,
    )
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer')
  })

  it('错误 token -> 401', async () => {
    const { ctx } = await buildTestTenant()
    const token = 'scim_goodtoken'
    const hash = await makeTokenHash(token)
    const dir = {
      id: 'dir_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      provider: 'okta',
      scim_token_hash: hash,
      scim_token_hash_prev: null,
      scim_token_prev_expires: null,
      sync_status: 'idle',
      last_sync_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const env = makeEnv({ DB: makeScimD1({ directories: [dir] }), CACHE: makeFakeKv() })
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users',
      { method: 'GET', headers: { Authorization: 'Bearer scim_wrongtoken' } },
      env,
    )
    expect(res.status).toBe(401)
  })

  it('有效 token -> 200(Users list)', async () => {
    const { ctx } = await buildTestTenant()
    const token = 'scim_validtoken'
    const hash = await makeTokenHash(token)
    const dir = {
      id: 'dir_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      provider: 'okta',
      scim_token_hash: hash,
      scim_token_hash_prev: null,
      scim_token_prev_expires: null,
      sync_status: 'idle',
      last_sync_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const env = makeEnv({ DB: makeScimD1({ directories: [dir] }), CACHE: makeFakeKv() })
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['schemas']).toContain('urn:ietf:params:scim:api:messages:2.0:ListResponse')
  })

  it('deleted directory token -> 401', async () => {
    const { ctx } = await buildTestTenant()
    const token = 'scim_deletedtoken'
    const hash = await makeTokenHash(token)
    const dir = {
      id: 'dir_deleted',
      tenant_id: 't_1',
      org_id: 'org_1',
      provider: 'okta',
      scim_token_hash: hash,
      scim_token_hash_prev: null,
      scim_token_prev_expires: null,
      sync_status: 'disabled',
      status: 'deleted',
      last_sync_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const env = makeEnv({ DB: makeScimD1({ directories: [dir] }), CACHE: makeFakeKv() })
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(401)
  })
})

describe('SCIM Users CRUD', () => {
  async function makeUserEnv() {
    const { ctx } = await buildTestTenant()
    const token = 'scim_usertoken'
    const hash = await makeTokenHash(token)
    const dir = {
      id: 'dir_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      provider: 'okta',
      scim_token_hash: hash,
      scim_token_hash_prev: null,
      scim_token_prev_expires: null,
      sync_status: 'idle',
      last_sync_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const user = {
      id: 'user_scim_1',
      tenant_id: 't_1',
      directory_id: 'dir_1',
      user_id: 'xid_user_1',
      external_id: '701984',
      user_name: 'bjensen@example.com',
      scim_raw: JSON.stringify({
        userName: 'bjensen@example.com',
        active: true,
        title: 'Manager',
        emails: [{ value: 'bjensen@example.com', primary: true }],
        'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': {
          department: 'Engineering',
        },
      }),
      active: 1,
      status: 'active',
      deleted_at: null as number | null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const appUser = {
      id: 'xid_user_1',
      tenant_id: 't_1',
      status: 'active',
      deleted_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const db = makeScimD1({ directories: [dir], directory_users: [user], users: [appUser] })
    const sessionDoNs = makeFakeDoNs(() => new Response('{}', { status: 200 }))
    const env = makeEnv({ DB: db, CACHE: makeFakeKv(), SESSION_REVOCATION: sessionDoNs })
    return { ctx, token, env, user, appUser }
  }

  it('GET /Users/{id} 已有用户 -> 200 SCIM User 响应体', async () => {
    const { ctx, token, env } = await makeUserEnv()
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users/user_scim_1',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['schemas']).toContain('urn:ietf:params:scim:schemas:core:2.0:User')
    expect(body['id']).toBe('user_scim_1')
    expect(body['userName']).toBe('bjensen@example.com')
    expect(body['active']).toBe(true)
  })

  it('GET /Users/{id} 不存在 -> 404', async () => {
    const { ctx, token, env } = await makeUserEnv()
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users/no_such_user',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(404)
  })

  it('GET /Users 支持 userName eq filter', async () => {
    const { ctx, token, env } = await makeUserEnv()
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users?filter=userName%20eq%20%22bjensen%40example.com%22',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['totalResults']).toBe(1)
  })

  it('GET /Users 支持复杂 filter', async () => {
    const { ctx, token, env } = await makeUserEnv()
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users?filter=userName%20sw%20%22bjensen%22',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['totalResults']).toBe(1)
  })

  it('GET /Users 拒绝 unsupported filter', async () => {
    const { ctx, token, env } = await makeUserEnv()
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users?filter=userName%20unknown%20%22alice%22',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['scimType']).toBe('invalidFilter')
  })

  it('GET /Users 拒绝无效 sortOrder', async () => {
    const { ctx, token, env } = await makeUserEnv()
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users?sortBy=userName&sortOrder=invalid',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['scimType']).toBe('invalidValue')
  })

  it('GET /Users 拒绝 sortOrder 无 sortBy', async () => {
    const { ctx, token, env } = await makeUserEnv()
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users?sortOrder=descending',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['scimType']).toBe('invalidValue')
  })

  it('GET /Users 拒绝无效 startIndex', async () => {
    const { ctx, token, env } = await makeUserEnv()
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users?startIndex=abc',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['scimType']).toBe('invalidValue')
  })

  it('GET /Users 支持 emails.value co filter', async () => {
    const { ctx, token, env } = await makeUserEnv()
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users?filter=emails.value%20co%20%22bjensen%22',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['totalResults']).toBe(1)
  })

  it('GET /Users 支持 sortBy + sortOrder', async () => {
    const { ctx } = await buildTestTenant()
    const token = 'scim_sort_token'
    const hash = await makeTokenHash(token)
    const dir = {
      id: 'dir_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      provider: 'okta',
      scim_token_hash: hash,
      scim_token_hash_prev: null,
      scim_token_prev_expires: null,
      sync_status: 'idle',
      last_sync_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const users = [
      {
        id: 'user_a',
        tenant_id: 't_1',
        directory_id: 'dir_1',
        user_id: null,
        external_id: null,
        user_name: 'zoe@example.com',
        scim_raw: JSON.stringify({ userName: 'zoe@example.com', active: true }),
        active: 1,
        status: 'active',
        created_at: Date.now(),
        updated_at: Date.now(),
      },
      {
        id: 'user_b',
        tenant_id: 't_1',
        directory_id: 'dir_1',
        user_id: null,
        external_id: null,
        user_name: 'alice@example.com',
        scim_raw: JSON.stringify({ userName: 'alice@example.com', active: true }),
        active: 1,
        status: 'active',
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ]
    const env = makeEnv({
      DB: makeScimD1({ directories: [dir], directory_users: users }),
      CACHE: makeFakeKv(),
    })
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users?sortBy=userName&sortOrder=ascending',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    const resources = body['Resources'] as Record<string, unknown>[]
    expect(resources[0]?.['userName']).toBe('alice@example.com')
    expect(resources[1]?.['userName']).toBe('zoe@example.com')
  })

  it('GET /Users 支持 attributes projection', async () => {
    const { ctx, token, env } = await makeUserEnv()
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users?attributes=userName,emails.value,urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    const resources = body['Resources'] as Record<string, unknown>[]
    expect(resources[0]).toEqual({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      id: 'user_scim_1',
      userName: 'bjensen@example.com',
      emails: [{ value: 'bjensen@example.com' }],
      'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': {
        department: 'Engineering',
      },
    })
  })

  it('GET /Users/{id} 支持 excludedAttributes projection', async () => {
    const { ctx, token, env } = await makeUserEnv()
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users/user_scim_1?excludedAttributes=emails,meta',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['schemas']).toContain('urn:ietf:params:scim:schemas:core:2.0:User')
    expect(body['id']).toBe('user_scim_1')
    expect(body['userName']).toBe('bjensen@example.com')
    expect(body['emails']).toBeUndefined()
    expect(body['meta']).toBeUndefined()
  })

  it('GET /Users 同时传 attributes 和 excludedAttributes -> 400 invalidValue', async () => {
    const { ctx, token, env } = await makeUserEnv()
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users?attributes=userName&excludedAttributes=emails',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['scimType']).toBe('invalidValue')
  })

  it('PATCH /Users/{id} 缺 PatchOp schema -> 400 invalidSyntax', async () => {
    const { ctx, token, env, user } = await makeUserEnv()
    const { app } = buildScimApp(ctx, env)
    const body = {
      schemas: ['urn:ietf:params:scim:api:messages:WRONG'],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    }
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users/user_scim_1',
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/scim+json',
          'If-Match': buildVersion(new Date(user['updated_at'] as number)),
        },
        body: JSON.stringify(body),
      },
      env,
    )
    expect(res.status).toBe(400)
    const rb = (await res.json()) as Record<string, unknown>
    expect(rb['scimType']).toBe('invalidSyntax')
  })

  it('PATCH /Users/{id} 缺 If-Match -> 428', async () => {
    const { ctx, token, env } = await makeUserEnv()
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users/user_scim_1',
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/scim+json',
        },
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'title', value: 'Lead' }],
        }),
      },
      env,
    )
    expect(res.status).toBe(428)
  })

  it('PUT /Users/{id} 缺 If-Match -> 428', async () => {
    const { ctx, token, env } = await makeUserEnv()
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users/user_scim_1',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/scim+json',
        },
        body: JSON.stringify({
          userName: 'bjensen@example.com',
          active: true,
        }),
      },
      env,
    )
    expect(res.status).toBe(428)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['scimType']).toBeUndefined()
  })

  it('PUT /Users/{id} If-Match 不匹配 -> 412', async () => {
    const { ctx, token, env } = await makeUserEnv()
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users/user_scim_1',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/scim+json',
          'If-Match': 'W/"deadbeef"',
        },
        body: JSON.stringify({
          userName: 'bjensen@example.com',
          active: true,
        }),
      },
      env,
    )
    expect(res.status).toBe(412)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['scimType']).toBeUndefined()
  })

  it('PATCH /Users/{id} If-Match 不匹配 -> 412', async () => {
    const { ctx, token, env } = await makeUserEnv()
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users/user_scim_1',
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/scim+json',
          'If-Match': 'W/"deadbeef"',
        },
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'title', value: 'Lead' }],
        }),
      },
      env,
    )
    expect(res.status).toBe(412)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['scimType']).toBeUndefined()
  })

  it('PUT /Users/{id} stale If-Match after concurrent update -> 412 (DB guard)', async () => {
    const { ctx } = await buildTestTenant()
    const token = 'scim_usertoken'
    const hash = await makeTokenHash(token)
    const dir = {
      id: 'dir_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      provider: 'okta',
      scim_token_hash: hash,
      scim_token_hash_prev: null,
      scim_token_prev_expires: null,
      sync_status: 'idle',
      last_sync_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const user = {
      id: 'user_scim_1',
      tenant_id: 't_1',
      directory_id: 'dir_1',
      user_id: 'xid_user_1',
      external_id: '701984',
      user_name: 'bjensen@example.com',
      scim_raw: JSON.stringify({ userName: 'bjensen@example.com', active: true }),
      active: 1,
      status: 'active',
      deleted_at: null as number | null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const staleEtag = buildVersion(new Date(user['updated_at'] as number))
    const db = makeScimD1({ directories: [dir], directory_users: [user] }, undefined, {
      simulateVersionRaceOnUpdate: true,
    })
    const sessionDoNs = makeFakeDoNs(() => new Response('{}', { status: 200 }))
    const env = makeEnv({ DB: db, CACHE: makeFakeKv(), SESSION_REVOCATION: sessionDoNs })
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users/user_scim_1',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/scim+json',
          'If-Match': staleEtag,
        },
        body: JSON.stringify({
          userName: 'bjensen@example.com',
          active: true,
        }),
      },
      env,
    )
    expect(res.status).toBe(412)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['scimType']).toBeUndefined()
    expect(body['detail']).toBe('Resource version mismatch')
  })

  it('PATCH /Users/{id} stale If-Match after concurrent update -> 412 (DB guard)', async () => {
    const { ctx } = await buildTestTenant()
    const token = 'scim_usertoken'
    const hash = await makeTokenHash(token)
    const dir = {
      id: 'dir_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      provider: 'okta',
      scim_token_hash: hash,
      scim_token_hash_prev: null,
      scim_token_prev_expires: null,
      sync_status: 'idle',
      last_sync_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const user = {
      id: 'user_scim_1',
      tenant_id: 't_1',
      directory_id: 'dir_1',
      user_id: 'xid_user_1',
      external_id: '701984',
      user_name: 'bjensen@example.com',
      scim_raw: JSON.stringify({
        userName: 'bjensen@example.com',
        active: true,
        title: 'Manager',
      }),
      active: 1,
      status: 'active',
      deleted_at: null as number | null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const staleEtag = buildVersion(new Date(user['updated_at'] as number))
    const db = makeScimD1({ directories: [dir], directory_users: [user] }, undefined, {
      simulateVersionRaceOnUpdate: true,
    })
    const sessionDoNs = makeFakeDoNs(() => new Response('{}', { status: 200 }))
    const env = makeEnv({ DB: db, CACHE: makeFakeKv(), SESSION_REVOCATION: sessionDoNs })
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users/user_scim_1',
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/scim+json',
          'If-Match': staleEtag,
        },
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'title', value: 'Lead' }],
        }),
      },
      env,
    )
    expect(res.status).toBe(412)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['scimType']).toBeUndefined()
    expect(body['detail']).toBe('Resource version mismatch')
  })

  it('DELETE /Users/{id} -> deprovision + soft delete', async () => {
    const { ctx, token, env, user } = await makeUserEnv()
    const testEnv = {
      ...env,
      WEBHOOK_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
    } as unknown as Env
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users/user_scim_1',
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      testEnv,
    )
    expect(res.status).toBe(204)
    expect(user['active']).toBe(0)
    expect(user['status']).toBe('deleted')
    expect(user['deleted_at']).toBeTypeOf('number')
  })

  it('DELETE /Users/{id} SessionDO 失败 -> 关闭 app user 且重试继续撤销', async () => {
    const { ctx, token, env, user, appUser } = await makeUserEnv()
    const webhookQueue = { send: vi.fn().mockResolvedValue(undefined) }
    let revokeAttempts = 0
    const testEnv = {
      ...env,
      SESSION_REVOCATION: makeFakeDoNs(() => {
        revokeAttempts += 1
        if (revokeAttempts === 1) throw new Error('session do unavailable')
        return new Response('{}', { status: 200 })
      }),
      WEBHOOK_QUEUE: webhookQueue,
    } as unknown as Env
    const { app } = buildScimApp(ctx, testEnv)

    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users/user_scim_1',
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      testEnv,
    )

    expect(res.status).toBe(503)
    expect(user['active']).toBe(0)
    expect(user['status']).toBe('deprovisioning')
    expect(user['deleted_at']).toBeNull()
    expect(appUser['status']).toBe('deactivated')
    expect(webhookQueue.send).not.toHaveBeenCalled()

    const retry = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users/user_scim_1',
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      testEnv,
    )

    expect(retry.status).toBe(204)
    expect(revokeAttempts).toBe(2)
    expect(user['status']).toBe('deleted')
  })
})

describe('SCIM deprovisioning(active=false)', () => {
  it('PATCH active=false 触发 SessionDO revoke-all 调用', async () => {
    const { ctx } = await buildTestTenant()
    const token = 'scim_deprov_token'
    const hash = await makeTokenHash(token)
    const dir = {
      id: 'dir_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      provider: 'okta',
      scim_token_hash: hash,
      scim_token_hash_prev: null,
      scim_token_prev_expires: null,
      sync_status: 'idle',
      last_sync_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const user = {
      id: 'user_deprov',
      tenant_id: 't_1',
      directory_id: 'dir_1',
      user_id: 'xid_u1',
      external_id: 'ext_1',
      user_name: 'alice@example.com',
      scim_raw: JSON.stringify({ userName: 'alice@example.com', active: true }),
      active: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
    }

    const revokeCalls: string[] = []
    const sessionDoNs = makeFakeDoNs((path) => {
      revokeCalls.push(path)
      return new Response('{}', { status: 200 })
    })

    const webhookQueue = { send: vi.fn().mockResolvedValue(undefined) }
    const db = makeScimD1({ directories: [dir], directory_users: [user] })
    const env = {
      ...makeEnv({ DB: db, CACHE: makeFakeKv(), SESSION_REVOCATION: sessionDoNs }),
      WEBHOOK_QUEUE: webhookQueue,
    } as unknown as Env

    const { app } = buildScimApp(ctx, env)
    const patchBody = {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    }
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users/user_deprov',
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/scim+json',
          'If-Match': buildVersion(new Date(user['updated_at'] as number)),
        },
        body: JSON.stringify(patchBody),
      },
      env,
    )
    expect(res.status).toBe(200)
    // 验证 SessionDO revoke-all 被调用(deprovisioning 安全语义 P0)
    expect(revokeCalls.some((p) => p.includes('revoke-all'))).toBe(true)
  })
})

describe('SCIM stale ETag has no side effects', () => {
  it('DELETE /Users stale If-Match does not revoke sessions or enqueue webhook', async () => {
    const { ctx } = await buildTestTenant()
    const token = 'scim_stale_delete_user_token'
    const hash = await makeTokenHash(token)
    const now = Date.now()
    const dir = {
      id: 'dir_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      provider: 'okta',
      scim_token_hash: hash,
      scim_token_hash_prev: null,
      scim_token_prev_expires: null,
      sync_status: 'idle',
      last_sync_at: null,
      created_at: now,
      updated_at: now,
    }
    const user = {
      id: 'user_stale_delete',
      tenant_id: 't_1',
      directory_id: 'dir_1',
      user_id: 'xid_user_1',
      external_id: 'ext_1',
      user_name: 'alice@example.com',
      scim_raw: JSON.stringify({ userName: 'alice@example.com', active: true }),
      active: 1,
      status: 'active',
      deleted_at: null,
      created_at: now,
      updated_at: now,
    }
    const revokeCalls: string[] = []
    const webhookQueue = { send: vi.fn().mockResolvedValue(undefined) }
    const db = makeScimD1({ directories: [dir], directory_users: [user] }, undefined, {
      simulateVersionRaceOnUpdate: true,
    })
    const env = {
      ...makeEnv({
        DB: db,
        CACHE: makeFakeKv(),
        SESSION_REVOCATION: makeFakeDoNs((path) => {
          revokeCalls.push(path)
          return new Response('{}', { status: 200 })
        }),
      }),
      WEBHOOK_QUEUE: webhookQueue,
    } as unknown as Env
    const { app } = buildScimApp(ctx, env)

    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users/user_stale_delete',
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          'If-Match': buildVersion(new Date(now)),
        },
      },
      env,
    )

    expect(res.status).toBe(412)
    expect(revokeCalls).toEqual([])
    expect(webhookQueue.send).not.toHaveBeenCalled()
    expect(user['status']).toBe('active')
  })

  it('PATCH /Groups stale If-Match does not create pending members or enqueue webhook', async () => {
    const { ctx } = await buildTestTenant()
    const token = 'scim_stale_patch_group_token'
    const hash = await makeTokenHash(token)
    const now = Date.now()
    const dir = {
      id: 'dir_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      provider: 'okta',
      scim_token_hash: hash,
      scim_token_hash_prev: null,
      scim_token_prev_expires: null,
      sync_status: 'idle',
      last_sync_at: null,
      created_at: now,
      updated_at: now,
    }
    const group = {
      id: 'grp_stale_patch',
      tenant_id: 't_1',
      directory_id: 'dir_1',
      display_name: 'Engineering',
      mapped_role: null,
      status: 'active',
      deleted_at: null,
      created_at: now,
      updated_at: now,
    }
    const capture = {
      inserts: [] as Record<string, unknown>[],
      updates: [] as string[],
      deletes: [] as string[],
    }
    const webhookQueue = { send: vi.fn().mockResolvedValue(undefined) }
    const db = makeScimD1({ directories: [dir], directory_groups: [group] }, capture, {
      simulateVersionRaceOnUpdate: true,
    })
    const env = {
      ...makeEnv({ DB: db, CACHE: makeFakeKv() }),
      WEBHOOK_QUEUE: webhookQueue,
    } as unknown as Env
    const { app } = buildScimApp(ctx, env)

    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Groups/grp_stale_patch',
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/scim+json',
          'If-Match': buildVersion(new Date(now)),
        },
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'add', path: 'members', value: [{ value: 'unknown_user_ref' }] }],
        }),
      },
      env,
    )

    expect(res.status).toBe(412)
    expect(capture.inserts).toEqual([])
    expect(capture.deletes).toEqual([])
    expect(webhookQueue.send).not.toHaveBeenCalled()
  })

  it('DELETE /Groups stale If-Match does not remove members', async () => {
    const { ctx } = await buildTestTenant()
    const token = 'scim_stale_delete_group_token'
    const hash = await makeTokenHash(token)
    const now = Date.now()
    const dir = {
      id: 'dir_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      provider: 'okta',
      scim_token_hash: hash,
      scim_token_hash_prev: null,
      scim_token_prev_expires: null,
      sync_status: 'idle',
      last_sync_at: null,
      created_at: now,
      updated_at: now,
    }
    const group = {
      id: 'grp_stale_delete',
      tenant_id: 't_1',
      directory_id: 'dir_1',
      display_name: 'Engineering',
      mapped_role: null,
      status: 'active',
      deleted_at: null,
      created_at: now,
      updated_at: now,
    }
    const member = {
      id: 'member_1',
      tenant_id: 't_1',
      group_id: 'grp_stale_delete',
      directory_user_id: 'user_1',
      created_at: now,
    }
    const capture = {
      inserts: [] as Record<string, unknown>[],
      updates: [] as string[],
      deletes: [] as string[],
    }
    const db = makeScimD1(
      { directories: [dir], directory_groups: [group], directory_group_members: [member] },
      capture,
      { simulateVersionRaceOnUpdate: true },
    )
    const env = makeEnv({ DB: db, CACHE: makeFakeKv() })
    const { app } = buildScimApp(ctx, env)

    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Groups/grp_stale_delete',
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          'If-Match': buildVersion(new Date(now)),
        },
      },
      env,
    )

    expect(res.status).toBe(412)
    expect(capture.deletes).toEqual([])
    expect(group['status']).toBe('active')
  })
})

describe('SCIM Groups PATCH unknown member(OneLogin quirk)', () => {
  async function makeGroupEnv() {
    const { ctx } = await buildTestTenant()
    const token = 'scim_group_token'
    const hash = await makeTokenHash(token)
    const dir = {
      id: 'dir_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      provider: 'okta',
      scim_token_hash: hash,
      scim_token_hash_prev: null,
      scim_token_prev_expires: null,
      sync_status: 'idle',
      last_sync_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const group = {
      id: 'grp_1',
      tenant_id: 't_1',
      directory_id: 'dir_1',
      display_name: 'Engineering',
      mapped_role: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const member = {
      id: 'member_1',
      tenant_id: 't_1',
      group_id: 'grp_1',
      directory_user_id: 'user_scim_1',
      created_at: Date.now(),
    }
    const env = makeEnv({
      DB: makeScimD1({
        directories: [dir],
        directory_groups: [group],
        directory_group_members: [member],
      }),
      CACHE: makeFakeKv(),
    })
    return { ctx, token, env }
  }

  it('GET /Groups 支持 members.value eq filter', async () => {
    const { ctx, token, env } = await makeGroupEnv()
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Groups?filter=members.value%20eq%20%22user_scim_1%22',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['totalResults']).toBe(1)
  })

  it('GET /Groups 支持 attributes projection', async () => {
    const { ctx, token, env } = await makeGroupEnv()
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Groups?attributes=displayName,members.value',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    const resources = body['Resources'] as Record<string, unknown>[]
    expect(resources[0]).toEqual({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      id: 'grp_1',
      displayName: 'Engineering',
      members: [{ value: 'user_scim_1' }],
    })
  })

  it('PATCH add members 指向不存在用户 -> 写 pending_members,返回 200', async () => {
    const { ctx } = await buildTestTenant()
    const token = 'scim_group_token'
    const hash = await makeTokenHash(token)
    const dir = {
      id: 'dir_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      provider: 'okta',
      scim_token_hash: hash,
      scim_token_hash_prev: null,
      scim_token_prev_expires: null,
      sync_status: 'idle',
      last_sync_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const group = {
      id: 'grp_1',
      tenant_id: 't_1',
      directory_id: 'dir_1',
      display_name: 'Engineering',
      mapped_role: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }

    const capture = { inserts: [] as Record<string, unknown>[], updates: [] as string[] }
    const db = makeScimD1({ directories: [dir], directory_groups: [group] }, capture)
    const sessionDoNs = makeFakeDoNs(() => new Response('{}', { status: 200 }))
    const webhookQueue = { send: vi.fn().mockResolvedValue(undefined) }
    const env = {
      ...makeEnv({ DB: db, CACHE: makeFakeKv(), SESSION_REVOCATION: sessionDoNs }),
      WEBHOOK_QUEUE: webhookQueue,
    } as unknown as Env

    const { app } = buildScimApp(ctx, env)
    const patchBody = {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'add', path: 'members', value: [{ value: 'unknown_user_ref' }] }],
    }
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Groups/grp_1',
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/scim+json',
          'If-Match': buildVersion(new Date(group['updated_at'] as number)),
        },
        body: JSON.stringify(patchBody),
      },
      env,
    )
    // 应返回 200 而非 404/400(幂等处理)
    expect(res.status).toBe(200)
    const rb = (await res.json()) as Record<string, unknown>
    expect(rb['displayName']).toBe('Engineering')
  })

  it('DELETE /Groups/{id} -> soft delete group', async () => {
    const { ctx } = await buildTestTenant()
    const token = 'scim_group_delete_token'
    const hash = await makeTokenHash(token)
    const dir = {
      id: 'dir_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      provider: 'okta',
      scim_token_hash: hash,
      scim_token_hash_prev: null,
      scim_token_prev_expires: null,
      sync_status: 'idle',
      last_sync_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const group = {
      id: 'grp_delete',
      tenant_id: 't_1',
      directory_id: 'dir_1',
      display_name: 'Delete Me',
      mapped_role: null,
      status: 'active',
      deleted_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const db = makeScimD1({ directories: [dir], directory_groups: [group] })
    const sessionDoNs = makeFakeDoNs(() => new Response('{}', { status: 200 }))
    const webhookQueue = { send: vi.fn().mockResolvedValue(undefined) }
    const env = {
      ...makeEnv({ DB: db, CACHE: makeFakeKv(), SESSION_REVOCATION: sessionDoNs }),
      WEBHOOK_QUEUE: webhookQueue,
    } as unknown as Env
    const { app } = buildScimApp(ctx, env)

    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Groups/grp_delete',
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      env,
    )
    expect(res.status).toBe(204)
    expect(group['status']).toBe('deleted')
    expect(group['deleted_at']).toBeTypeOf('number')
  })
})

describe('SCIM pending member 回填:同租户多 directory 不交叉', () => {
  // 自带 D1 fake:记录 insert SQL(用于断言是否给 dir_B 的 group 误建成员)。
  // directory_groups 查询按 directory_id 收窄,pending 按 group 归属过滤(见 resolvePendingMembers)。
  function makeCrossDirD1(tables: ScimTableSet, insertSqls: string[]): D1Database {
    if (tables.directories) {
      for (const dir of tables.directories) {
        if (dir['status'] === undefined) dir['status'] = 'active'
      }
    }
    if (tables.directory_users) {
      for (const user of tables.directory_users) {
        if (user['status'] === undefined) user['status'] = 'active'
      }
    }
    if (tables.directory_groups) {
      for (const group of tables.directory_groups) {
        if (group['status'] === undefined) group['status'] = 'active'
      }
    }
    const get = (t: string): Record<string, unknown>[] =>
      (tables as Record<string, Record<string, unknown>[]>)[t] ?? []
    const match = (sql: string, params: unknown[]): Record<string, unknown>[] => {
      const rows = get(tableNameForSql(sql))
      const lower = sql.toLowerCase()
      if (lower.startsWith('insert') || lower.startsWith('with')) {
        insertSqls.push(sql)
        return rows.slice(-1).length ? rows.slice(-1) : [{ id: crypto.randomUUID() }]
      }
      if (lower.startsWith('update')) return rows.slice(-1)
      if (lower.startsWith('delete')) return []
      const hasStatusNotDeleted = /"status"\s*<>\s*\?/i.test(sql) && params.includes('deleted')
      const sp = params.filter(
        (v): v is string => typeof v === 'string' && !(hasStatusNotDeleted && v === 'deleted'),
      )
      if (sp.length === 0) return rows
      return rows.filter((r) => {
        if (hasStatusNotDeleted && r['status'] === 'deleted') return false
        return sp.every((v) => Object.values(r).includes(v))
      })
    }
    const prepare = (sql: string): unknown => {
      let bound: unknown[] = []
      const stmt = {
        bind: (...p: unknown[]) => {
          bound = p
          return stmt
        },
        raw: async () => match(sql, bound).map((r) => rowToRawScim(sql, r)),
        all: async () => ({ results: match(sql, bound), success: true, meta: {} }),
        run: async () => ({ results: [], success: true, meta: {} }),
        first: async () => match(sql, bound)[0] ?? null,
      }
      return stmt
    }
    return asUnknown<D1Database>({ prepare, batch: async () => [] })
  }

  it('在 dir_A 建用户不应回填 dir_B 的 group pending member', async () => {
    const { ctx } = await buildTestTenant()
    const token = 'scim_crossdir_token'
    const hash = await makeTokenHash(token)
    // dir_A 是请求目标 directory(token 命中);dir_B 是同租户另一 directory。
    const dirA = {
      id: 'dir_A',
      tenant_id: 't_1',
      org_id: 'org_1',
      provider: 'okta',
      scim_token_hash: hash,
      scim_token_hash_prev: null,
      scim_token_prev_expires: null,
      sync_status: 'idle',
      last_sync_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    // dir_B 的 group + 指向 alice 的 pending member(ref=userName)。dir_A 自身无 group。
    const groupB = {
      id: 'grp_B',
      tenant_id: 't_1',
      directory_id: 'dir_B',
      display_name: 'B-Engineering',
      mapped_role: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const pendingB = {
      id: 'pend_B',
      tenant_id: 't_1',
      group_id: 'grp_B',
      ref: 'alice@example.com',
      created_at: Date.now(),
    }

    const insertSqls: string[] = []
    const db = makeCrossDirD1(
      {
        directories: [dirA],
        directory_groups: [groupB],
        directory_pending_members: [pendingB],
      },
      insertSqls,
    )
    const sessionDoNs = makeFakeDoNs(() => new Response('{}', { status: 200 }))
    const webhookQueue = { send: vi.fn().mockResolvedValue(undefined) }
    const env = {
      ...makeEnv({ DB: db, CACHE: makeFakeKv(), SESSION_REVOCATION: sessionDoNs }),
      WEBHOOK_QUEUE: webhookQueue,
    } as unknown as Env

    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Users',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/scim+json' },
        body: JSON.stringify({ userName: 'alice@example.com', active: true }),
      },
      env,
    )
    expect(res.status).toBe(201)
    // 关键:dir_A 无 group,dir_B 的 pending 不属本 directory,不得回填 -> 无 group_member insert。
    const memberInserts = insertSqls.filter((s) =>
      s.toLowerCase().includes('directory_group_members'),
    )
    expect(memberInserts).toEqual([])
  })
})

describe('SCIM Bulk', () => {
  async function makeBulkEnv() {
    const { ctx } = await buildTestTenant()
    const token = 'scim_bulk_token'
    const hash = await makeTokenHash(token)
    const dir = {
      id: 'dir_1',
      tenant_id: 't_1',
      org_id: 'org_1',
      provider: 'okta',
      scim_token_hash: hash,
      scim_token_hash_prev: null,
      scim_token_prev_expires: null,
      sync_status: 'idle',
      last_sync_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const env = makeEnv({ DB: makeScimD1({ directories: [dir] }), CACHE: makeFakeKv() })
    return { ctx, token, env }
  }

  it('POST /Bulk 创建用户并返回 multi-status Operations', async () => {
    const { ctx, token, env } = await makeBulkEnv()
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Bulk',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/scim+json',
        },
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
          Operations: [
            {
              method: 'POST',
              path: '/Users',
              bulkId: 'user1',
              data: { userName: 'bulk.user@example.com', active: true },
            },
          ],
        }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['schemas']).toContain('urn:ietf:params:scim:api:messages:2.0:BulkResponse')
    const ops = body['Operations'] as Record<string, unknown>[]
    expect(ops[0]?.['status']).toBe('201')
  })

  it('POST /Bulk bulkId 跨操作引用 POST 后 PATCH', async () => {
    const { ctx, token, env } = await makeBulkEnv()
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Bulk',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/scim+json',
        },
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
          Operations: [
            {
              method: 'POST',
              path: '/Users',
              bulkId: 'user1',
              data: { userName: 'bulk.ref@example.com', active: true },
            },
            {
              method: 'PATCH',
              path: '/Users/bulkId:user1',
              bulkId: 'patch1',
              version: '*',
              data: {
                schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
                Operations: [{ op: 'replace', path: 'title', value: 'Bulk Updated' }],
              },
            },
          ],
        }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    const ops = body['Operations'] as Record<string, unknown>[]
    expect(ops).toHaveLength(2)
    expect(ops[0]?.['status']).toBe('201')
    // bulkId 路径已解析(非 invalidPath);fake D1 不持久化 insert,故 PATCH 返回 404
    expect(ops[1]?.['status']).toBe('404')
    const patchResponse = ops[1]?.['response'] as Record<string, unknown>
    expect(patchResponse?.['detail']).toBe('User not found')
    expect(patchResponse?.['scimType']).not.toBe('invalidPath')
  })

  it('POST /Bulk failOnErrors 在首个失败后截断 Operations', async () => {
    const { ctx, token, env } = await makeBulkEnv()
    const { app } = buildScimApp(ctx, env)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Bulk',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/scim+json',
        },
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
          failOnErrors: true,
          Operations: [
            { method: 'PATCH', path: '/Users/bulkId:missing', data: {} },
            {
              method: 'POST',
              path: '/Users',
              bulkId: 'skipped',
              data: { userName: 'skipped@example.com', active: true },
            },
          ],
        }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    const ops = body['Operations'] as Record<string, unknown>[]
    expect(ops).toHaveLength(1)
    expect(ops[0]?.['status']).toBe('400')
    const err = ops[0]?.['response'] as Record<string, unknown>
    expect(err?.['scimType']).toBe('invalidPath')
  })

  it('POST /Bulk 超过 maxPayloadSize -> 413', async () => {
    const { ctx, token, env } = await makeBulkEnv()
    const { app } = buildScimApp(ctx, env)
    const padding = 'x'.repeat(SCIM_BULK_MAX_PAYLOAD_SIZE)
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Bulk',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/scim+json',
        },
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
          Operations: [
            {
              method: 'POST',
              path: '/Users',
              data: { userName: 'big@example.com', active: true, note: padding },
            },
          ],
        }),
      },
      env,
    )
    expect(res.status).toBe(413)
  })

  it('POST /Bulk 超过 maxOperations -> 413', async () => {
    const { ctx, token, env } = await makeBulkEnv()
    const { app } = buildScimApp(ctx, env)
    const operations = Array.from({ length: 101 }, (_, i) => ({
      method: 'POST',
      path: '/Users',
      bulkId: `u${i}`,
      data: { userName: `bulk${i}@example.com`, active: true },
    }))
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_1/Bulk',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/scim+json',
        },
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
          Operations: operations,
        }),
      },
      env,
    )
    expect(res.status).toBe(413)
  })
})

describe('SCIM 租户隔离', () => {
  it('organization_id 路径与 TenantContext 不符 -> 403', async () => {
    const { ctx } = await buildTestTenant() // ctx.tenantId = 't_1'
    const env = makeEnv({ DB: makeScimD1({}), CACHE: makeFakeKv() })
    const { app } = buildScimApp(ctx, env)
    // 路径 organization_id = 't_other',TenantContext.tenantId = 't_1'
    const res = await app.request(
      'https://acme.xid.dev/scim/v2/organizations/t_other/Users',
      {
        method: 'GET',
        headers: { Authorization: 'Bearer sometoken' },
      },
      env,
    )
    expect(res.status).toBe(403)
  })
})
