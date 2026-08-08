// /auth/access-requests + /auth/access-approvals 测试
// (设计 docs/design/org-structure-access/design-access-request.md 第 5 节 2/5/6/7 项):
//   - 状态机:pending -> approved(grant 落库 + 溯源 id + expires_at)/ denied(reason 必填)/
//     cancelled(仅本人)/ expired(14 天惰性翻转);终态互斥(二次 approve 409)。
//   - JIT 续期:grant 过期 -> 重新申请 -> approve 复活原行(expires_at/溯源 id 更新,不插新行);
//     复活组合:无旧行插入 / 旧行有效幂等 / 旧行过期复活。
//   - 审批人解析:unit manager 命中 / 回溯祖先 / 命中本人顺延 / project_manager 回落 /
//     org_manager 兜底 / 链空 409;候选人无 active membership 顺延下一级。
//   - 权限边界:非 approver 403、approver 无 active membership 403、跨租户 request id 404、
//     审批人不能审自己。
//   - 并发:双 pending 被 partial unique index 拒一个;条件 UPDATE 二次 approve 409;
//     同 (user, project, role) 已有未 revoked grant 时 approve 不重复插行。
//   - 收件箱:解析缓存(unit 链按 requester / org_manager 至多一次)经 queryLog 计数断言。
//   - 审计:send 的 Promise 挂 executionCtx.waitUntil;send reject 时响应仍 200,catch 后 log。
// D1 用 node:sqlite 内存库 + 全量 migration 链(真实唯一索引/条件 UPDATE/batch 语义),
// SqliteD1 与 worker/v1/__tests__/org-units.test.ts 同源。

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import type { TenantContext } from '@xid-kit/types'
import type { SessionData, XidHonoEnv } from '../../worker/lib/types'
import { isAppError } from '../../worker/lib/errors'
import {
  handleAccessApprovalApprove,
  handleAccessApprovalDeny,
  handleAccessApprovalList,
  handleAccessRequestCancel,
  handleAccessRequestCreate,
  handleAccessRequestListMine,
} from '../../worker/me-auth/access-requests'

const migrationDir = fileURLToPath(new URL('../../../../packages/db/drizzle/', import.meta.url))

function applyMigrations(db: DatabaseSync): void {
  for (const file of readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(migrationDir, file), 'utf8'))
  }
}

// ---- SqliteD1:node:sqlite 内存库包装成 D1Database ----

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
    this.owner.queryLog.push(this.sql)
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
    this.owner.queryLog.push(this.sql)
    const statement = this.owner.database.prepare(this.sql)
    return {
      success: true,
      results: statement.all(...(this.bindings as never[])) as T[],
      meta: { changes: 0 },
    } as unknown as D1Result<T>
  }

  async first<T = SqliteRow>(): Promise<T | null> {
    this.owner.queryLog.push(this.sql)
    const statement = this.owner.database.prepare(this.sql)
    return (statement.get(...(this.bindings as never[])) as T | undefined) ?? null
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    this.owner.queryLog.push(this.sql)
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
  // 执行过的 SQL 文本(收件箱解析缓存用例按表名计数断言 N+1 消除)。
  readonly queryLog: string[] = []

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

// organizations 层级触发器(0007 migration):顶层 org id=tenant_id 且 parent 为空先行。
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

function seedProject(
  db: SqliteD1,
  input: {
    id: string
    tenantId?: string
    orgId?: string
    accessPolicy?: string
    status?: string
  },
): void {
  db.database
    .prepare(
      `INSERT INTO projects (id, tenant_id, org_id, name, status, access_policy, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1000, 1000)`,
    )
    .run(
      input.id,
      input.tenantId ?? 't_1',
      input.orgId ?? 'org_1',
      input.id,
      input.status ?? 'active',
      input.accessPolicy ?? 'approval_required',
    )
}

function seedRole(db: SqliteD1, input: { id: string; projectId: string; key?: string }): void {
  db.database
    .prepare(
      `INSERT INTO roles (id, tenant_id, project_id, key, display_name, status, created_at, updated_at)
       VALUES (?, 't_1', ?, ?, ?, 'active', 1000, 1000)`,
    )
    .run(input.id, input.projectId, input.key ?? input.id, input.id)
}

function seedManagerAssignment(
  db: SqliteD1,
  input: {
    id: string
    userId: string
    managerRole: string
    scopeType: string
    scopeId: string | null
    createdAt?: number
  },
): void {
  db.database
    .prepare(
      `INSERT INTO manager_assignments (
         id, tenant_id, user_id, manager_role, scope_type, scope_id, created_at, updated_at
       ) VALUES (?, 't_1', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.userId,
      input.managerRole,
      input.scopeType,
      input.scopeId,
      input.createdAt ?? 1000,
      input.createdAt ?? 1000,
    )
}

function seedUnit(
  db: SqliteD1,
  input: {
    id: string
    parentUnitId?: string | null
    path?: string
    depth?: number
    managerUserId?: string | null
    status?: string
  },
): void {
  db.database
    .prepare(
      `INSERT INTO org_units (
         id, tenant_id, org_id, parent_unit_id, path, depth, slug, name,
         manager_user_id, status, created_at, updated_at
       ) VALUES (?, 't_1', 'org_1', ?, ?, ?, ?, ?, ?, ?, 1000, 1000)`,
    )
    .run(
      input.id,
      input.parentUnitId ?? null,
      input.path ?? `/${input.id}`,
      input.depth ?? 1,
      input.id,
      input.id,
      input.managerUserId ?? null,
      input.status ?? 'active',
    )
}

function seedUnitMember(
  db: SqliteD1,
  input: { id: string; unitId: string; userId: string; isPrimary?: boolean },
): void {
  db.database
    .prepare(
      `INSERT INTO org_unit_members (
         id, tenant_id, org_id, unit_id, user_id, is_primary, created_at, updated_at
       ) VALUES (?, 't_1', 'org_1', ?, ?, ?, 1000, 1000)`,
    )
    .run(input.id, input.unitId, input.userId, input.isPrimary === false ? 0 : 1)
}

function seedAccessRequest(
  db: SqliteD1,
  input: {
    id: string
    tenantId?: string
    orgId?: string
    projectId: string
    roleId?: string | null
    requesterUserId: string
    status?: string
    createdAt?: number
  },
): void {
  db.database
    .prepare(
      `INSERT INTO access_requests (
         id, tenant_id, org_id, project_id, role_id, requester_user_id, justification,
         status, approver_user_id, decided_at, decision_reason, grant_expires_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, ?, ?)`,
    )
    .run(
      input.id,
      input.tenantId ?? 't_1',
      input.orgId ?? 'org_1',
      input.projectId,
      input.roleId ?? null,
      input.requesterUserId,
      input.status ?? 'pending',
      input.createdAt ?? 1000,
      input.createdAt ?? 1000,
    )
}

function seedUserGrant(
  db: SqliteD1,
  input: { id: string; userId: string; projectId: string; roleId: string },
): void {
  db.database
    .prepare(
      `INSERT INTO user_grants (
         id, tenant_id, user_id, project_id, role_id,
         granted_via_grant_id, granted_via_request_id, expires_at, revoked_at,
         created_at, updated_at
       ) VALUES (?, 't_1', ?, ?, ?, NULL, NULL, NULL, NULL, 1000, 1000)`,
    )
    .run(input.id, input.userId, input.projectId, input.roleId)
}

// ---- app harness ----

function buildApp(session: SessionData | null): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  // 最小 onError:直接读 AppError.code/httpStatus,不引 i18n 中间件。
  app.onError((err, c) => {
    if (isAppError(err)) return c.json({ code: err.code }, err.httpStatus as 400)
    return c.json({ code: 'server_error' }, 500)
  })
  app.use('*', async (c, next) => {
    c.set('tenant', TENANT)
    c.set('session', session)
    await next()
  })
  // 与 me-auth/index.ts 注册路径一致。
  app.post('/auth/access-requests', handleAccessRequestCreate)
  app.get('/auth/access-requests', handleAccessRequestListMine)
  app.post('/auth/access-requests/:id/cancel', handleAccessRequestCancel)
  app.get('/auth/access-approvals', handleAccessApprovalList)
  app.post('/auth/access-approvals/:id/approve', handleAccessApprovalApprove)
  app.post('/auth/access-approvals/:id/deny', handleAccessApprovalDeny)
  return app
}

function makeSession(userId: string, activeOrgId: string | null = 'org_1'): SessionData {
  return asUnknown<SessionData>({ userId, status: 'active', activeOrgId })
}

// 审计走 waitUntil/catch 后 send 必须返回 Promise(与真实 Queue 对齐);auditSend 同步记录参数。
function envWithAuditSend(db: SqliteD1, send: (message: unknown) => Promise<void>): Env {
  return asUnknown<Env>({
    DB: db as unknown as D1Database,
    AUDIT_QUEUE: { send },
  })
}

function envOf(db: SqliteD1, auditSend: ReturnType<typeof vi.fn>): Env {
  return envWithAuditSend(db, (message) => Promise.resolve(auditSend(message)))
}

function post(app: Hono<XidHonoEnv>, env: Env, path: string, body?: unknown) {
  return app.request(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  )
}

// 标准夹具:tenant 顶层 org + org_1 + 申请人 membership + approval_required project + role。
function seedBase(db: SqliteD1): void {
  seedOrganization(db, 't_1', 't_1')
  seedOrganization(db, 'org_1', 't_1')
  seedMembership(db, { id: 'mem_req', userId: 'user_req' })
  seedProject(db, { id: 'proj_1' })
  seedRole(db, { id: 'role_admin', projectId: 'proj_1' })
  seedRole(db, { id: 'role_viewer', projectId: 'proj_1' })
}

async function createRequest(
  app: Hono<XidHonoEnv>,
  env: Env,
  body: Record<string, unknown> = { project_id: 'proj_1' },
): Promise<Response> {
  return post(app, env, '/auth/access-requests', body)
}

// ---- 自助申请(设计 3.1 + 5.2 创建路径) ----

describe('POST /auth/access-requests', () => {
  it('创建成功 -> 201 pending + 审计 access_request.created', async () => {
    const db = makeDb()
    seedBase(db)
    const auditSend = vi.fn()
    const app = buildApp(makeSession('user_req'))
    const res = await createRequest(app, envOf(db, auditSend), {
      project_id: 'proj_1',
      role_id: 'role_admin',
      justification: 'need deploy access',
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { request: Record<string, unknown> }
    expect(body.request['status']).toBe('pending')
    expect(body.request['roleId']).toBe('role_admin')
    expect(String(body.request['id'])).toMatch(/^ar_/)
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'access_request.created',
        actorId: 'user_req',
        payload: expect.objectContaining({ projectId: 'proj_1', roleId: 'role_admin' }),
      }),
    )
  })

  it('policy 非 approval_required -> 404 project_not_found(枚举防护)', async () => {
    const db = makeDb()
    seedBase(db)
    seedProject(db, { id: 'proj_open', accessPolicy: 'open' })
    const app = buildApp(makeSession('user_req'))
    const res = await createRequest(app, envOf(db, vi.fn()), { project_id: 'proj_open' })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { code: string }).code).toBe('project_not_found')
  })

  it('project 属于同租户另一 org -> 404 project_not_found', async () => {
    const db = makeDb()
    seedBase(db)
    seedOrganization(db, 'org_2', 't_1')
    seedProject(db, { id: 'proj_other', orgId: 'org_2' })
    const app = buildApp(makeSession('user_req'))
    const res = await createRequest(app, envOf(db, vi.fn()), { project_id: 'proj_other' })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { code: string }).code).toBe('project_not_found')
  })

  it('已有有效 grant -> 409 grant_already_exists;grant 已过期则允许申请', async () => {
    const db = makeDb()
    seedBase(db)
    seedUserGrant(db, { id: 'ug_1', userId: 'user_req', projectId: 'proj_1', roleId: 'role_admin' })
    const app = buildApp(makeSession('user_req'))
    const env = envOf(db, vi.fn())
    const dup = await createRequest(app, env)
    expect(dup.status).toBe(409)
    expect(((await dup.json()) as { code: string }).code).toBe('grant_already_exists')

    db.database.prepare(`UPDATE user_grants SET expires_at = 1 WHERE id = 'ug_1'`).run()
    const ok = await createRequest(app, env)
    expect(ok.status).toBe(201)
  })

  it('同 (user, project) 多行:过期 role_admin + 有效 role_viewer -> 409 grant_already_exists', async () => {
    const db = makeDb()
    seedBase(db)
    // 复活/多 role 场景下同 (user, project) 可有多行;任一有效行都必须拦创建,
    // 不能被无 ORDER BY 的单行查询命中过期行而放行。
    seedUserGrant(db, {
      id: 'ug_expired',
      userId: 'user_req',
      projectId: 'proj_1',
      roleId: 'role_admin',
    })
    db.database.prepare(`UPDATE user_grants SET expires_at = 1 WHERE id = 'ug_expired'`).run()
    seedUserGrant(db, {
      id: 'ug_live',
      userId: 'user_req',
      projectId: 'proj_1',
      roleId: 'role_viewer',
    })
    const app = buildApp(makeSession('user_req'))
    const res = await createRequest(app, envOf(db, vi.fn()))
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('grant_already_exists')
  })

  it('重复 pending -> 409 already_exists', async () => {
    const db = makeDb()
    seedBase(db)
    const app = buildApp(makeSession('user_req'))
    const env = envOf(db, vi.fn())
    expect((await createRequest(app, env)).status).toBe(201)
    const dup = await createRequest(app, env)
    expect(dup.status).toBe(409)
    expect(((await dup.json()) as { code: string }).code).toBe('already_exists')
  })

  it('并发双 pending:partial unique index 拒一个(直接 SQL 竞态模拟)', async () => {
    const db = makeDb()
    seedBase(db)
    seedAccessRequest(db, { id: 'ar_1', projectId: 'proj_1', requesterUserId: 'user_req' })
    // 同 (tenant, project, requester) 第二个 pending 撞 partial unique index。
    expect(() =>
      seedAccessRequest(db, { id: 'ar_2', projectId: 'proj_1', requesterUserId: 'user_req' }),
    ).toThrow(/UNIQUE constraint failed/)
    // 已 pending 时 API 创建 -> 409。
    const app = buildApp(makeSession('user_req'))
    const res = await createRequest(app, envOf(db, vi.fn()))
    expect(res.status).toBe(409)
  })

  it('无 active membership -> 404 membership_not_found;无 active org -> 404', async () => {
    const db = makeDb()
    seedBase(db)
    const app = buildApp(makeSession('user_stranger'))
    const res = await createRequest(app, envOf(db, vi.fn()))
    expect(res.status).toBe(404)
    expect(((await res.json()) as { code: string }).code).toBe('membership_not_found')

    const noOrg = buildApp(makeSession('user_req', null))
    const res2 = await createRequest(noOrg, envOf(db, vi.fn()))
    expect(res2.status).toBe(404)
  })
})

// ---- 状态机(设计 5.2) ----

describe('状态机转移', () => {
  it('pending -> approved:user_grants 落库(溯源 id + expires_at)+ 审计 approved', async () => {
    const db = makeDb()
    seedBase(db)
    seedUnit(db, { id: 'ou_1', managerUserId: 'user_mgr' })
    seedUnitMember(db, { id: 'oum_1', unitId: 'ou_1', userId: 'user_req' })
    seedMembership(db, { id: 'mem_mgr', userId: 'user_mgr' })
    const auditSend = vi.fn()
    const env = envOf(db, auditSend)
    const requester = buildApp(makeSession('user_req'))
    const created = await createRequest(requester, env, {
      project_id: 'proj_1',
      role_id: 'role_admin',
    })
    const requestId = ((await created.json()) as { request: { id: string } }).request.id

    const approver = buildApp(makeSession('user_mgr'))
    const expiresAt = Date.now() + 3600_000
    const res = await post(approver, env, `/auth/access-approvals/${requestId}/approve`, {
      grant_expires_at: expiresAt,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { request: Record<string, unknown> }
    expect(body.request['status']).toBe('approved')
    expect(body.request['approverUserId']).toBe('user_mgr')

    const grant = db.database
      .prepare(`SELECT * FROM user_grants WHERE tenant_id = 't_1' AND user_id = 'user_req'`)
      .get() as SqliteRow
    expect(grant['role_id']).toBe('role_admin')
    expect(grant['granted_via_request_id']).toBe(requestId)
    expect(grant['expires_at']).toBe(expiresAt)
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'access_request.approved',
        actorId: 'user_mgr',
        payload: expect.objectContaining({
          requestId,
          requesterUserId: 'user_req',
          roleId: 'role_admin',
          grantExpiresAt: new Date(expiresAt).toISOString(),
        }),
      }),
    )
  })

  it('终态互斥:二次 approve -> 409 request_already_decided(条件 UPDATE)', async () => {
    const db = makeDb()
    seedBase(db)
    seedUnit(db, { id: 'ou_1', managerUserId: 'user_mgr' })
    seedUnitMember(db, { id: 'oum_1', unitId: 'ou_1', userId: 'user_req' })
    seedMembership(db, { id: 'mem_mgr', userId: 'user_mgr' })
    seedAccessRequest(db, {
      id: 'ar_1',
      projectId: 'proj_1',
      roleId: 'role_admin',
      requesterUserId: 'user_req',
      createdAt: Date.now(),
    })
    const approver = buildApp(makeSession('user_mgr'))
    const env = envOf(db, vi.fn())
    expect((await post(approver, env, '/auth/access-approvals/ar_1/approve', {})).status).toBe(200)
    const second = await post(approver, env, '/auth/access-approvals/ar_1/approve', {})
    expect(second.status).toBe(409)
    expect(((await second.json()) as { code: string }).code).toBe('request_already_decided')
  })

  it('request 带 role_id 审批人不可改;未带则 body 必填(缺 -> 422)', async () => {
    const db = makeDb()
    seedBase(db)
    seedUnit(db, { id: 'ou_1', managerUserId: 'user_mgr' })
    seedUnitMember(db, { id: 'oum_1', unitId: 'ou_1', userId: 'user_req' })
    seedMembership(db, { id: 'mem_mgr', userId: 'user_mgr' })
    seedMembership(db, { id: 'mem_req2', userId: 'user_req2' })
    seedUnitMember(db, { id: 'oum_2', unitId: 'ou_1', userId: 'user_req2' })
    seedAccessRequest(db, {
      id: 'ar_fixed',
      projectId: 'proj_1',
      roleId: 'role_admin',
      requesterUserId: 'user_req',
      createdAt: Date.now(),
    })
    // 同 (tenant, project, requester) 至多一个 pending(partial unique index),第二件换 requester。
    seedAccessRequest(db, {
      id: 'ar_open',
      projectId: 'proj_1',
      requesterUserId: 'user_req2',
      createdAt: Date.now(),
    })
    const approver = buildApp(makeSession('user_mgr'))
    const env = envOf(db, vi.fn())
    // request 带 role_admin,body 给 role_viewer -> 以 request 为准。
    const fixed = await post(approver, env, '/auth/access-approvals/ar_fixed/approve', {
      role_id: 'role_viewer',
    })
    expect(fixed.status).toBe(200)
    const grant = db.database
      .prepare(`SELECT role_id FROM user_grants WHERE granted_via_request_id = 'ar_fixed'`)
      .get() as SqliteRow
    expect(grant['role_id']).toBe('role_admin')
    // request 未带 role,body 缺 -> 422。
    const missing = await post(approver, env, '/auth/access-approvals/ar_open/approve', {})
    expect(missing.status).toBe(422)
    // body 补上 -> 200 且按 body role 落 grant。
    const chosen = await post(approver, env, '/auth/access-approvals/ar_open/approve', {
      role_id: 'role_viewer',
    })
    expect(chosen.status).toBe(200)
    const grant2 = db.database
      .prepare(`SELECT role_id FROM user_grants WHERE granted_via_request_id = 'ar_open'`)
      .get() as SqliteRow
    expect(grant2['role_id']).toBe('role_viewer')
  })

  it('pending -> denied:reason 必填(缺 -> 422),deny 后审计 denied', async () => {
    const db = makeDb()
    seedBase(db)
    seedUnit(db, { id: 'ou_1', managerUserId: 'user_mgr' })
    seedUnitMember(db, { id: 'oum_1', unitId: 'ou_1', userId: 'user_req' })
    seedMembership(db, { id: 'mem_mgr', userId: 'user_mgr' })
    seedAccessRequest(db, {
      id: 'ar_1',
      projectId: 'proj_1',
      requesterUserId: 'user_req',
      createdAt: Date.now(),
    })
    const auditSend = vi.fn()
    const approver = buildApp(makeSession('user_mgr'))
    const env = envOf(db, auditSend)
    const noReason = await post(approver, env, '/auth/access-approvals/ar_1/deny', {})
    expect(noReason.status).toBe(422)
    const res = await post(approver, env, '/auth/access-approvals/ar_1/deny', {
      decision_reason: 'not in project scope',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { request: Record<string, unknown> }
    expect(body.request['status']).toBe('denied')
    expect(body.request['decisionReason']).toBe('not in project scope')
    expect(
      db.database.prepare(`SELECT count(*) AS n FROM user_grants WHERE tenant_id = 't_1'`).get(),
    ).toEqual({ n: 0 })
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'access_request.denied',
        payload: expect.objectContaining({ decisionReason: 'not in project scope' }),
      }),
    )
  })

  it('pending -> cancelled:仅本人;他人 404;终态后 409', async () => {
    const db = makeDb()
    seedBase(db)
    seedAccessRequest(db, {
      id: 'ar_1',
      projectId: 'proj_1',
      requesterUserId: 'user_req',
      createdAt: Date.now(),
    })
    const auditSend = vi.fn()
    const env = envOf(db, auditSend)
    // 他人取消 -> 404(不泄露存在性)。
    const other = buildApp(makeSession('user_other'))
    expect((await post(other, env, '/auth/access-requests/ar_1/cancel', {})).status).toBe(404)
    // 本人取消 -> 200 cancelled + 审计。
    const owner = buildApp(makeSession('user_req'))
    const res = await post(owner, env, '/auth/access-requests/ar_1/cancel', {})
    expect(res.status).toBe(200)
    expect(((await res.json()) as { request: { status: string } }).request.status).toBe('cancelled')
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'access_request.cancelled', actorId: 'user_req' }),
    )
    // 终态再取消 -> 409。
    const again = await post(owner, env, '/auth/access-requests/ar_1/cancel', {})
    expect(again.status).toBe(409)
  })

  it('惰性过期:created_at 超 14 天的 pending 读取时翻转 expired + 审计;approve -> 409', async () => {
    const db = makeDb()
    seedBase(db)
    seedUnit(db, { id: 'ou_1', managerUserId: 'user_mgr' })
    seedUnitMember(db, { id: 'oum_1', unitId: 'ou_1', userId: 'user_req' })
    seedMembership(db, { id: 'mem_mgr', userId: 'user_mgr' })
    const stale = Date.now() - 15 * 24 * 60 * 60 * 1000
    seedAccessRequest(db, {
      id: 'ar_stale',
      projectId: 'proj_1',
      requesterUserId: 'user_req',
      createdAt: stale,
    })
    const auditSend = vi.fn()
    const env = envOf(db, auditSend)
    // 我的列表触发惰性翻转。
    const owner = buildApp(makeSession('user_req'))
    const list = await owner.request('/auth/access-requests', { method: 'GET' }, env)
    const data = ((await list.json()) as { data: Array<{ id: string; status: string }> }).data
    expect(data.find((row) => row.id === 'ar_stale')?.status).toBe('expired')
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'access_request.expired' }),
    )
    // 过期后 approve -> 409 request_already_decided(终态)。
    const approver = buildApp(makeSession('user_mgr'))
    const res = await post(approver, env, '/auth/access-approvals/ar_stale/approve', {
      role_id: 'role_admin',
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('request_already_decided')
  })

  it('已有同 (user, project, role) 未 revoked grant:approve 只翻状态不重复插行', async () => {
    const db = makeDb()
    seedBase(db)
    seedUnit(db, { id: 'ou_1', managerUserId: 'user_mgr' })
    seedUnitMember(db, { id: 'oum_1', unitId: 'ou_1', userId: 'user_req' })
    seedMembership(db, { id: 'mem_mgr', userId: 'user_mgr' })
    // 管理端直发的既有 grant(revoke 后申请人在审批前又被直接授权的场景)。
    seedUserGrant(db, {
      id: 'ug_direct',
      userId: 'user_req',
      projectId: 'proj_1',
      roleId: 'role_admin',
    })
    db.database.prepare(`UPDATE user_grants SET revoked_at = 1 WHERE id = 'ug_direct'`).run()
    seedAccessRequest(db, {
      id: 'ar_1',
      projectId: 'proj_1',
      roleId: 'role_admin',
      requesterUserId: 'user_req',
      createdAt: Date.now(),
    })
    // 审批途中管理端重新直发同 role grant(模拟竞态):先翻 revoked 置回 null。
    db.database.prepare(`UPDATE user_grants SET revoked_at = NULL WHERE id = 'ug_direct'`).run()
    const approver = buildApp(makeSession('user_mgr'))
    const res = await post(approver, envOf(db, vi.fn()), '/auth/access-approvals/ar_1/approve', {})
    expect(res.status).toBe(200)
    const count = db.database
      .prepare(
        `SELECT count(*) AS n FROM user_grants
          WHERE tenant_id = 't_1' AND user_id = 'user_req' AND project_id = 'proj_1'
            AND role_id = 'role_admin'`,
      )
      .get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('JIT 续期闭环:grant 过期 -> 重新申请 -> approve 复活原行(不静默 0 行)', async () => {
    const db = makeDb()
    seedBase(db)
    seedUnit(db, { id: 'ou_1', managerUserId: 'user_mgr' })
    seedUnitMember(db, { id: 'oum_1', unitId: 'ou_1', userId: 'user_req' })
    seedMembership(db, { id: 'mem_mgr', userId: 'user_mgr' })
    const env = envOf(db, vi.fn())
    const requester = buildApp(makeSession('user_req'))
    const approver = buildApp(makeSession('user_mgr'))
    const firstExpiry = Date.now() + 3_600_000
    const created = await createRequest(requester, env, {
      project_id: 'proj_1',
      role_id: 'role_admin',
    })
    const firstId = ((await created.json()) as { request: { id: string } }).request.id
    const first = await post(approver, env, `/auth/access-approvals/${firstId}/approve`, {
      grant_expires_at: firstExpiry,
    })
    expect(first.status).toBe(200)

    // grant 过期:重新申请(create 放行,过期 grant 视同不存在)-> approve 复活原行。
    db.database
      .prepare(`UPDATE user_grants SET expires_at = 1 WHERE granted_via_request_id = ?`)
      .run(firstId)
    const renewed = await createRequest(requester, env, {
      project_id: 'proj_1',
      role_id: 'role_admin',
    })
    expect(renewed.status).toBe(201)
    const renewId = ((await renewed.json()) as { request: { id: string } }).request.id

    const secondExpiry = Date.now() + 7_200_000
    const res = await post(approver, env, `/auth/access-approvals/${renewId}/approve`, {
      grant_expires_at: secondExpiry,
    })
    expect(res.status).toBe(200)
    const grants = db.database
      .prepare(
        `SELECT * FROM user_grants
          WHERE tenant_id = 't_1' AND user_id = 'user_req' AND project_id = 'proj_1'`,
      )
      .all() as SqliteRow[]
    // 复活而非插新行:仍一行,expires_at 与溯源 request id 更新到续期值。
    expect(grants).toHaveLength(1)
    expect(grants[0]!['expires_at']).toBe(secondExpiry)
    expect(grants[0]!['granted_via_request_id']).toBe(renewId)
  })

  it('复活组合:直接 seed 的过期旧行 approve 时被更新(expires_at + 溯源 id)而非插新行', async () => {
    const db = makeDb()
    seedBase(db)
    seedUnit(db, { id: 'ou_1', managerUserId: 'user_mgr' })
    seedUnitMember(db, { id: 'oum_1', unitId: 'ou_1', userId: 'user_req' })
    seedMembership(db, { id: 'mem_mgr', userId: 'user_mgr' })
    seedUserGrant(db, {
      id: 'ug_old',
      userId: 'user_req',
      projectId: 'proj_1',
      roleId: 'role_admin',
    })
    db.database.prepare(`UPDATE user_grants SET expires_at = 1 WHERE id = 'ug_old'`).run()
    seedAccessRequest(db, {
      id: 'ar_1',
      projectId: 'proj_1',
      roleId: 'role_admin',
      requesterUserId: 'user_req',
      createdAt: Date.now(),
    })
    const approver = buildApp(makeSession('user_mgr'))
    const newExpiry = Date.now() + 3_600_000
    const res = await post(approver, envOf(db, vi.fn()), '/auth/access-approvals/ar_1/approve', {
      grant_expires_at: newExpiry,
    })
    expect(res.status).toBe(200)
    const grants = db.database
      .prepare(`SELECT * FROM user_grants WHERE tenant_id = 't_1'`)
      .all() as SqliteRow[]
    expect(grants).toHaveLength(1)
    expect(grants[0]!['id']).toBe('ug_old')
    expect(grants[0]!['expires_at']).toBe(newExpiry)
    expect(grants[0]!['granted_via_request_id']).toBe('ar_1')
  })
})

// ---- 审批人解析(设计 5.5,经 approve/list 行为断言) ----

describe('审批人解析', () => {
  async function approverFor(db: SqliteD1, userId: string, requestId = 'ar_1'): Promise<Response> {
    const app = buildApp(makeSession(userId))
    return post(app, envOf(db, vi.fn()), `/auth/access-approvals/${requestId}/approve`, {
      role_id: 'role_admin',
    })
  }

  function seedPending(db: SqliteD1): void {
    seedAccessRequest(db, {
      id: 'ar_1',
      projectId: 'proj_1',
      requesterUserId: 'user_req',
      createdAt: Date.now(),
    })
  }

  it('unit manager 命中:直属 unit 负责人可 approve', async () => {
    const db = makeDb()
    seedBase(db)
    seedUnit(db, { id: 'ou_1', managerUserId: 'user_mgr' })
    seedUnitMember(db, { id: 'oum_1', unitId: 'ou_1', userId: 'user_req' })
    seedMembership(db, { id: 'mem_mgr', userId: 'user_mgr' })
    seedPending(db)
    expect((await approverFor(db, 'user_mgr')).status).toBe(200)
  })

  it('回溯祖先:主岗 unit 无 manager 时取祖先链最近 manager', async () => {
    const db = makeDb()
    seedBase(db)
    seedUnit(db, { id: 'ou_root', managerUserId: 'user_root' })
    seedMembership(db, { id: 'mem_root', userId: 'user_root' })
    seedUnit(db, {
      id: 'ou_child',
      parentUnitId: 'ou_root',
      path: '/ou_root/ou_child',
      depth: 2,
    })
    seedUnitMember(db, { id: 'oum_1', unitId: 'ou_child', userId: 'user_req' })
    seedPending(db)
    // 直属无 manager:中间人 403,祖先 manager 200。
    expect((await approverFor(db, 'user_random')).status).toBe(403)
    expect((await approverFor(db, 'user_root')).status).toBe(200)
  })

  it('命中本人顺延:unit manager 是 requester 自己 -> 顺延 project_manager', async () => {
    const db = makeDb()
    seedBase(db)
    seedUnit(db, { id: 'ou_1', managerUserId: 'user_req' })
    seedUnitMember(db, { id: 'oum_1', unitId: 'ou_1', userId: 'user_req' })
    seedManagerAssignment(db, {
      id: 'mgr_pm',
      userId: 'user_pm',
      managerRole: 'project_manager',
      scopeType: 'project',
      scopeId: 'proj_1',
    })
    seedMembership(db, { id: 'mem_pm', userId: 'user_pm' })
    seedPending(db)
    // requester 不能审自己 -> 403;project_manager -> 200。
    expect((await approverFor(db, 'user_req')).status).toBe(403)
    expect((await approverFor(db, 'user_pm')).status).toBe(200)
  })

  it('project_manager 回落:无 unit 链时 project 负责人审批;多人取最早', async () => {
    const db = makeDb()
    seedBase(db)
    seedManagerAssignment(db, {
      id: 'mgr_pm_new',
      userId: 'user_pm_new',
      managerRole: 'project_manager',
      scopeType: 'project',
      scopeId: 'proj_1',
      createdAt: 2000,
    })
    seedManagerAssignment(db, {
      id: 'mgr_pm_old',
      userId: 'user_pm_old',
      managerRole: 'project_manager',
      scopeType: 'project',
      scopeId: 'proj_1',
      createdAt: 1000,
    })
    seedMembership(db, { id: 'mem_pm_new', userId: 'user_pm_new' })
    seedMembership(db, { id: 'mem_pm_old', userId: 'user_pm_old' })
    seedPending(db)
    // 后 assigned 的不是解析结果 -> 403;最早 assigned -> 200。
    expect((await approverFor(db, 'user_pm_new')).status).toBe(403)
    expect((await approverFor(db, 'user_pm_old')).status).toBe(200)
  })

  it('org_manager 兜底:unit 链与 project_manager 全空', async () => {
    const db = makeDb()
    seedBase(db)
    seedManagerAssignment(db, {
      id: 'mgr_om',
      userId: 'user_om',
      managerRole: 'org_manager',
      scopeType: 'org',
      scopeId: 'org_1',
    })
    seedMembership(db, { id: 'mem_om', userId: 'user_om' })
    seedPending(db)
    expect((await approverFor(db, 'user_random')).status).toBe(403)
    expect((await approverFor(db, 'user_om')).status).toBe(200)
  })

  it('链空 -> 409 no_available_approver', async () => {
    const db = makeDb()
    seedBase(db)
    // 操作者有 membership 但全链无候选 -> 409(无 membership 会先被 403 门拦)。
    seedMembership(db, { id: 'mem_anyone', userId: 'user_anyone' })
    seedPending(db)
    const res = await approverFor(db, 'user_anyone')
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('no_available_approver')
  })
})

// ---- 权限边界(设计 5.6)+ 审批列表 ----

describe('审批权限边界', () => {
  it('GET /auth/access-approvals:仅解析出的 approver 可见候选', async () => {
    const db = makeDb()
    seedBase(db)
    seedUnit(db, { id: 'ou_1', managerUserId: 'user_mgr' })
    seedUnitMember(db, { id: 'oum_1', unitId: 'ou_1', userId: 'user_req' })
    seedMembership(db, { id: 'mem_mgr', userId: 'user_mgr' })
    seedAccessRequest(db, {
      id: 'ar_1',
      projectId: 'proj_1',
      requesterUserId: 'user_req',
      createdAt: Date.now(),
    })
    const env = envOf(db, vi.fn())
    const mgr = buildApp(makeSession('user_mgr'))
    const mgrList = await mgr.request('/auth/access-approvals', { method: 'GET' }, env)
    expect(((await mgrList.json()) as { data: unknown[] }).data).toHaveLength(1)
    const other = buildApp(makeSession('user_other'))
    const otherList = await other.request('/auth/access-approvals', { method: 'GET' }, env)
    expect(((await otherList.json()) as { data: unknown[] }).data).toHaveLength(0)
  })

  it('跨租户 request id -> 404 not_found(不泄露存在性)', async () => {
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
      requesterUserId: 'user_victim',
      createdAt: Date.now(),
    })
    const app = buildApp(makeSession('user_req'))
    const env = envOf(db, vi.fn())
    for (const path of [
      '/auth/access-requests/ar_victim/cancel',
      '/auth/access-approvals/ar_victim/approve',
      '/auth/access-approvals/ar_victim/deny',
    ]) {
      const res = await post(app, env, path, { decision_reason: 'x', role_id: 'role_admin' })
      expect(res.status).toBe(404)
    }
  })

  it('审批人不能审自己:requester 是全链唯一负责人 -> 409 no_available_approver', async () => {
    const db = makeDb()
    seedBase(db)
    seedUnit(db, { id: 'ou_1', managerUserId: 'user_req' })
    seedUnitMember(db, { id: 'oum_1', unitId: 'ou_1', userId: 'user_req' })
    seedManagerAssignment(db, {
      id: 'mgr_pm',
      userId: 'user_req',
      managerRole: 'project_manager',
      scopeType: 'project',
      scopeId: 'proj_1',
    })
    seedManagerAssignment(db, {
      id: 'mgr_om',
      userId: 'user_req',
      managerRole: 'org_manager',
      scopeType: 'org',
      scopeId: 'org_1',
    })
    seedAccessRequest(db, {
      id: 'ar_1',
      projectId: 'proj_1',
      requesterUserId: 'user_req',
      createdAt: Date.now(),
    })
    const app = buildApp(makeSession('user_req'))
    const res = await post(app, envOf(db, vi.fn()), '/auth/access-approvals/ar_1/approve', {
      role_id: 'role_admin',
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('no_available_approver')
  })

  it('approver 无 active membership -> 403 forbidden(被移出 org 的经理即刻失去审批权)', async () => {
    const db = makeDb()
    seedBase(db)
    seedUnit(db, { id: 'ou_1', managerUserId: 'user_mgr' })
    seedUnitMember(db, { id: 'oum_1', unitId: 'ou_1', userId: 'user_req' })
    // user_mgr 仍在 unit 链上但无 membership:权限门先于解析,直接 403。
    seedAccessRequest(db, {
      id: 'ar_1',
      projectId: 'proj_1',
      requesterUserId: 'user_req',
      createdAt: Date.now(),
    })
    const approver = buildApp(makeSession('user_mgr'))
    const res = await post(approver, envOf(db, vi.fn()), '/auth/access-approvals/ar_1/approve', {
      role_id: 'role_admin',
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('forbidden')
  })

  it('候选人 membership 失效顺延:unit manager 已 left -> project_manager 接棒审批', async () => {
    const db = makeDb()
    seedBase(db)
    seedUnit(db, { id: 'ou_1', managerUserId: 'user_mgr' })
    seedUnitMember(db, { id: 'oum_1', unitId: 'ou_1', userId: 'user_req' })
    seedMembership(db, { id: 'mem_mgr', userId: 'user_mgr', status: 'left' })
    seedManagerAssignment(db, {
      id: 'mgr_pm',
      userId: 'user_pm',
      managerRole: 'project_manager',
      scopeType: 'project',
      scopeId: 'proj_1',
    })
    seedMembership(db, { id: 'mem_pm', userId: 'user_pm' })
    seedAccessRequest(db, {
      id: 'ar_1',
      projectId: 'proj_1',
      requesterUserId: 'user_req',
      createdAt: Date.now(),
    })
    const env = envOf(db, vi.fn())
    // unit manager 本人无 active membership -> 403;解析顺延到 project_manager -> 200。
    const mgr = buildApp(makeSession('user_mgr'))
    const mgrRes = await post(mgr, env, '/auth/access-approvals/ar_1/approve', {
      role_id: 'role_admin',
    })
    expect(mgrRes.status).toBe(403)
    const pm = buildApp(makeSession('user_pm'))
    const pmRes = await post(pm, env, '/auth/access-approvals/ar_1/approve', {
      role_id: 'role_admin',
    })
    expect(pmRes.status).toBe(200)
  })

  it('收件箱解析缓存:同 requester 跨 project 多 pending 时 unit 链只查一次、org_manager 只查一次', async () => {
    const db = makeDb()
    seedBase(db)
    seedProject(db, { id: 'proj_2' })
    seedManagerAssignment(db, {
      id: 'mgr_om',
      userId: 'user_om',
      managerRole: 'org_manager',
      scopeType: 'org',
      scopeId: 'org_1',
    })
    seedMembership(db, { id: 'mem_om', userId: 'user_om' })
    seedAccessRequest(db, {
      id: 'ar_p1',
      projectId: 'proj_1',
      requesterUserId: 'user_req',
      createdAt: Date.now(),
    })
    seedAccessRequest(db, {
      id: 'ar_p2',
      projectId: 'proj_2',
      requesterUserId: 'user_req',
      createdAt: Date.now() + 1,
    })
    const env = envOf(db, vi.fn())
    const om = buildApp(makeSession('user_om'))
    db.queryLog.length = 0
    const res = await om.request('/auth/access-approvals', { method: 'GET' }, env)
    expect(((await res.json()) as { data: unknown[] }).data).toHaveLength(2)
    // user_req 无 unit 链:findOne 一次后缓存复用;无缓存时两个候选各查一次。
    expect(db.queryLog.filter((sql) => sql.includes('org_unit_members'))).toHaveLength(1)
    // project_manager 按 project 各一次(不同 project 不复用)+ org_manager 全 org 一次;
    // 无缓存时 org_manager 查询会随候选数重复。
    expect(db.queryLog.filter((sql) => sql.includes('manager_assignments'))).toHaveLength(3)
  })
})

// ---- 审计 failure semantics(waitUntil / catch+log,不变 500) ----

describe('审计投递', () => {
  function seedPendingForAudit(db: SqliteD1): void {
    seedBase(db)
    seedUnit(db, { id: 'ou_1', managerUserId: 'user_mgr' })
    seedUnitMember(db, { id: 'oum_1', unitId: 'ou_1', userId: 'user_req' })
    seedMembership(db, { id: 'mem_mgr', userId: 'user_mgr' })
    seedAccessRequest(db, {
      id: 'ar_1',
      projectId: 'proj_1',
      roleId: 'role_admin',
      requesterUserId: 'user_req',
      createdAt: Date.now(),
    })
  }

  it('生产路径:send 返回的 Promise 挂到 executionCtx.waitUntil', async () => {
    const db = makeDb()
    seedPendingForAudit(db)
    const auditSend = vi.fn()
    const env = envOf(db, auditSend)
    const waitUntil = vi.fn()
    const execCtx = {
      waitUntil,
      passThroughOnException: () => {},
    } as unknown as ExecutionContext
    const approver = buildApp(makeSession('user_mgr'))
    const res = await approver.request(
      '/auth/access-approvals/ar_1/approve',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      env,
      execCtx,
    )
    expect(res.status).toBe(200)
    expect(waitUntil).toHaveBeenCalledTimes(1)
    ;(await waitUntil.mock.calls[0]?.[0]) as Promise<void>
    expect(auditSend).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'access_request.approved', actorId: 'user_mgr' }),
    )
  })

  it('queue send reject:approve 仍 200,catch 后 log 不上抛', async () => {
    const db = makeDb()
    seedPendingForAudit(db)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const env = envWithAuditSend(db, () => Promise.reject(new Error('queue unavailable')))
      const approver = buildApp(makeSession('user_mgr'))
      const res = await post(approver, env, '/auth/access-approvals/ar_1/approve', {})
      expect(res.status).toBe(200)
      // 无 executionCtx 时走 catch+log 降级,microtask 排定在响应之后,等一拍再断言。
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'me_auth.audit_queue.send_failed' }),
      )
    } finally {
      errorSpy.mockRestore()
    }
  })
})
