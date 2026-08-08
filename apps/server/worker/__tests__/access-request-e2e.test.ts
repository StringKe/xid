// Project 访问申请审批 P1-B5 端到端测试
// (设计 docs/design/org-structure-access/design-access-request.md 第 5 节 3/4/8 项):
//   - 5.3 主线闭环:approval_required project 无 grant 用户 /authorize 被拒
//     (error_description 带 access_request_required 前缀)-> POST /auth/access-requests 申请 ->
//     负责人 approve -> /authorize 放行签 code -> /token 签发成功且 claims 正确。
//   - 5.4 JIT:approve 带 grant_expires_at -> 过期前 authorize 放行;expires_at 改到过去 ->
//     authorize 重新拒绝;code 交换与 refresh 轮换两条 token 签发路径对过期 grant 复查拒绝
//     (token-issue resolveTokenGrantContext 复查)。
//   - 5.8 ProjectGrant 交叉:restricted 只收紧同 org。跨 org 用户持有效 project_grants +
//     user_grants(granted_via_grant_id) 仍放行;同 org 无 grant 拒绝。
//   - restricted 无申请入口:POST /auth/access-requests -> 404 project_not_found。
// D1 用 node:sqlite 内存库 + 全量 migration 链(与 access-requests.test.ts 同一 SqliteD1),
// authorize/token 挂真实路由 + 真实 ES256 签发(buildTestTenant);grant 过期用 UPDATE 改写
// expires_at 模拟(生产代码无时间注入点,过期判定读列值,等价)。
// 补盲:同 org granted_via_grant_id IS NULL 谓词(真实 SQLite 验证)、token-issue restricted
// 复查分支、org-less session 对非 open project 的纵深防御拒绝、过期 JIT grant 不进 claims。

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import type { TenantContext } from '@xid-kit/types'
import { computeS256Challenge, generateCodeVerifier } from '@xid-kit/protocol'
import { importJwkForVerify, sha256Hex, verifyJwt } from '@xid-kit/crypto'
import type { SessionData, XidHonoEnv } from '../lib/types'
import { isAppError } from '../lib/errors'
import { handleAccessApprovalApprove, handleAccessRequestCreate } from '../me-auth/access-requests'
import { registerAuthorizeRoutes } from '../oidc/authorize'
import { registerTokenRoutes } from '../oidc/token'
import { buildTestTenant, makeFakeKv, makeStatefulFakeDoNs } from '../oidc/__tests__/helpers'

const migrationDir = fileURLToPath(new URL('../../../../packages/db/drizzle/', import.meta.url))

function applyMigrations(db: DatabaseSync): void {
  for (const file of readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(migrationDir, file), 'utf8'))
  }
}

// ---- SqliteD1:node:sqlite 内存库包装成 D1Database(与 access-requests.test.ts 同源) ----

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
    const lower = this.sql.trimStart().toLowerCase()
    const isWrite =
      lower.startsWith('insert') || lower.startsWith('update') || lower.startsWith('delete')
    // 与真实 D1 对齐:写语句经 .all() 执行时 meta.changes 反映受影响行数
    // (persistRotatedRefresh 等 INSERT...SELECT 栅栏靠 changes===1 判定写入成败)。
    if (isWrite && !lower.includes('returning')) {
      const result = statement.run(...(this.bindings as never[]))
      return {
        success: true,
        results: [],
        meta: { changes: Number(result.changes) },
      } as unknown as D1Result<T>
    }
    const rows = statement.all(...(this.bindings as never[])) as T[]
    return {
      success: true,
      results: rows,
      meta: { changes: isWrite ? rows.length : 0 },
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

const CLIENT_ID = 'cli_app'
const CLIENT_SECRET = 'sk_secret_value'
const REDIRECT_URI = 'https://rp.example/cb'
const REQUESTER = 'user_req'
const APPROVER = 'user_om'

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

function seedUser(db: SqliteD1, userId: string): void {
  db.database
    .prepare(
      `INSERT INTO users (id, tenant_id, status, created_at, updated_at)
       VALUES (?, 't_1', 'active', 1000, 1000)`,
    )
    .run(userId)
}

function seedMembership(db: SqliteD1, input: { id: string; userId: string; orgId?: string }): void {
  db.database
    .prepare(
      `INSERT INTO memberships (id, tenant_id, org_id, user_id, status, created_at, updated_at)
       VALUES (?, 't_1', ?, ?, 'active', 1000, 1000)`,
    )
    .run(input.id, input.orgId ?? 'org_1', input.userId)
}

function seedProject(
  db: SqliteD1,
  input: { id: string; orgId?: string; accessPolicy?: string },
): void {
  db.database
    .prepare(
      `INSERT INTO projects (id, tenant_id, org_id, name, status, access_policy, created_at, updated_at)
       VALUES (?, 't_1', ?, ?, 'active', ?, 1000, 1000)`,
    )
    .run(input.id, input.orgId ?? 'org_1', input.id, input.accessPolicy ?? 'approval_required')
}

function seedRole(db: SqliteD1, input: { id: string; projectId: string }): void {
  db.database
    .prepare(
      `INSERT INTO roles (id, tenant_id, project_id, key, display_name, status, created_at, updated_at)
       VALUES (?, 't_1', ?, ?, ?, 'active', 1000, 1000)`,
    )
    .run(input.id, input.projectId, input.id, input.id)
}

function seedManagerAssignment(
  db: SqliteD1,
  input: { id: string; userId: string; managerRole: string; scopeType: string; scopeId: string },
): void {
  db.database
    .prepare(
      `INSERT INTO manager_assignments (
         id, tenant_id, user_id, manager_role, scope_type, scope_id, created_at, updated_at
       ) VALUES (?, 't_1', ?, ?, ?, ?, 1000, 1000)`,
    )
    .run(input.id, input.userId, input.managerRole, input.scopeType, input.scopeId)
}

function seedUserGrant(
  db: SqliteD1,
  input: {
    id: string
    userId: string
    projectId: string
    roleId: string
    grantedViaGrantId?: string
  },
): void {
  db.database
    .prepare(
      `INSERT INTO user_grants (
         id, tenant_id, user_id, project_id, role_id,
         granted_via_grant_id, granted_via_request_id, expires_at, revoked_at,
         created_at, updated_at
       ) VALUES (?, 't_1', ?, ?, ?, ?, NULL, NULL, NULL, 1000, 1000)`,
    )
    .run(input.id, input.userId, input.projectId, input.roleId, input.grantedViaGrantId ?? null)
}

function seedProjectGrant(
  db: SqliteD1,
  input: { id: string; projectId: string; grantedByOrgId: string; grantedToOrgId: string },
): void {
  db.database
    .prepare(
      `INSERT INTO project_grants (
         id, tenant_id, granted_project_id, granted_by_org_id, granted_to_org_id,
         status, created_at, updated_at
       ) VALUES (?, 't_1', ?, ?, ?, 'active', 1000, 1000)`,
    )
    .run(input.id, input.projectId, input.grantedByOrgId, input.grantedToOrgId)
}

function seedPermission(db: SqliteD1, input: { id: string; projectId: string; key: string }): void {
  db.database
    .prepare(
      `INSERT INTO permissions (
         id, tenant_id, project_id, key, description, status, deleted_at, created_at, updated_at
       ) VALUES (?, 't_1', ?, ?, NULL, 'active', NULL, 1000, 1000)`,
    )
    .run(input.id, input.projectId, input.key)
}

function seedRolePermission(
  db: SqliteD1,
  input: { id: string; roleId: string; permissionId: string },
): void {
  db.database
    .prepare(
      `INSERT INTO role_permissions (
         id, tenant_id, role_id, permission_id, condition_expression, created_at
       ) VALUES (?, 't_1', ?, ?, NULL, 1000)`,
    )
    .run(input.id, input.roleId, input.permissionId)
}

// first-party confidential client(client_secret_post + 强制 PKCE),绑定 project。
function seedApplication(
  db: SqliteD1,
  input: { clientSecretHash: string; projectId: string },
): void {
  db.database
    .prepare(
      `INSERT INTO applications (
         id, tenant_id, project_id, client_id, client_secret_hash, client_type,
         token_endpoint_auth_method, redirect_uris, post_logout_redirect_uris,
         allowed_grant_types, allowed_response_types, allowed_scopes,
         require_pkce, first_party, status, created_at, updated_at
       ) VALUES (
         'app_1', 't_1', ?, ?, ?, 'confidential', 'client_secret_post',
         ?, '[]', '["authorization_code","refresh_token"]', '["code"]',
         '["openid","profile","offline_access"]', 1, 1, 'active', 1000, 1000
       )`,
    )
    .run(input.projectId, CLIENT_ID, input.clientSecretHash, JSON.stringify([REDIRECT_URI]))
}

// 标准夹具:tenant 顶层 org + org_1 + 申请人用户/membership + approval_required project + role +
// project-linked first-party client + org_manager 审批人(无 unit 链 / project_manager,走兜底)。
// 审批人需持 active membership(审批权限门 requireApprover 的硬性前置)。
async function seedBase(db: SqliteD1, accessPolicy = 'approval_required'): Promise<void> {
  seedOrganization(db, 't_1', 't_1')
  seedOrganization(db, 'org_1', 't_1')
  seedUser(db, REQUESTER)
  seedUser(db, APPROVER)
  seedMembership(db, { id: 'mem_req', userId: REQUESTER })
  seedMembership(db, { id: 'mem_om', userId: APPROVER })
  seedProject(db, { id: 'proj_1', accessPolicy })
  seedRole(db, { id: 'role_admin', projectId: 'proj_1' })
  seedManagerAssignment(db, {
    id: 'mgr_om',
    userId: APPROVER,
    managerRole: 'org_manager',
    scopeType: 'org',
    scopeId: 'org_1',
  })
  seedApplication(db, { clientSecretHash: await sha256Hex(CLIENT_SECRET), projectId: 'proj_1' })
}

// ---- app / env harness ----

function makeSession(userId: string, activeOrgId: string | null = 'org_1'): SessionData {
  return {
    sessionId: `s_${userId}`,
    userId,
    status: 'active',
    activeOrgId,
    authenticatedAt: new Date(Date.now() - 1000),
    expiresAt: new Date(Date.now() + 3600_000),
    rememberMe: false,
    isImpersonation: false,
    impersonatorUserId: null,
    acr: null,
    amr: null,
    aal: null,
  }
}

// 同一 app 挂 /authorize + /token + me-auth 申请/审批路由,session 由调用方按角色构造。
function buildApp(ctx: TenantContext, session: SessionData | null): Hono<XidHonoEnv> {
  const app = new Hono<XidHonoEnv>()
  // 最小 onError:直接读 AppError.code/httpStatus,不引 i18n 中间件。
  app.onError((err, c) => {
    if (isAppError(err)) return c.json({ code: err.code }, err.httpStatus as 400)
    return c.json({ code: 'server_error' }, 500)
  })
  app.use('*', async (c, next) => {
    c.set('tenant', ctx)
    c.set('session', session)
    await next()
  })
  registerAuthorizeRoutes(app)
  registerTokenRoutes(app)
  // 与 me-auth/index.ts 注册路径一致。
  app.post('/auth/access-requests', handleAccessRequestCreate)
  app.post('/auth/access-approvals/:id/approve', handleAccessApprovalApprove)
  return app
}

function envOf(db: SqliteD1, auditSend: ReturnType<typeof vi.fn>, kekB64: string): Env {
  return asUnknown<Env>({
    ENVIRONMENT: 'development',
    DB: db as unknown as D1Database,
    CACHE: makeFakeKv(),
    KEK: kekB64,
    PEPPER: 'ZWUyZS1wZXBwZXItbm90LXVzZWQtaGVyZQ',
    AUDIT_QUEUE: { send: auditSend },
    OAUTH_STATE: makeStatefulFakeDoNs().ns,
  })
}

type World = {
  ctx: TenantContext
  db: SqliteD1
  env: Env
  auditSend: ReturnType<typeof vi.fn>
  verifier: string
  challenge: string
}

async function makeWorld(): Promise<World> {
  const { ctx, kekB64 } = await buildTestTenant()
  const db = makeDb()
  const auditSend = vi.fn()
  const verifier = generateCodeVerifier()
  const challenge = await computeS256Challenge(verifier)
  return { ctx, db, env: envOf(db, auditSend, kekB64), auditSend, verifier, challenge }
}

// ---- 请求 helper ----

function authorize(
  ctx: TenantContext,
  env: Env,
  session: SessionData,
  challenge: string,
): Promise<Response> {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'openid profile offline_access',
    state: 'st_abc',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  return buildApp(ctx, session).request(`${ctx.issuer}/authorize?${params.toString()}`, {}, env)
}

function postJson(args: {
  ctx: TenantContext
  env: Env
  session: SessionData
  path: string
  body: unknown
}): Promise<Response> {
  const { ctx, env, session, path, body } = args
  return buildApp(ctx, session).request(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  )
}

function postTokenForm(
  ctx: TenantContext,
  env: Env,
  form: Record<string, string>,
): Promise<Response> {
  // /token 不需要 session;session=null 的 app 即可。
  return buildApp(ctx, null).request(
    `${ctx.issuer}/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    },
    env,
  )
}

function exchangeCode(
  ctx: TenantContext,
  env: Env,
  code: string,
  verifier: string,
): Promise<Response> {
  return postTokenForm(ctx, env, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  })
}

// ---- 断言 helper ----

function redirectLocation(res: Response): URL {
  expect(res.status).toBe(302)
  return new URL(res.headers.get('location') ?? '')
}

function expectRpDenied(location: URL, descriptionPrefix: string): void {
  expect(location.origin + location.pathname).toBe(REDIRECT_URI)
  expect(location.searchParams.get('error')).toBe('access_denied')
  expect(location.searchParams.get('error_description')).toContain(descriptionPrefix)
  expect(location.searchParams.get('state')).toBe('st_abc')
  expect(location.searchParams.get('code')).toBeNull()
}

function expectRpCode(location: URL): string {
  expect(location.origin + location.pathname).toBe(REDIRECT_URI)
  expect(location.searchParams.get('error')).toBeNull()
  const code = location.searchParams.get('code') ?? ''
  expect(code).toMatch(/^ac_/)
  expect(location.searchParams.get('state')).toBe('st_abc')
  return code
}

// 用 active 公钥验签并解出 payload(token.test.ts 同款)。
async function verifyPayload(ctx: TenantContext, token: string): Promise<Record<string, unknown>> {
  const jwk = ctx.signingKeys.keys[0]!
  const publicKey = await importJwkForVerify({
    ...jwk.publicKeyJwk,
    kid: jwk.kid,
    use: 'sig',
    alg: jwk.alg,
  })
  const verified = await verifyJwt(token, {
    keys: [{ kid: jwk.kid, alg: jwk.alg, publicKey }],
  })
  expect(verified.ok).toBe(true)
  if (!verified.ok) return {}
  return verified.value.payload as Record<string, unknown>
}

async function applyAndApprove(
  world: World,
  approveBody: Record<string, unknown> = {},
): Promise<string> {
  const created = await postJson({
    ctx: world.ctx,
    env: world.env,
    session: makeSession(REQUESTER),
    path: '/auth/access-requests',
    body: {
      project_id: 'proj_1',
      role_id: 'role_admin',
    },
  })
  expect(created.status).toBe(201)
  const requestId = ((await created.json()) as { request: { id: string } }).request.id
  const approved = await postJson({
    ctx: world.ctx,
    env: world.env,
    session: makeSession(APPROVER),
    path: `/auth/access-approvals/${requestId}/approve`,
    body: approveBody,
  })
  expect(approved.status).toBe(200)
  return requestId
}

function expireRequesterGrant(db: SqliteD1, expiresAt: number | null): void {
  db.database
    .prepare(
      `UPDATE user_grants SET expires_at = ?
        WHERE tenant_id = 't_1' AND user_id = ? AND project_id = 'proj_1'`,
    )
    .run(expiresAt, REQUESTER)
}

// ---- 5.3 主线闭环 ----

describe('e2e 主线闭环(设计 5.3)', () => {
  it('无 grant 被拒 -> 申请 -> org_manager approve -> authorize 签 code -> token 签发 claims 正确', async () => {
    const world = await makeWorld()
    await seedBase(world.db)
    const requesterSession = makeSession(REQUESTER)

    // 1) 无 grant:/authorize 被 access_policy 拦截,机器可读码在 error_description 前缀。
    const denied = await authorize(world.ctx, world.env, requesterSession, world.challenge)
    expectRpDenied(redirectLocation(denied), 'access_request_required')
    expect(
      world.db.database.prepare(`SELECT count(*) AS n FROM authorization_codes`).get(),
    ).toEqual({ n: 0 })

    // 2) 申请 + org_manager(兜底审批人)approve,user_grants 落库。
    const requestId = await applyAndApprove(world)
    const grant = world.db.database
      .prepare(
        `SELECT * FROM user_grants WHERE tenant_id = 't_1' AND user_id = ? AND project_id = 'proj_1'`,
      )
      .get(REQUESTER) as SqliteRow
    expect(grant['role_id']).toBe('role_admin')
    expect(grant['granted_via_request_id']).toBe(requestId)
    expect(grant['granted_via_grant_id']).toBeNull()
    expect(grant['expires_at']).toBeNull()

    // 3) 再次 /authorize:放行,302 回 redirect_uri 带 code/state。
    const allowed = await authorize(world.ctx, world.env, requesterSession, world.challenge)
    const code = expectRpCode(redirectLocation(allowed))
    const codeRow = world.db.database
      .prepare(`SELECT * FROM authorization_codes WHERE code = ?`)
      .get(code) as SqliteRow
    expect(codeRow['active_org_id']).toBe('org_1')
    expect(codeRow['project_grant_id']).toBeNull()

    // 4) code 交换:签发 access_token + id_token + refresh_token,claims 正确。
    const tokenRes = await exchangeCode(world.ctx, world.env, code, world.verifier)
    expect(tokenRes.status).toBe(200)
    expect(tokenRes.headers.get('cache-control')).toBe('no-store')
    const body = (await tokenRes.json()) as Record<string, string>
    expect(body['token_type']).toBe('Bearer')
    expect(body['refresh_token']).toBeDefined()

    const accessPayload = await verifyPayload(world.ctx, body['access_token']!)
    expect(accessPayload['iss']).toBe(world.ctx.issuer)
    expect(accessPayload['sub']).toBe(REQUESTER)
    expect(accessPayload['aud']).toBe(CLIENT_ID)
    expect(accessPayload['client_id']).toBe(CLIENT_ID)
    expect(accessPayload['tenant_id']).toBe(world.ctx.tenantId)
    expect(accessPayload['org_id']).toBe('org_1')
    expect(accessPayload['org_slug']).toBe('org_1')

    const idPayload = await verifyPayload(world.ctx, body['id_token']!)
    expect(idPayload['iss']).toBe(world.ctx.issuer)
    expect(idPayload['sub']).toBe(REQUESTER)
    expect(idPayload['sid']).toBe(`s_${REQUESTER}`)

    // 5) 一次性消费 + refresh family 落库。
    const consumed = world.db.database
      .prepare(`SELECT consumed_at FROM authorization_codes WHERE code = ?`)
      .get(code) as SqliteRow
    expect(consumed['consumed_at']).not.toBeNull()
    const refreshRow = world.db.database
      .prepare(`SELECT active_org_id, project_grant_id FROM refresh_tokens WHERE tenant_id = 't_1'`)
      .get() as SqliteRow
    expect(refreshRow['active_org_id']).toBe('org_1')
    expect(refreshRow['project_grant_id']).toBeNull()
  })
})

// ---- 5.4 JIT 过期 ----

describe('e2e JIT(设计 5.4)', () => {
  it('approve 带 grant_expires_at:过期前 authorize 放行,过期后重新拒绝', async () => {
    const world = await makeWorld()
    await seedBase(world.db)
    const requesterSession = makeSession(REQUESTER)
    const expiresAt = Date.now() + 3600_000
    await applyAndApprove(world, { grant_expires_at: expiresAt })
    const grant = world.db.database
      .prepare(`SELECT expires_at FROM user_grants WHERE tenant_id = 't_1' AND user_id = ?`)
      .get(REQUESTER) as SqliteRow
    expect(grant['expires_at']).toBe(expiresAt)

    // 过期前:放行签 code。
    const before = await authorize(world.ctx, world.env, requesterSession, world.challenge)
    expectRpCode(redirectLocation(before))

    // 把 expires_at 改到过去:authorize 重新按 access_request_required 拒绝。
    expireRequesterGrant(world.db, Date.now() - 1000)
    const after = await authorize(world.ctx, world.env, requesterSession, world.challenge)
    expectRpDenied(redirectLocation(after), 'access_request_required')
  })

  it('token 签发复查:过期 grant 在 code 交换与 refresh 轮换两条路径均被拒', async () => {
    const world = await makeWorld()
    await seedBase(world.db)
    const requesterSession = makeSession(REQUESTER)
    await applyAndApprove(world)

    // code 交换路径:code 签发时 grant 有效,交换前过期 -> token-issue 复查拒绝。
    const first = await authorize(world.ctx, world.env, requesterSession, world.challenge)
    const staleCode = expectRpCode(redirectLocation(first))
    expireRequesterGrant(world.db, Date.now() - 1000)
    const exchangeDenied = await exchangeCode(world.ctx, world.env, staleCode, world.verifier)
    expect(exchangeDenied.status).toBe(403)
    const deniedBody = (await exchangeDenied.json()) as Record<string, string>
    expect(deniedBody['error']).toBe('access_denied')
    expect(deniedBody['error_description']).toContain('access_request_required')

    // 恢复有效,走完签发拿到 refresh_token。
    expireRequesterGrant(world.db, null)
    const second = await authorize(world.ctx, world.env, requesterSession, world.challenge)
    const liveCode = expectRpCode(redirectLocation(second))
    const issued = await exchangeCode(world.ctx, world.env, liveCode, world.verifier)
    expect(issued.status).toBe(200)
    const refreshToken = ((await issued.json()) as Record<string, string>)['refresh_token']!
    expect(refreshToken).toBeDefined()

    // refresh 轮换路径:grant 再次过期 -> resolveTokenGrantContext 复查拒绝。
    expireRequesterGrant(world.db, Date.now() - 1000)
    const refreshDenied = await postTokenForm(world.ctx, world.env, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })
    const refreshBody = (await refreshDenied.json()) as Record<string, string>
    expect(refreshDenied.status).toBe(403)
    expect(refreshBody['error']).toBe('access_denied')
    expect(refreshBody['error_description']).toContain('access_request_required')
  })
})

// ---- 5.8 ProjectGrant 交叉 ----

describe('e2e ProjectGrant 交叉(设计 5.8)', () => {
  it('restricted project:跨 org 用户持有效 project_grants + user_grants 放行;同 org 无 grant 拒绝', async () => {
    const world = await makeWorld()
    seedOrganization(world.db, 't_1', 't_1')
    // org_a 拥有 restricted project;org_b 经 project_grants 获得跨 org 授权。
    seedOrganization(world.db, 'org_a', 't_1')
    seedOrganization(world.db, 'org_b', 't_1')
    seedUser(world.db, 'u_cross')
    seedUser(world.db, 'u_same')
    seedMembership(world.db, { id: 'mem_cross', userId: 'u_cross', orgId: 'org_b' })
    seedMembership(world.db, { id: 'mem_same', userId: 'u_same', orgId: 'org_a' })
    seedProject(world.db, { id: 'proj_a', orgId: 'org_a', accessPolicy: 'restricted' })
    seedRole(world.db, { id: 'role_x', projectId: 'proj_a' })
    seedProjectGrant(world.db, {
      id: 'pg_1',
      projectId: 'proj_a',
      grantedByOrgId: 'org_a',
      grantedToOrgId: 'org_b',
    })
    seedUserGrant(world.db, {
      id: 'ug_cross',
      userId: 'u_cross',
      projectId: 'proj_a',
      roleId: 'role_x',
      grantedViaGrantId: 'pg_1',
    })
    seedApplication(world.db, {
      clientSecretHash: await sha256Hex(CLIENT_SECRET),
      projectId: 'proj_a',
    })

    // 跨 org 路径(access_policy 不介入):放行且 code 持久化 active_org_id + project_grant_id。
    const cross = await authorize(
      world.ctx,
      world.env,
      makeSession('u_cross', 'org_b'),
      world.challenge,
    )
    const code = expectRpCode(redirectLocation(cross))
    const codeRow = world.db.database
      .prepare(`SELECT active_org_id, project_grant_id FROM authorization_codes WHERE code = ?`)
      .get(code) as SqliteRow
    expect(codeRow['active_org_id']).toBe('org_b')
    expect(codeRow['project_grant_id']).toBe('pg_1')

    // token 签发带 Grant 上下文 claims(org_id=org_b,project_id/granted_org_id 指向 proj_a/org_a)。
    const tokenRes = await exchangeCode(world.ctx, world.env, code, world.verifier)
    expect(tokenRes.status).toBe(200)
    const accessPayload = await verifyPayload(
      world.ctx,
      ((await tokenRes.json()) as Record<string, string>)['access_token']!,
    )
    expect(accessPayload['sub']).toBe('u_cross')
    expect(accessPayload['org_id']).toBe('org_b')
    expect(accessPayload['project_id']).toBe('proj_a')
    expect(accessPayload['granted_org_id']).toBe('org_a')

    // 同 org 无 grant:restricted 收紧,access_denied + project_access_restricted。
    const same = await authorize(
      world.ctx,
      world.env,
      makeSession('u_same', 'org_a'),
      world.challenge,
    )
    expectRpDenied(redirectLocation(same), 'project_access_restricted')
  })
})

// ---- restricted 无申请入口 ----

describe('e2e restricted 无申请入口', () => {
  it('POST /auth/access-requests 对 policy=restricted 的 project -> 404 project_not_found', async () => {
    const world = await makeWorld()
    await seedBase(world.db, 'restricted')
    const res = await postJson({
      ctx: world.ctx,
      env: world.env,
      session: makeSession(REQUESTER),
      path: '/auth/access-requests',
      body: {
        project_id: 'proj_1',
        role_id: 'role_admin',
      },
    })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { code: string }).code).toBe('project_not_found')
  })
})

// ---- 同 org user_grants granted_via_grant_id IS NULL 谓词(真实 SQLite 验证) ----
// 同 org 用户仅持有跨 org 来源行(granted_via_grant_id 非空)时,该行不得当作同 org grant
// 放行 restricted/approval_required project。

describe('e2e 同 org granted_via_grant_id IS NULL 谓词', () => {
  async function seedCrossOrgOnlyGrant(world: World, accessPolicy: string): Promise<void> {
    seedOrganization(world.db, 't_1', 't_1')
    seedOrganization(world.db, 'org_a', 't_1')
    seedOrganization(world.db, 'org_b', 't_1')
    seedUser(world.db, 'u_same')
    seedMembership(world.db, { id: 'mem_same', userId: 'u_same', orgId: 'org_a' })
    seedProject(world.db, { id: 'proj_a', orgId: 'org_a', accessPolicy })
    seedRole(world.db, { id: 'role_x', projectId: 'proj_a' })
    seedProjectGrant(world.db, {
      id: 'pg_1',
      projectId: 'proj_a',
      grantedByOrgId: 'org_a',
      grantedToOrgId: 'org_b',
    })
    // 唯一 user_grant 行挂在 project_grants 下来源(跨 org),同 org 判定必须排除它。
    seedUserGrant(world.db, {
      id: 'ug_via',
      userId: 'u_same',
      projectId: 'proj_a',
      roleId: 'role_x',
      grantedViaGrantId: 'pg_1',
    })
    seedApplication(world.db, {
      clientSecretHash: await sha256Hex(CLIENT_SECRET),
      projectId: 'proj_a',
    })
  }

  it('restricted:仅持 granted_via_grant_id 行的同 org 用户 -> access_denied project_access_restricted', async () => {
    const world = await makeWorld()
    await seedCrossOrgOnlyGrant(world, 'restricted')
    const res = await authorize(
      world.ctx,
      world.env,
      makeSession('u_same', 'org_a'),
      world.challenge,
    )
    expectRpDenied(redirectLocation(res), 'project_access_restricted')
  })

  it('approval_required:仅持 granted_via_grant_id 行的同 org 用户 -> access_denied access_request_required', async () => {
    const world = await makeWorld()
    await seedCrossOrgOnlyGrant(world, 'approval_required')
    const res = await authorize(
      world.ctx,
      world.env,
      makeSession('u_same', 'org_a'),
      world.challenge,
    )
    expectRpDenied(redirectLocation(res), 'access_request_required')
  })
})

// ---- token-issue 同 org 复查:restricted 分支 ----

describe('e2e token 签发复查 restricted 分支', () => {
  it('restricted:code 签发时 grant 有效,交换前过期 -> 403 project_access_restricted', async () => {
    const world = await makeWorld()
    await seedBase(world.db, 'restricted')
    // restricted 无申请入口,直接落有效 user_grant(模拟管理员授予)。
    seedUserGrant(world.db, {
      id: 'ug_req',
      userId: REQUESTER,
      projectId: 'proj_1',
      roleId: 'role_admin',
    })
    const requesterSession = makeSession(REQUESTER)

    const first = await authorize(world.ctx, world.env, requesterSession, world.challenge)
    const staleCode = expectRpCode(redirectLocation(first))
    expireRequesterGrant(world.db, Date.now() - 1000)
    const exchangeDenied = await exchangeCode(world.ctx, world.env, staleCode, world.verifier)
    expect(exchangeDenied.status).toBe(403)
    const deniedBody = (await exchangeDenied.json()) as Record<string, string>
    expect(deniedBody['error']).toBe('access_denied')
    expect(deniedBody['error_description']).toContain('project_access_restricted')
  })
})

// ---- org-less session 纵深防御 ----

describe('e2e org-less session + project access_policy', () => {
  it('清 active org 后对 approval_required client authorize -> access_denied access_request_required', async () => {
    const world = await makeWorld()
    await seedBase(world.db)
    const res = await authorize(world.ctx, world.env, makeSession(REQUESTER, null), world.challenge)
    expectRpDenied(redirectLocation(res), 'access_request_required')
    expect(
      world.db.database.prepare(`SELECT count(*) AS n FROM authorization_codes`).get(),
    ).toEqual({ n: 0 })
  })

  it('org-less + restricted -> access_denied project_access_restricted', async () => {
    const world = await makeWorld()
    await seedBase(world.db, 'restricted')
    const res = await authorize(world.ctx, world.env, makeSession(REQUESTER, null), world.challenge)
    expectRpDenied(redirectLocation(res), 'project_access_restricted')
  })

  it('org-less + open -> 放行且 token 签发成功(B2C 回归)', async () => {
    const world = await makeWorld()
    await seedBase(world.db, 'open')
    const res = await authorize(world.ctx, world.env, makeSession(REQUESTER, null), world.challenge)
    const code = expectRpCode(redirectLocation(res))
    const tokenRes = await exchangeCode(world.ctx, world.env, code, world.verifier)
    expect(tokenRes.status).toBe(200)
  })
})

// ---- 过期 JIT grant 不进 claims(claims 层 expires_at 过滤) ----
// open project 无 authorize/token 复查门,claims 解析必须自行排除过期 grant 的 role。

describe('e2e 过期 grant 不进 access token claims', () => {
  async function seedOpenWithPermission(world: World): Promise<void> {
    await seedBase(world.db, 'open')
    seedPermission(world.db, { id: 'perm_read', projectId: 'proj_1', key: 'users.read' })
    seedRolePermission(world.db, { id: 'rp_1', roleId: 'role_admin', permissionId: 'perm_read' })
    seedUserGrant(world.db, {
      id: 'ug_req',
      userId: REQUESTER,
      projectId: 'proj_1',
      roleId: 'role_admin',
    })
  }

  it('有效 grant:permissions claim 含 role 权限(对照组)', async () => {
    const world = await makeWorld()
    await seedOpenWithPermission(world)
    const first = await authorize(world.ctx, world.env, makeSession(REQUESTER), world.challenge)
    const code = expectRpCode(redirectLocation(first))
    const tokenRes = await exchangeCode(world.ctx, world.env, code, world.verifier)
    expect(tokenRes.status).toBe(200)
    const accessPayload = await verifyPayload(
      world.ctx,
      ((await tokenRes.json()) as Record<string, string>)['access_token']!,
    )
    expect(accessPayload['permissions']).toContain('users.read')
  })

  it('过期 grant:permissions claim 不含 role 权限,签发仍成功', async () => {
    const world = await makeWorld()
    await seedOpenWithPermission(world)
    expireRequesterGrant(world.db, Date.now() - 1000)
    const first = await authorize(world.ctx, world.env, makeSession(REQUESTER), world.challenge)
    const code = expectRpCode(redirectLocation(first))
    const tokenRes = await exchangeCode(world.ctx, world.env, code, world.verifier)
    expect(tokenRes.status).toBe(200)
    const accessPayload = await verifyPayload(
      world.ctx,
      ((await tokenRes.json()) as Record<string, string>)['access_token']!,
    )
    expect(accessPayload['permissions']).toEqual([])
  })
})
