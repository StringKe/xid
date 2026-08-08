// Management API v1 /v1/organizations/:orgId/access-requests + PATCH /v1/projects access_policy 测试
// (设计 docs/design/org-structure-access/design-access-request.md 3.3 + 第 5 节相关项):
//   - guard:无凭证 401、API key scope 不足 403、org manager cookie session 放行。
//   - 列表:?status= / ?project_id= 过滤、cursor 分页、读取时惰性过期(pending 超 14 天翻 expired)。
//   - 详情:跨 org / 跨租户 id 一律 404,不泄露存在性。
//   - PATCH access_policy:三模式合法值 200 + 审计 project.access_policy_changed(old/new);
//     非法值 422;同值重写不发专用事件。
// D1 用 node:sqlite 内存库 + 全量 migration 链,SqliteD1 与 org-units.test.ts 同源。

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
import { registerAccessRequestsRoutes } from '../access-requests'
import { registerProjects } from '../projects'

// cookie session 路径(requireOrgManager)的 MFA/验证门控同 org-units.test.ts mock 掉。
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

// organizations 有层级触发器(0007 migration):顶层 org id=tenant_id 且 parent 为空先行。
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

function seedProject(
  db: SqliteD1,
  input: { id: string; tenantId?: string; orgId?: string; accessPolicy?: string },
): void {
  db.database
    .prepare(
      `INSERT INTO projects (id, tenant_id, org_id, name, status, access_policy, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, 1000, 1000)`,
    )
    .run(
      input.id,
      input.tenantId ?? 't_1',
      input.orgId ?? 'org_1',
      input.id,
      input.accessPolicy ?? 'open',
    )
}

function seedAccessRequest(
  db: SqliteD1,
  input: {
    id: string
    tenantId?: string
    orgId?: string
    projectId: string
    requesterUserId?: string
    status?: string
    createdAt?: number
  },
): void {
  const createdAt = input.createdAt ?? Date.now()
  db.database
    .prepare(
      `INSERT INTO access_requests (
         id, tenant_id, org_id, project_id, role_id, requester_user_id, justification,
         status, approver_user_id, decided_at, decision_reason, grant_expires_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, NULL, NULL, NULL, NULL, ?, ?)`,
    )
    .run(
      input.id,
      input.tenantId ?? 't_1',
      input.orgId ?? 'org_1',
      input.projectId,
      input.requesterUserId ?? 'user_req',
      input.status ?? 'pending',
      createdAt,
      createdAt,
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
  registerAccessRequestsRoutes(app)
  registerProjects(app)
  return app
}

// emitManagementAuditAsync 无 executionCtx 时走 task.catch 兜底,send 必须返回 Promise。
function envOf(db: SqliteD1, auditSend: ReturnType<typeof vi.fn>): Env {
  return asUnknown<Env>({
    DB: db as unknown as D1Database,
    AUDIT_QUEUE: { send: auditSend },
  })
}

function makeAuditSend() {
  return vi.fn().mockResolvedValue(undefined)
}

const BASE = 'https://acme.xid.dev/v1/organizations'

// 标准夹具:顶层 org + org_1 + approval_required project。
function seedBase(db: SqliteD1): void {
  seedOrganization(db, 't_1', 't_1')
  seedOrganization(db, 'org_1', 't_1')
  seedProject(db, { id: 'proj_1', accessPolicy: 'approval_required' })
}

// ---- guard(设计 3.3:API key 或 org manager) ----

describe('v1 access-requests guard', () => {
  it('无凭证 -> 401 unauthorized', async () => {
    const db = makeDb()
    seedBase(db)
    const app = buildApp()
    const res = await app.request(
      `${BASE}/org_1/access-requests`,
      { method: 'GET' },
      envOf(db, makeAuditSend()),
    )
    expect(res.status).toBe(401)
  })

  it('API key scope 不足 -> 403 insufficient_permission', async () => {
    const db = makeDb()
    seedBase(db)
    const token = await seedApiKey(db, { id: 'ak_readonly', scopes: ['users:read'] })
    const app = buildApp()
    const res = await app.request(
      `${BASE}/org_1/access-requests`,
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      envOf(db, makeAuditSend()),
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('insufficient_permission')
  })

  it('org manager cookie session 放行(无需 API key scope)', async () => {
    const db = makeDb()
    seedBase(db)
    seedAccessRequest(db, { id: 'ar_1', projectId: 'proj_1' })
    db.database
      .prepare(
        `INSERT INTO manager_assignments (
           id, tenant_id, user_id, manager_role, scope_type, scope_id, created_at, updated_at
         ) VALUES ('mgr_1', 't_1', 'user_mgr', 'org_manager', 'org', 'org_1', 1000, 1000)`,
      )
      .run()
    const session = asUnknown<SessionData>({ userId: 'user_mgr' })
    const app = buildApp(session)
    const res = await app.request(
      `${BASE}/org_1/access-requests`,
      { method: 'GET' },
      envOf(db, makeAuditSend()),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((row) => row.id)).toEqual(['ar_1'])
  })

  it('access-requests:read key 可读列表与详情', async () => {
    const db = makeDb()
    seedBase(db)
    seedAccessRequest(db, { id: 'ar_1', projectId: 'proj_1' })
    const token = await seedApiKey(db, { id: 'ak_ar', scopes: ['access-requests:read'] })
    const app = buildApp()
    const env = envOf(db, makeAuditSend())
    const headers = { Authorization: `Bearer ${token}` }

    const list = await app.request(`${BASE}/org_1/access-requests`, { headers }, env)
    expect(list.status).toBe(200)

    const detail = await app.request(`${BASE}/org_1/access-requests/ar_1`, { headers }, env)
    expect(detail.status).toBe(200)
    const body = (await detail.json()) as Record<string, unknown>
    expect(body['id']).toBe('ar_1')
    expect(body['project_id']).toBe('proj_1')
    expect(body['status']).toBe('pending')
    expect(body['tenant_id']).toBeUndefined()
  })
})

// ---- 列表过滤 / 分页 / 惰性过期 ----

describe('v1 access-requests 列表', () => {
  it('?status= 过滤;非法 status -> 422', async () => {
    const db = makeDb()
    seedBase(db)
    seedAccessRequest(db, { id: 'ar_a', projectId: 'proj_1', status: 'approved' })
    seedAccessRequest(db, { id: 'ar_b', projectId: 'proj_1', status: 'denied' })
    seedAccessRequest(db, { id: 'ar_c', projectId: 'proj_1', status: 'pending' })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const app = buildApp()
    const env = envOf(db, makeAuditSend())
    const headers = { Authorization: `Bearer ${token}` }

    const pending = await app.request(
      `${BASE}/org_1/access-requests?status=pending`,
      { headers },
      env,
    )
    expect(pending.status).toBe(200)
    const body = (await pending.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((row) => row.id)).toEqual(['ar_c'])

    const invalid = await app.request(
      `${BASE}/org_1/access-requests?status=bogus`,
      { headers },
      env,
    )
    expect(invalid.status).toBe(422)
    const invalidBody = (await invalid.json()) as Record<string, unknown>
    expect(invalidBody['code']).toBe('validation_failed')
  })

  it('?project_id= 过滤', async () => {
    const db = makeDb()
    seedBase(db)
    seedProject(db, { id: 'proj_2', accessPolicy: 'approval_required' })
    seedAccessRequest(db, { id: 'ar_1', projectId: 'proj_1' })
    seedAccessRequest(db, { id: 'ar_2', projectId: 'proj_2' })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const app = buildApp()
    const res = await app.request(
      `${BASE}/org_1/access-requests?project_id=proj_2`,
      { headers: { Authorization: `Bearer ${token}` } },
      envOf(db, makeAuditSend()),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((row) => row.id)).toEqual(['ar_2'])
  })

  it('limit + next_cursor 翻页', async () => {
    const db = makeDb()
    seedBase(db)
    seedProject(db, { id: 'proj_2' })
    seedProject(db, { id: 'proj_3' })
    seedAccessRequest(db, { id: 'ar_a', projectId: 'proj_1' })
    seedAccessRequest(db, { id: 'ar_b', projectId: 'proj_2' })
    seedAccessRequest(db, { id: 'ar_c', projectId: 'proj_3' })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const app = buildApp()
    const env = envOf(db, makeAuditSend())
    const headers = { Authorization: `Bearer ${token}` }

    const page1 = await app.request(`${BASE}/org_1/access-requests?limit=2`, { headers }, env)
    expect(page1.status).toBe(200)
    const body1 = (await page1.json()) as {
      data: Array<{ id: string }>
      next_cursor: string | null
      has_more: boolean
    }
    expect(body1.data.map((row) => row.id)).toEqual(['ar_a', 'ar_b'])
    expect(body1.has_more).toBe(true)
    expect(body1.next_cursor).not.toBeNull()

    const page2 = await app.request(
      `${BASE}/org_1/access-requests?limit=2&cursor=${body1.next_cursor}`,
      { headers },
      env,
    )
    expect(page2.status).toBe(200)
    const body2 = (await page2.json()) as {
      data: Array<{ id: string }>
      next_cursor: string | null
      has_more: boolean
    }
    expect(body2.data.map((row) => row.id)).toEqual(['ar_c'])
    expect(body2.has_more).toBe(false)
    expect(body2.next_cursor).toBeNull()
  })

  it('读取时惰性过期:pending 超 14 天翻 expired + 审计 access_request.expired', async () => {
    const db = makeDb()
    seedBase(db)
    // created_at = 1000(epoch 毫秒),远超 ACCESS_REQUEST_TTL_MS(14 天)。
    seedAccessRequest(db, { id: 'ar_old', projectId: 'proj_1', createdAt: 1000 })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const auditSend = makeAuditSend()
    const app = buildApp()
    const res = await app.request(
      `${BASE}/org_1/access-requests`,
      { headers: { Authorization: `Bearer ${token}` } },
      envOf(db, auditSend),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ id: string; status: string }> }
    expect(body.data).toEqual(
      [{ id: 'ar_old', status: 'expired' }].map((row) => expect.objectContaining(row)),
    )
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'access_request.expired',
        payload: expect.objectContaining({ requestId: 'ar_old', projectId: 'proj_1' }),
      }),
    )
    // 翻转已落库,二次读取保持 expired。
    const stored = db.database
      .prepare(`SELECT status FROM access_requests WHERE id = 'ar_old'`)
      .get() as { status: string }
    expect(stored.status).toBe('expired')
  })

  it('?status=pending 过滤时惰性翻转行不再命中', async () => {
    const db = makeDb()
    seedBase(db)
    seedAccessRequest(db, { id: 'ar_old', projectId: 'proj_1', createdAt: 1000 })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const app = buildApp()
    const res = await app.request(
      `${BASE}/org_1/access-requests?status=pending`,
      { headers: { Authorization: `Bearer ${token}` } },
      envOf(db, makeAuditSend()),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ id: string }> }
    expect(body.data).toEqual([])
  })

  it('?status=pending 分页:本页含过期行时 has_more 不假阴性,后续有效页可见', async () => {
    const db = makeDb()
    seedBase(db)
    // ar_00 过期 pending(created_at 远超 TTL);ar_01/ar_02 为有效 pending,id 字典序在过期行之后。
    // (tenant_id, project_id, requester_user_id) 唯一,三行用不同 requester。
    seedAccessRequest(db, {
      id: 'ar_00',
      projectId: 'proj_1',
      requesterUserId: 'user_r0',
      createdAt: 1000,
    })
    seedAccessRequest(db, { id: 'ar_01', projectId: 'proj_1', requesterUserId: 'user_r1' })
    seedAccessRequest(db, { id: 'ar_02', projectId: 'proj_1', requesterUserId: 'user_r2' })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const app = buildApp()
    const env = envOf(db, makeAuditSend())
    const headers = { Authorization: `Bearer ${token}` }

    const page1 = await app.request(
      `${BASE}/org_1/access-requests?status=pending&limit=1`,
      { headers },
      env,
    )
    expect(page1.status).toBe(200)
    const body1 = (await page1.json()) as {
      data: Array<{ id: string }>
      next_cursor: string | null
      has_more: boolean
    }
    // SQL 层已剔除必过期的 ar_00:第一页是 ar_01,且 has_more 为 true(修复前翻转会剔除 ar_00
    // 导致 visible 缩水、has_more=false,客户端提前停止翻页)。
    expect(body1.data.map((row) => row.id)).toEqual(['ar_01'])
    expect(body1.has_more).toBe(true)
    expect(body1.next_cursor).not.toBeNull()

    const page2 = await app.request(
      `${BASE}/org_1/access-requests?status=pending&limit=1&cursor=${body1.next_cursor}`,
      { headers },
      env,
    )
    expect(page2.status).toBe(200)
    const body2 = (await page2.json()) as {
      data: Array<{ id: string }>
      next_cursor: string | null
      has_more: boolean
    }
    expect(body2.data.map((row) => row.id)).toEqual(['ar_02'])
    expect(body2.has_more).toBe(false)
    expect(body2.next_cursor).toBeNull()
  })
})

// ---- 详情 404(跨 org / 跨租户不泄露存在性) ----

describe('v1 access-requests 详情隔离', () => {
  it('request id 属于同租户另一 org -> 404 not_found', async () => {
    const db = makeDb()
    seedBase(db)
    seedOrganization(db, 'org_2', 't_1')
    seedAccessRequest(db, { id: 'ar_other', orgId: 'org_2', projectId: 'proj_1' })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const app = buildApp()
    const res = await app.request(
      `${BASE}/org_1/access-requests/ar_other`,
      { headers: { Authorization: `Bearer ${token}` } },
      envOf(db, makeAuditSend()),
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('not_found')
  })

  it('request id 属于别的租户 -> 404 not_found', async () => {
    const db = makeDb()
    seedBase(db)
    seedOrganization(db, 't_other', 't_other')
    seedOrganization(db, 'org_victim', 't_other')
    seedProject(db, { id: 'proj_victim', tenantId: 't_other', orgId: 'org_victim' })
    seedAccessRequest(db, {
      id: 'ar_victim',
      tenantId: 't_other',
      orgId: 'org_victim',
      projectId: 'proj_victim',
    })
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const app = buildApp()
    const res = await app.request(
      `${BASE}/org_1/access-requests/ar_victim`,
      { headers: { Authorization: `Bearer ${token}` } },
      envOf(db, makeAuditSend()),
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('not_found')
  })

  it('org 属于别的租户 -> 404 org_not_found', async () => {
    const db = makeDb()
    seedOrganization(db, 't_other', 't_other')
    seedOrganization(db, 'org_victim', 't_other')
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const app = buildApp()
    const res = await app.request(
      `${BASE}/org_victim/access-requests`,
      { headers: { Authorization: `Bearer ${token}` } },
      envOf(db, makeAuditSend()),
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('org_not_found')
  })
})

// ---- PATCH /v1/projects/:id access_policy(设计 3.3 + 3.4) ----

describe('v1 projects PATCH access_policy', () => {
  it('合法值更新成功 + 审计 project.access_policy_changed(old/new)', async () => {
    const db = makeDb()
    seedBase(db) // proj_1 access_policy = approval_required
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const auditSend = makeAuditSend()
    const app = buildApp()
    const res = await app.request(
      'https://acme.xid.dev/v1/projects/proj_1',
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_policy: 'restricted' }),
      },
      envOf(db, auditSend),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['access_policy']).toBe('restricted')

    const stored = db.database
      .prepare(`SELECT access_policy FROM projects WHERE id = 'proj_1'`)
      .get() as { access_policy: string }
    expect(stored.access_policy).toBe('restricted')

    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'project.access_policy_changed',
        payload: expect.objectContaining({
          targetType: 'project',
          targetId: 'proj_1',
          oldAccessPolicy: 'approval_required',
          newAccessPolicy: 'restricted',
        }),
      }),
    )
  })

  it('非法值 -> 422 validation_failed,不落库', async () => {
    const db = makeDb()
    seedBase(db)
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const app = buildApp()
    const res = await app.request(
      'https://acme.xid.dev/v1/projects/proj_1',
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_policy: 'invite_only' }),
      },
      envOf(db, makeAuditSend()),
    )
    expect(res.status).toBe(422)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['code']).toBe('validation_failed')
    const stored = db.database
      .prepare(`SELECT access_policy FROM projects WHERE id = 'proj_1'`)
      .get() as { access_policy: string }
    expect(stored.access_policy).toBe('approval_required')
  })

  it('同值重写不发 project.access_policy_changed', async () => {
    const db = makeDb()
    seedBase(db)
    const token = await seedApiKey(db, { id: 'ak_1', scopes: ['*'] })
    const auditSend = makeAuditSend()
    const app = buildApp()
    const res = await app.request(
      'https://acme.xid.dev/v1/projects/proj_1',
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_policy: 'approval_required' }),
      },
      envOf(db, auditSend),
    )
    expect(res.status).toBe(200)
    const policyEvents = auditSend.mock.calls.filter(
      (call) => (call[0] as { action: string }).action === 'project.access_policy_changed',
    )
    expect(policyEvents).toEqual([])
  })
})
