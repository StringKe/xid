// Management API v1 /v1/organizations/:orgId/units 隔离与 guard 测试
// (设计 docs/design/org-structure-access/design-org-structure.md 第 6 节 5、7 项):
//   - guard:无凭证 401、API key scope 不足 403、org manager cookie session 放行。
//   - 跨租户:B 租户 org/unit 在 A 租户上下文一律 404,不泄露存在性(参照 isolation.test.ts)。
//   - 跨 org:unit id 属同租户另一 org -> 404(forOrg 注入 org_id)。
//   - 分页(cursor/has_more)、深度上限 422、同级 slug 冲突 409、跨租户 manager_user_id 404。
// D1 用 node:sqlite 内存库 + 全量 migration 链(真实唯一索引/LIKE/batch 语义),
// 与 packages/db/src/__tests__/org-units.test.ts 的 SqliteD1 同源。

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { sha256Hex } from '@xid-kit/crypto'
import type { TenantContext } from '@xid-kit/types'
import type { SessionData, XidHonoEnv } from '../../lib/types'
import { isAppError } from '../../lib/errors'
import { registerOrgUnitsRoutes } from '../org-units'

// cookie session 路径(requireOrgManager)的 MFA/验证门控在 control-plane.test.ts 同款 mock 掉。
vi.mock('../../lib/management-access', () => ({
  requireVerifiedManagementMutation: async () => undefined,
}))

const migrationDir = fileURLToPath(new URL('../../../../../packages/db/drizzle/', import.meta.url))

function applyMigrations(db: DatabaseSync): void {
  for (const file of readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(migrationDir, file), 'utf8'))
  }
}

// ---- SqliteD1:node:sqlite 内存库包装成 D1Database(prepare/bind/run/all/first/raw + batch) ----

type SqliteRow = Record<string, unknown>

function normalizeBinding(value: unknown): unknown {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value === undefined) return null
  return value
}

class SqliteD1Statement {
  private bindings: unknown[] = []

  constructor(
    private readonly owner: SqliteD1,
    readonly sql: string,
  ) {}

  bind(...bindings: unknown[]): this {
    this.bindings = bindings.map(normalizeBinding)
    return this
  }

  execute(): D1Result<unknown> {
    const result = this.owner.database.prepare(this.sql).run(...(this.bindings as never[]))
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as unknown as D1Result<unknown>
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    return this.execute() as unknown as D1Result<T>
  }

  async all<T = SqliteRow>(): Promise<D1Result<T>> {
    const statement = this.owner.database.prepare(this.sql)
    return {
      success: true,
      results: statement.all(...(this.bindings as never[])) as T[],
      meta: { changes: 0 },
    } as unknown as D1Result<T>
  }

  async first<T = SqliteRow>(): Promise<T | null> {
    const statement = this.owner.database.prepare(this.sql)
    return (statement.get(...(this.bindings as never[])) as T | undefined) ?? null
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const statement = this.owner.database.prepare(this.sql)
    statement.setReturnArrays(true)
    try {
      return statement.all(...(this.bindings as never[])) as T[]
    } finally {
      statement.setReturnArrays(false)
    }
  }
}

class SqliteD1 {
  readonly database = new DatabaseSync(':memory:')

  prepare(sql: string): D1PreparedStatement {
    return new SqliteD1Statement(this, sql) as unknown as D1PreparedStatement
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const results = statements.map((statement) =>
        (statement as unknown as SqliteD1Statement).execute(),
      )
      this.database.exec('COMMIT')
      return results as D1Result<T>[]
    } catch (cause) {
      this.database.exec('ROLLBACK')
      throw cause
    }
  }
}

// ---- fixtures ----

const TENANT: TenantContext = {
  tenantId: 't_1',
  issuer: 'https://acme.xid.dev',
  rpId: 'acme.xid.dev',
  signingKeys: { activeKid: 'k1', defaultAlg: 'ES256', keys: [] },
  policy: {},
}

function asUnknown<T>(value: unknown): T {
  return value as T
}

function makeDb(): SqliteD1 {
  const db = new SqliteD1()
  applyMigrations(db.database)
  return db
}

// organizations 有层级触发器(0007 migration):顶层 org id=tenant_id 且 parent 为空;
// 子 org parent_org_id 必须 = tenant_id 且顶层 org 已存在。seed 时顶层先行。
function seedOrganization(db: SqliteD1, id: string, tenantId: string): void {
  db.database
    .prepare(
      `INSERT INTO organizations (
         id, tenant_id, instance_id, parent_org_id, slug, name, public_metadata,
         private_metadata, seat_limit, seat_used, enrollment_mode, allow_org_self_service,
         status, created_at, updated_at
       ) VALUES (?, ?, 'inst_1', ?, ?, ?, '{}', '{}', NULL, 0, 'invite_required', 1, 'active', 1000, 1000)`,
    )
    .run(id, tenantId, id === tenantId ? null : tenantId, id, id)
}

function seedUser(db: SqliteD1, id: string, tenantId: string): void {
  db.database
    .prepare(
      `INSERT INTO users (
         id, tenant_id, public_metadata, private_metadata, unsafe_metadata, custom_attributes,
         status, created_at, updated_at
       ) VALUES (?, ?, '{}', '{}', '{}', '{}', 'active', 1000, 1000)`,
    )
    .run(id, tenantId)
}

function seedMembership(
  db: SqliteD1,
  input: { id: string; userId: string; tenantId?: string; orgId?: string; status?: string },
): void {
  db.database
    .prepare(
      `INSERT INTO memberships (id, tenant_id, org_id, user_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1000, 1000)`,
    )
    .run(
      input.id,
      input.tenantId ?? 't_1',
      input.orgId ?? 'org_1',
      input.userId,
      input.status ?? 'active',
    )
}

function seedUnit(
  db: SqliteD1,
  input: {
    id: string
    tenantId?: string
    orgId?: string
    parentUnitId?: string | null
    path?: string
    depth?: number
    slug?: string
    name?: string
    status?: string
  },
): void {
  const parentUnitId = input.parentUnitId ?? null
  db.database
    .prepare(
      `INSERT INTO org_units (
         id, tenant_id, org_id, parent_unit_id, path, depth, slug, name,
         manager_user_id, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1000, 1000)`,
    )
    .run(
      input.id,
      input.tenantId ?? 't_1',
      input.orgId ?? 'org_1',
      parentUnitId,
      input.path ?? `/${input.id}`,
      input.depth ?? 1,
      input.slug ?? input.id,
      input.name ?? input.id,
      input.status ?? 'active',
    )
}

function seedUnitMember(
  db: SqliteD1,
  input: {
    id: string
    tenantId?: string
    orgId?: string
    unitId: string
    userId: string
    isPrimary?: boolean
  },
): void {
  db.database
    .prepare(
      `INSERT INTO org_unit_members (
         id, tenant_id, org_id, unit_id, user_id, is_primary, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1000, 1000)`,
    )
    .run(
      input.id,
      input.tenantId ?? 't_1',
      input.orgId ?? 'org_1',
      input.unitId,
      input.userId,
      input.isPrimary === true ? 1 : 0,
    )
}

async function seedApiKey(
  db: SqliteD1,
  input: { id: string; tenantId?: string; scopes: string[] },
): Promise<string> {
  const token = `sk_live_${input.id}`
  db.database
    .prepare(
      `INSERT INTO api_keys (id, tenant_id, name, key_hash, key_prefix, scopes, created_at, updated_at)
       VALUES (?, ?, 'test', ?, ?, ?, 1000, 1000)`,
    )
    .run(
      input.id,
      input.tenantId ?? 't_1',
      await sha256Hex(token),
      token.slice(0, 16),
      JSON.stringify(input.scopes),
    )
  return token
}

// 测试用最小 onError:直接读 AppError.code/httpStatus,避免 import middleware/error 触发 i18n lingui macro。
function buildApp(session: SessionData | null = null): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  app.onError((err, c) => {
    if (isAppError(err)) return c.json({ code: err.code }, err.httpStatus as 400)
    return c.json({ code: 'server_error' }, 500)
  })
  app.use('*', async (c, next) => {
    c.set('tenant', TENANT)
    c.set('session', session)
    await next()
  })
  registerOrgUnitsRoutes(app)
  return app
}

// emitManagementAuditAsync 无 executionCtx 时走 task.catch 兜底,send 必须返回 Promise;
// 默认带一个 resolved mock,未关注审计的用例不感知 AUDIT_QUEUE。
function envOf(db: SqliteD1, auditSend: ReturnType<typeof vi.fn> = makeAuditSend()): Env {
  return asUnknown<Env>({
    DB: db as unknown as D1Database,
    AUDIT_QUEUE: { send: auditSend },
  })
}

function makeAuditSend() {
  return vi.fn().mockResolvedValue(undefined)
}

const BASE = 'https://acme.xid.dev/v1/organizations'

// ---- guard 覆盖(设计 6.7) ----

describe('v1 org-units guard', () => {
  it('无凭证 -> 401 unauthorized', async () => {
    const db = makeDb()
    seedOrganization(db, 't_1', 't_1')
    seedOrganization(db, 'org_1', 't_1')
    const app = buildApp()
    const res = await app.request(`${BASE}/org_1/units`, { method: 'GET' }, envOf(db))
    expect(res.status).toBe(401)
  })

  it('API key scope 不足 -> 403 insufficient_permission', async () => {
    const db = makeDb()
    seedOrganization(db, 't_1', 't_1')
    seedOrganization(db, 'org_1', 't_1')
    const token = await seedApiKey(db, { id: 'ak_readonly', scopes: ['users:read'] })
    const app = buildApp()
    const res = await app.request(
      `${BASE}/org_1/units`,
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      envOf(db),
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('insufficient_permission')
  })

  it('org manager cookie session 放行(无需 API key scope)', async () => {
    const db = makeDb()
    seedOrganization(db, 't_1', 't_1')
    seedOrganization(db, 'org_1', 't_1')
    seedUnit(db, { id: 'ou_root', slug: 'company' })
    db.database
      .prepare(
        `INSERT INTO manager_assignments (
           id, tenant_id, user_id, manager_role, scope_type, scope_id, created_at, updated_at
         ) VALUES ('mgr_1', 't_1', 'user_mgr', 'org_manager', 'org', 'org_1', 1000, 1000)`,
      )
      .run()
    const session = asUnknown<SessionData>({ userId: 'user_mgr' })
    const app = buildApp(session)
    const res = await app.request(`${BASE}/org_1/units`, { method: 'GET' }, envOf(db))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((row) => row.id)).toEqual(['ou_root'])
  })

  it('org-units:read key 可读不可写(POST -> 403)', async () => {
    const db = makeDb()
    seedOrganization(db, 't_1', 't_1')
    seedOrganization(db, 'org_1', 't_1')
    const token = await seedApiKey(db, { id: 'ak_units_ro', scopes: ['org-units:read'] })
    const app = buildApp()
    const env = envOf(db)
    const headers = { Authorization: `Bearer ${token}` }
    const read = await app.request(`${BASE}/org_1/units`, { method: 'GET', headers }, env)
    expect(read.status).toBe(200)
    const write = await app.request(
      `${BASE}/org_1/units`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'eng', name: 'Engineering' }),
      },
      env,
    )
    expect(write.status).toBe(403)
  })
})

// ---- 跨租户 / 跨 org 隔离(设计 6.5、6.7) ----

describe('v1 org-units 隔离', () => {
  it('org 属于别的租户 -> 404 org_not_found(不泄露存在性)', async () => {
    const db = makeDb()
    seedOrganization(db, 't_other', 't_other')
    seedOrganization(db, 'org_victim', 't_other')
    seedUnit(db, { id: 'ou_victim', tenantId: 't_other', orgId: 'org_victim' })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const app = buildApp()
    const res = await app.request(
      `${BASE}/org_victim/units`,
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      envOf(db),
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('org_not_found')
  })

  it('unit id 属于别的租户 -> 404 not_found 且读不到详情', async () => {
    const db = makeDb()
    seedOrganization(db, 't_1', 't_1')
    seedOrganization(db, 'org_1', 't_1')
    seedOrganization(db, 't_other', 't_other')
    seedOrganization(db, 'org_victim', 't_other')
    seedUnit(db, { id: 'ou_victim', tenantId: 't_other', orgId: 'org_victim' })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const app = buildApp()
    const headers = { Authorization: `Bearer ${token}` }
    const env = envOf(db)

    const detail = await app.request(`${BASE}/org_1/units/ou_victim`, { headers }, env)
    expect(detail.status).toBe(404)
    const body = (await detail.json()) as Record<string, unknown>
    expect(body['code']).toBe('not_found')

    // 写路径同样 404:PATCH 他租户 unit。
    const patch = await app.request(
      `${BASE}/org_1/units/ou_victim`,
      {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'pwned' }),
      },
      env,
    )
    expect(patch.status).toBe(404)
    // 受害行未被修改。
    const victim = db.database
      .prepare(`SELECT name FROM org_units WHERE id = 'ou_victim'`)
      .get() as { name: string }
    expect(victim.name).toBe('ou_victim')
  })

  it('unit id 属于同租户另一 org -> 404 not_found', async () => {
    const db = makeDb()
    seedOrganization(db, 't_1', 't_1')
    seedOrganization(db, 'org_1', 't_1')
    seedOrganization(db, 'org_2', 't_1')
    seedUnit(db, { id: 'ou_other', orgId: 'org_2', slug: 'other' })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const app = buildApp()
    const res = await app.request(
      `${BASE}/org_1/units/ou_other`,
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      envOf(db),
    )
    expect(res.status).toBe(404)
  })

  it('manager_user_id 属于别的租户 -> 404 not_found(User not found)', async () => {
    const db = makeDb()
    seedOrganization(db, 't_1', 't_1')
    seedOrganization(db, 'org_1', 't_1')
    seedUser(db, 'user_other', 't_other')
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const app = buildApp()
    const res = await app.request(
      `${BASE}/org_1/units`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'eng', name: 'Engineering', manager_user_id: 'user_other' }),
      },
      envOf(db),
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('not_found')
  })

  it('成员 user 无该 org active membership -> 404 membership_not_found', async () => {
    const db = makeDb()
    seedOrganization(db, 't_1', 't_1')
    seedOrganization(db, 'org_1', 't_1')
    seedUser(db, 'user_nomem', 't_1')
    seedUnit(db, { id: 'ou_1', slug: 'eng' })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const app = buildApp()
    const res = await app.request(
      `${BASE}/org_1/units/ou_1/members/user_nomem`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      envOf(db),
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('membership_not_found')
  })
})

// ---- 分页 / 深度上限 / slug 冲突(设计 6.7 + 任务要求) ----

describe('v1 org-units 列表分页', () => {
  it('limit + next_cursor 翻页遍历整树', async () => {
    const db = makeDb()
    seedOrganization(db, 't_1', 't_1')
    seedOrganization(db, 'org_1', 't_1')
    seedUnit(db, { id: 'ou_a', slug: 'a' })
    seedUnit(db, { id: 'ou_b', slug: 'b' })
    seedUnit(db, { id: 'ou_c', slug: 'c' })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const app = buildApp()
    const headers = { Authorization: `Bearer ${token}` }
    const env = envOf(db)

    const page1 = await app.request(`${BASE}/org_1/units?limit=2`, { headers }, env)
    expect(page1.status).toBe(200)
    const body1 = (await page1.json()) as {
      data: Array<{ id: string }>
      next_cursor: string | null
      has_more: boolean
    }
    expect(body1.data.map((row) => row.id)).toEqual(['ou_a', 'ou_b'])
    expect(body1.has_more).toBe(true)
    expect(body1.next_cursor).not.toBeNull()

    const page2 = await app.request(
      `${BASE}/org_1/units?limit=2&cursor=${body1.next_cursor}`,
      { headers },
      env,
    )
    expect(page2.status).toBe(200)
    const body2 = (await page2.json()) as {
      data: Array<{ id: string }>
      next_cursor: string | null
      has_more: boolean
    }
    expect(body2.data.map((row) => row.id)).toEqual(['ou_c'])
    expect(body2.has_more).toBe(false)
    expect(body2.next_cursor).toBeNull()
  })

  it('?parent_unit_id= 只列直接子节点', async () => {
    const db = makeDb()
    seedOrganization(db, 't_1', 't_1')
    seedOrganization(db, 'org_1', 't_1')
    seedUnit(db, { id: 'ou_root', slug: 'company' })
    seedUnit(db, {
      id: 'ou_child',
      parentUnitId: 'ou_root',
      path: '/ou_root/ou_child',
      depth: 2,
      slug: 'eng',
    })
    seedUnit(db, { id: 'ou_other_root', slug: 'ops' })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const app = buildApp()
    const res = await app.request(
      `${BASE}/org_1/units?parent_unit_id=ou_root`,
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      envOf(db),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((row) => row.id)).toEqual(['ou_child'])
  })
})

describe('v1 org-units 约束映射', () => {
  it('第 9 层创建被拒 -> 422 unprocessable_entity', async () => {
    const db = makeDb()
    seedOrganization(db, 't_1', 't_1')
    seedOrganization(db, 'org_1', 't_1')
    // 造 8 层链 ou_d1..ou_d8。
    let path = ''
    for (let depth = 1; depth <= 8; depth += 1) {
      const id = `ou_d${depth}`
      path = `${path}/${id}`
      seedUnit(db, {
        id,
        parentUnitId: depth === 1 ? null : `ou_d${depth - 1}`,
        path,
        depth,
        slug: `d${depth}`,
      })
    }
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const app = buildApp()
    const res = await app.request(
      `${BASE}/org_1/units`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_unit_id: 'ou_d8', slug: 'd9', name: 'Too deep' }),
      },
      envOf(db),
    )
    expect(res.status).toBe(422)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('unprocessable_entity')
  })

  it('同级 slug 冲突 -> 409 already_exists', async () => {
    const db = makeDb()
    seedOrganization(db, 't_1', 't_1')
    seedOrganization(db, 'org_1', 't_1')
    seedUnit(db, { id: 'ou_root', slug: 'company' })
    seedUnit(db, {
      id: 'ou_eng',
      parentUnitId: 'ou_root',
      path: '/ou_root/ou_eng',
      depth: 2,
      slug: 'eng',
    })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const app = buildApp()
    const res = await app.request(
      `${BASE}/org_1/units`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_unit_id: 'ou_root', slug: 'eng', name: 'Engineering 2' }),
      },
      envOf(db),
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('already_exists')
  })
})

// ---- 端到端接线:创建 -> 详情 -> 成员增删查 -> 归档 ----

describe('v1 org-units 端到端', () => {
  it('create/detail/members/archive 全链路', async () => {
    const db = makeDb()
    seedOrganization(db, 't_1', 't_1')
    seedOrganization(db, 'org_1', 't_1')
    seedUser(db, 'user_1', 't_1')
    seedMembership(db, { id: 'mem_1', userId: 'user_1' })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const app = buildApp()
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const env = envOf(db)

    const created = await app.request(
      `${BASE}/org_1/units`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ slug: 'eng', name: 'Engineering', manager_user_id: 'user_1' }),
      },
      env,
    )
    expect(created.status).toBe(201)
    const unit = (await created.json()) as { id: string; path: string; depth: number }
    expect(unit.depth).toBe(1)

    const detail = await app.request(`${BASE}/org_1/units/${unit.id}`, { headers }, env)
    expect(detail.status).toBe(200)
    const detailBody = (await detail.json()) as { manager_user_id: string }
    expect(detailBody.manager_user_id).toBe('user_1')

    const put = await app.request(
      `${BASE}/org_1/units/${unit.id}/members/user_1`,
      { method: 'PUT', headers, body: JSON.stringify({ is_primary: true }) },
      env,
    )
    expect(put.status).toBe(201)
    const member = (await put.json()) as { is_primary: boolean }
    expect(member.is_primary).toBe(true)

    const members = await app.request(`${BASE}/org_1/units/${unit.id}/members`, { headers }, env)
    expect(members.status).toBe(200)
    const memberList = (await members.json()) as { data: Array<{ user_id: string }> }
    expect(memberList.data.map((row) => row.user_id)).toEqual(['user_1'])

    const removed = await app.request(
      `${BASE}/org_1/units/${unit.id}/members/user_1`,
      { method: 'DELETE', headers },
      env,
    )
    expect(removed.status).toBe(204)

    const archived = await app.request(
      `${BASE}/org_1/units/${unit.id}`,
      {
        method: 'DELETE',
        headers,
      },
      env,
    )
    expect(archived.status).toBe(200)
    const archivedBody = (await archived.json()) as { status: string }
    expect(archivedBody.status).toBe('archived')
  })
})

// ---- PATCH 空 body 守卫 ----

describe('v1 org-units PATCH 空 body', () => {
  it('{} -> 422 validation_failed(空 .set({}) 不得漏成 500)', async () => {
    const db = makeDb()
    seedOrganization(db, 't_1', 't_1')
    seedOrganization(db, 'org_1', 't_1')
    seedUnit(db, { id: 'ou_1', slug: 'eng' })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const app = buildApp()
    const res = await app.request(
      `${BASE}/org_1/units/ou_1`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      envOf(db),
    )
    expect(res.status).toBe(422)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('validation_failed')
  })
})

// ---- move 端点接线 ----

describe('v1 org-units move 端点', () => {
  it('正常移动 -> 200,path/depth 重写 + 审计 org_unit.moved', async () => {
    const db = makeDb()
    seedOrganization(db, 't_1', 't_1')
    seedOrganization(db, 'org_1', 't_1')
    seedUnit(db, { id: 'ou_root', slug: 'company' })
    seedUnit(db, {
      id: 'ou_a',
      parentUnitId: 'ou_root',
      path: '/ou_root/ou_a',
      depth: 2,
      slug: 'eng',
    })
    seedUnit(db, { id: 'ou_b', slug: 'ops' })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const auditSend = makeAuditSend()
    const app = buildApp()
    const res = await app.request(
      `${BASE}/org_1/units/ou_a/move`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_unit_id: 'ou_b' }),
      },
      envOf(db, auditSend),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      parent_unit_id: string | null
      path: string
      depth: number
    }
    expect(body.parent_unit_id).toBe('ou_b')
    expect(body.path).toBe('/ou_b/ou_a')
    expect(body.depth).toBe(2)
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org_unit.moved',
        orgId: 'org_1',
        payload: expect.objectContaining({
          targetType: 'org_unit',
          targetId: 'ou_a',
          parentUnitId: 'ou_b',
        }),
      }),
    )
  })

  it('移动到自身后代 -> 409 conflict', async () => {
    const db = makeDb()
    seedOrganization(db, 't_1', 't_1')
    seedOrganization(db, 'org_1', 't_1')
    seedUnit(db, { id: 'ou_root', slug: 'company' })
    seedUnit(db, {
      id: 'ou_child',
      parentUnitId: 'ou_root',
      path: '/ou_root/ou_child',
      depth: 2,
      slug: 'eng',
    })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const app = buildApp()
    const res = await app.request(
      `${BASE}/org_1/units/ou_root/move`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_unit_id: 'ou_child' }),
      },
      envOf(db),
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('conflict')
  })

  it('目标 parent 属同租户另一 org -> 404 not_found(不泄露存在性)', async () => {
    const db = makeDb()
    seedOrganization(db, 't_1', 't_1')
    seedOrganization(db, 'org_1', 't_1')
    seedOrganization(db, 'org_2', 't_1')
    seedUnit(db, { id: 'ou_a', slug: 'eng' })
    seedUnit(db, { id: 'ou_other', orgId: 'org_2', slug: 'other' })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const app = buildApp()
    const res = await app.request(
      `${BASE}/org_1/units/ou_a/move`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_unit_id: 'ou_other' }),
      },
      envOf(db),
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('not_found')
  })
})

// ---- members?include_descendants=false 分支 ----

describe('v1 org-units members include_descendants', () => {
  it('false 只返回本节点直接成员,不返回后代成员;缺省 true 返回整棵子树', async () => {
    const db = makeDb()
    seedOrganization(db, 't_1', 't_1')
    seedOrganization(db, 'org_1', 't_1')
    seedUnit(db, { id: 'ou_root', slug: 'company' })
    seedUnit(db, {
      id: 'ou_child',
      parentUnitId: 'ou_root',
      path: '/ou_root/ou_child',
      depth: 2,
      slug: 'eng',
    })
    seedUser(db, 'user_a', 't_1')
    seedUser(db, 'user_b', 't_1')
    seedMembership(db, { id: 'mem_a', userId: 'user_a' })
    seedMembership(db, { id: 'mem_b', userId: 'user_b' })
    seedUnitMember(db, { id: 'oum_a', unitId: 'ou_root', userId: 'user_a' })
    seedUnitMember(db, { id: 'oum_b', unitId: 'ou_child', userId: 'user_b' })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const app = buildApp()
    const headers = { Authorization: `Bearer ${token}` }
    const env = envOf(db)

    const directOnly = await app.request(
      `${BASE}/org_1/units/ou_root/members?include_descendants=false`,
      { headers },
      env,
    )
    expect(directOnly.status).toBe(200)
    const directBody = (await directOnly.json()) as { data: Array<{ user_id: string }> }
    expect(directBody.data.map((row) => row.user_id)).toEqual(['user_a'])

    const subtree = await app.request(`${BASE}/org_1/units/ou_root/members`, { headers }, env)
    expect(subtree.status).toBe(200)
    const subtreeBody = (await subtree.json()) as { data: Array<{ user_id: string }> }
    expect(subtreeBody.data.map((row) => row.user_id).sort()).toEqual(['user_a', 'user_b'])
  })
})

// ---- 写操作审计事件 ----

describe('v1 org-units 审计事件', () => {
  it('POST -> org_unit.created(unitId/parentUnitId/managerUserId/slug)', async () => {
    const db = makeDb()
    seedOrganization(db, 't_1', 't_1')
    seedOrganization(db, 'org_1', 't_1')
    seedUser(db, 'user_1', 't_1')
    seedUnit(db, { id: 'ou_root', slug: 'company' })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const auditSend = makeAuditSend()
    const app = buildApp()
    const res = await app.request(
      `${BASE}/org_1/units`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parent_unit_id: 'ou_root',
          slug: 'eng',
          name: 'Engineering',
          manager_user_id: 'user_1',
        }),
      },
      envOf(db, auditSend),
    )
    expect(res.status).toBe(201)
    const created = (await res.json()) as { id: string }
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org_unit.created',
        orgId: 'org_1',
        payload: expect.objectContaining({
          targetType: 'org_unit',
          targetId: created.id,
          parentUnitId: 'ou_root',
          managerUserId: 'user_1',
          slug: 'eng',
        }),
      }),
    )
  })

  it('PATCH -> org_unit.updated(仅携带变更字段)', async () => {
    const db = makeDb()
    seedOrganization(db, 't_1', 't_1')
    seedOrganization(db, 'org_1', 't_1')
    seedUser(db, 'user_1', 't_1')
    seedUnit(db, { id: 'ou_1', slug: 'eng' })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const auditSend = makeAuditSend()
    const app = buildApp()
    const res = await app.request(
      `${BASE}/org_1/units/ou_1`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ manager_user_id: 'user_1' }),
      },
      envOf(db, auditSend),
    )
    expect(res.status).toBe(200)
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org_unit.updated',
        payload: expect.objectContaining({
          targetType: 'org_unit',
          targetId: 'ou_1',
          managerUserId: 'user_1',
        }),
      }),
    )
    const call = auditSend.mock.calls.find(
      (entry) => (entry[0] as { action: string }).action === 'org_unit.updated',
    )
    if (!call) throw new Error('expected org_unit.updated audit event')
    const payload = (call[0] as { payload: Record<string, unknown> }).payload
    expect(payload['name']).toBeUndefined()
    expect(payload['slug']).toBeUndefined()
  })

  it('DELETE -> org_unit.archived', async () => {
    const db = makeDb()
    seedOrganization(db, 't_1', 't_1')
    seedOrganization(db, 'org_1', 't_1')
    seedUnit(db, { id: 'ou_1', slug: 'eng' })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const auditSend = makeAuditSend()
    const app = buildApp()
    const res = await app.request(
      `${BASE}/org_1/units/ou_1`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      envOf(db, auditSend),
    )
    expect(res.status).toBe(200)
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org_unit.archived',
        payload: expect.objectContaining({ targetType: 'org_unit', targetId: 'ou_1' }),
      }),
    )
  })

  it('PUT 新成员 -> org_unit.member_added(userId/isPrimary)', async () => {
    const db = makeDb()
    seedOrganization(db, 't_1', 't_1')
    seedOrganization(db, 'org_1', 't_1')
    seedUser(db, 'user_1', 't_1')
    seedMembership(db, { id: 'mem_1', userId: 'user_1' })
    seedUnit(db, { id: 'ou_1', slug: 'eng' })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const auditSend = makeAuditSend()
    const app = buildApp()
    const res = await app.request(
      `${BASE}/org_1/units/ou_1/members/user_1`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_primary: true }),
      },
      envOf(db, auditSend),
    )
    expect(res.status).toBe(201)
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org_unit.member_added',
        payload: expect.objectContaining({
          targetType: 'org_unit',
          targetId: 'ou_1',
          userId: 'user_1',
          isPrimary: true,
        }),
      }),
    )
  })

  it('PUT 已有成员设主岗 -> org_unit.primary_changed;幂等重放不再发事件', async () => {
    const db = makeDb()
    seedOrganization(db, 't_1', 't_1')
    seedOrganization(db, 'org_1', 't_1')
    seedUser(db, 'user_1', 't_1')
    seedMembership(db, { id: 'mem_1', userId: 'user_1' })
    seedUnit(db, { id: 'ou_1', slug: 'eng' })
    seedUnitMember(db, { id: 'oum_1', unitId: 'ou_1', userId: 'user_1' })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const auditSend = makeAuditSend()
    const app = buildApp()
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const env = envOf(db, auditSend)

    const promoted = await app.request(
      `${BASE}/org_1/units/ou_1/members/user_1`,
      { method: 'PUT', headers, body: JSON.stringify({ is_primary: true }) },
      env,
    )
    expect(promoted.status).toBe(200)
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org_unit.primary_changed',
        payload: expect.objectContaining({
          targetType: 'org_unit',
          targetId: 'ou_1',
          userId: 'user_1',
        }),
      }),
    )

    auditSend.mockClear()
    const replay = await app.request(
      `${BASE}/org_1/units/ou_1/members/user_1`,
      { method: 'PUT', headers, body: JSON.stringify({ is_primary: true }) },
      env,
    )
    expect(replay.status).toBe(200)
    expect(auditSend).not.toHaveBeenCalled()
  })

  it('DELETE 成员 -> org_unit.member_removed(userId)', async () => {
    const db = makeDb()
    seedOrganization(db, 't_1', 't_1')
    seedOrganization(db, 'org_1', 't_1')
    seedUser(db, 'user_1', 't_1')
    seedMembership(db, { id: 'mem_1', userId: 'user_1' })
    seedUnit(db, { id: 'ou_1', slug: 'eng' })
    seedUnitMember(db, { id: 'oum_1', unitId: 'ou_1', userId: 'user_1' })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const auditSend = makeAuditSend()
    const app = buildApp()
    const res = await app.request(
      `${BASE}/org_1/units/ou_1/members/user_1`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      envOf(db, auditSend),
    )
    expect(res.status).toBe(204)
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org_unit.member_removed',
        payload: expect.objectContaining({
          targetType: 'org_unit',
          targetId: 'ou_1',
          userId: 'user_1',
        }),
      }),
    )
  })
})
