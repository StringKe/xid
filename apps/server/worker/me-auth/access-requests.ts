// Project 访问申请 + 审批(见 docs/design/org-structure-access/design-access-request.md 3.1/3.2)。
// 全部端点按 cookie session 认证(requireSession),org 上下文取 session.activeOrgId。
// 铁律:tenant 从 c.get('tenant') 取;D1 走 createTenantDb 租户层(forOrg 双注入 tenant_id+org_id);
// 枚举防护:project 不属当前 org 或 policy 不符统一 404 project_not_found;
// approve/deny/cancel 用条件 UPDATE(status='pending')兜底并发,影响 0 行 -> 409 request_already_decided;
// 审批权限实时重跑 resolveAccessRequestApprover,不预存 approver 快照(设计 3.2),
// 候选人须持该 org active membership,失效顺延下一级;审计 waitUntil 离响应路径。

import { createTenantDb, resolveApproverChain, schema } from '@xid-kit/db'
import type { ApproverResolution, OrgScopedDb, OrgUnitScope } from '@xid-kit/db'
import { and, desc, eq, gt, isNull, or } from 'drizzle-orm'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import { logWorkerError } from '../lib/safe-log'
import { ACCESS_REQUEST_TTL_MS } from '../lib/ttl'
import type { SessionData, TenantVar, XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import { redactAuditPayload } from '../queues/audit-redaction'
import { requireSession } from './shared'

type AccessRequestRow = typeof schema.accessRequests.$inferSelect

export type AccessRequestApprover = {
  approverUserId: string
  level: 'unit_manager' | 'project_manager' | 'org_manager'
}

// 审批人必须是该 org 的 active member:被移出 org 的经理即刻失去审批权(解析与审批门共用)。
async function hasActiveMembership(db: OrgScopedDb, userId: string): Promise<boolean> {
  const membership = await db.memberships.findOne(
    and(eq(schema.memberships.userId, userId), eq(schema.memberships.status, 'active')),
  )
  return membership !== undefined
}

// 一次收件箱渲染内复用的解析缓存(见 handleAccessApprovalList):unit 链按 requester、
// project_manager 候选按 project、org_manager 候选全 org 至多一次、membership 按 user。
// 单请求路径(requireApprover)每次新建空缓存,语义与逐次实时查询一致。
export type ApproverResolutionCaches = {
  unitChainByRequester: Map<string, ApproverResolution | null>
  projectManagersByProject: Map<string, string[]>
  orgManagerUserIds: string[] | null
  membershipByUser: Map<string, boolean>
}

export function createApproverResolutionCaches(): ApproverResolutionCaches {
  return {
    unitChainByRequester: new Map(),
    projectManagersByProject: new Map(),
    orgManagerUserIds: null,
    membershipByUser: new Map(),
  }
}

async function cachedActiveMembership(
  caches: ApproverResolutionCaches,
  db: OrgScopedDb,
  userId: string,
): Promise<boolean> {
  const hit = caches.membershipByUser.get(userId)
  if (hit !== undefined) return hit
  const active = await hasActiveMembership(db, userId)
  caches.membershipByUser.set(userId, active)
  return active
}

// 审批人解析(设计 1.4):unit 链 -> project_manager -> org_manager,第一命中且 != requester 者胜出;
// 命中者 == requester 或无 active membership 都顺延下一级(审批人不能审自己,离群经理无审批权);
// 三级全空返回 null -> 409 no_available_approver。unit 经理解析在 @xid-kit/db 层,
// 本层只对链结果做 membership 复核,复核不过顺延;project/org 两级在本层过滤。
export async function resolveAccessRequestApprover(
  scope: OrgUnitScope,
  request: Pick<AccessRequestRow, 'requesterUserId' | 'projectId'>,
  caches: ApproverResolutionCaches = createApproverResolutionCaches(),
): Promise<AccessRequestApprover | null> {
  let chain = caches.unitChainByRequester.get(request.requesterUserId)
  if (chain === undefined) {
    chain = await resolveApproverChain(scope, request.requesterUserId)
    caches.unitChainByRequester.set(request.requesterUserId, chain)
  }
  const db = createTenantDb(scope.d1, scope.ctx)
  const orgDb = db.forOrg(scope.orgId)
  if (
    chain &&
    chain.managerUserId !== request.requesterUserId &&
    (await cachedActiveMembership(caches, orgDb, chain.managerUserId))
  ) {
    return { approverUserId: chain.managerUserId, level: 'unit_manager' }
  }
  // 多人同岗按 created_at ASC 取最早的有效候选(确定性,设计 1.4);membership 失效顺延下一位。
  let projectManagerIds = caches.projectManagersByProject.get(request.projectId)
  if (projectManagerIds === undefined) {
    const rows = await db.managerAssignments.findMany(
      and(
        eq(schema.managerAssignments.managerRole, 'project_manager'),
        eq(schema.managerAssignments.scopeType, 'project'),
        eq(schema.managerAssignments.scopeId, request.projectId),
      ),
      { orderBy: schema.managerAssignments.createdAt },
    )
    projectManagerIds = rows.map((assignment) => assignment.userId)
    caches.projectManagersByProject.set(request.projectId, projectManagerIds)
  }
  for (const userId of projectManagerIds) {
    if (userId === request.requesterUserId) continue
    if (await cachedActiveMembership(caches, orgDb, userId)) {
      return { approverUserId: userId, level: 'project_manager' }
    }
  }
  // org_manager 候选与 requester/project 无关,每次解析至多查一次。
  if (caches.orgManagerUserIds === null) {
    const rows = await db.managerAssignments.findMany(
      and(
        eq(schema.managerAssignments.managerRole, 'org_manager'),
        eq(schema.managerAssignments.scopeType, 'org'),
        eq(schema.managerAssignments.scopeId, scope.orgId),
      ),
      { orderBy: schema.managerAssignments.createdAt },
    )
    caches.orgManagerUserIds = rows.map((assignment) => assignment.userId)
  }
  for (const userId of caches.orgManagerUserIds) {
    if (userId === request.requesterUserId) continue
    if (await cachedActiveMembership(caches, orgDb, userId)) {
      return { approverUserId: userId, level: 'org_manager' }
    }
  }
  return null
}

// D1/SQLite 唯一冲突判定:同 (tenant, project, requester) 的 pending 重复是预期失败(409),
// 其余错误原样抛出。drizzle 把底层错误包进 "Failed query",原始错误在 cause 链上。
function isUniqueViolation(cause: unknown): boolean {
  let current: unknown = cause
  while (current instanceof Error) {
    if (current.message.includes('UNIQUE constraint failed')) return true
    current = current.cause
  }
  return false
}

// 无 ExecutionContext(单测 harness)时 Hono 的 c.executionCtx 抛固定文案,降级为 catch+log。
function readExecutionContext(c: Context<XidHonoEnv>) {
  try {
    return c.executionCtx
  } catch (error) {
    if (error instanceof Error && error.message === 'This context has no ExecutionContext') {
      return undefined
    }
    throw error
  }
}

// 审计走 AUDIT_QUEUE(INSERT-only 管线,见 cloudflare-bindings rule);payload 字段照设计 3.4,
// 过 redactAuditPayload 脱敏。写库已提交后 queue 失败不得把 approve/deny/cancel 变 500:
// waitUntil 挂到 execution context 由平台观测;无 executionCtx 时 catch 后 log
// (v1/shared.ts emitManagementAuditAsync 同款 failure semantics)。
function emitAccessRequestAudit(
  c: Context<XidHonoEnv>,
  action:
    | 'access_request.created'
    | 'access_request.approved'
    | 'access_request.denied'
    | 'access_request.cancelled'
    | 'access_request.expired',
  actorId: string,
  payload: Record<string, unknown>,
): void {
  const task = Promise.resolve(
    c.env.AUDIT_QUEUE.send({
      tenantId: c.get('tenant').tenantId,
      action,
      actorId,
      ts: Date.now(),
      payload: redactAuditPayload(payload),
    }),
  )
  const executionCtx = readExecutionContext(c)
  if (executionCtx !== undefined) {
    executionCtx.waitUntil(task)
    return
  }
  void task.catch((error: unknown) =>
    logWorkerError('me_auth.audit_queue.send_failed', error, {
      component: 'me-auth',
      queue: 'audit',
    }),
  )
}

// 惰性过期(设计 1.3):pending 且 created_at 超 14 天 -> 条件 UPDATE 翻转 expired + 审计。
// 所有读取路径(列表 / cancel / approve / deny / v1 管理端列表与详情)统一走本助手;
// 条件 UPDATE 保证单写者语义。导出供 v1/access-requests.ts 复用。
export async function normalizeExpiredRequest(
  c: Context<XidHonoEnv>,
  db: OrgScopedDb,
  row: AccessRequestRow,
): Promise<AccessRequestRow> {
  if (row.status !== 'pending') return row
  if (row.createdAt.getTime() >= Date.now() - ACCESS_REQUEST_TTL_MS) return row
  const updated = await db.accessRequests.update(
    { status: 'expired', updatedAt: new Date() },
    and(eq(schema.accessRequests.id, row.id), eq(schema.accessRequests.status, 'pending')),
  )
  const flipped = updated[0]
  if (!flipped) return row
  emitAccessRequestAudit(c, 'access_request.expired', row.requesterUserId, {
    requestId: row.id,
    requesterUserId: row.requesterUserId,
    projectId: row.projectId,
  })
  return flipped
}

// org 上下文:session 无 active org 时六个端点统一 404(org_not_found),不泄露任何资源存在性。
function requireActiveOrgId(session: SessionData): string {
  if (!session.activeOrgId) throw new AppError('org_not_found', { httpStatus: 404 })
  return session.activeOrgId
}

function serializeAccessRequest(row: AccessRequestRow): Record<string, unknown> {
  return {
    id: row.id,
    projectId: row.projectId,
    roleId: row.roleId,
    justification: row.justification,
    status: row.status,
    requesterUserId: row.requesterUserId,
    approverUserId: row.approverUserId,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionReason: row.decisionReason,
    grantExpiresAt: row.grantExpiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

// 加载 org 内申请;不存在(含跨 org / 跨租户 id)-> 404 not_found,不泄露存在性。
async function loadOrgRequest(db: OrgScopedDb, requestId: string): Promise<AccessRequestRow> {
  const row = await db.accessRequests.findOne(eq(schema.accessRequests.id, requestId))
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  return row
}

// 审批端点共用的权限门:惰性过期 -> 终态 409 -> 操作者 active membership 403 ->
// 实时解析 approver -> 链空 409 -> 非本人 403。
// 审批人不能审自己由解析层保证(命中 requester 顺延),此处比对解析结果与当前用户;
// membership 门与解析层过滤互为冗余:操作者本人被移出 org 时直接 403,不落到链空 409。
async function requireApprover(
  actor: { c: Context<XidHonoEnv>; tenant: TenantVar; session: SessionData; db: OrgScopedDb },
  requestId: string,
): Promise<AccessRequestRow> {
  const { c, tenant, session, db } = actor
  const loaded = await loadOrgRequest(db, requestId)
  const row = await normalizeExpiredRequest(c, db, loaded)
  if (row.status !== 'pending') throw new AppError('request_already_decided', { httpStatus: 409 })
  if (!(await hasActiveMembership(db, session.userId))) {
    throw new AppError('forbidden', { httpStatus: 403 })
  }
  const scope: OrgUnitScope = { d1: c.env.DB, ctx: tenant, orgId: db.orgId }
  const resolution = await resolveAccessRequestApprover(scope, row)
  if (!resolution) throw new AppError('no_available_approver', { httpStatus: 409 })
  if (resolution.approverUserId !== session.userId) {
    throw new AppError('forbidden', { httpStatus: 403 })
  }
  return row
}

// 角色必须属于该 project 且 active(申请与审批共用;user_grants 引用 role,边界校验)。
async function requireProjectRole(
  c: Context<XidHonoEnv>,
  tenant: TenantVar,
  projectId: string,
  roleId: string,
): Promise<void> {
  const db = createTenantDb(c.env.DB, tenant)
  const role = await db.roles.findOne(
    and(
      eq(schema.roles.id, roleId),
      eq(schema.roles.projectId, projectId),
      eq(schema.roles.status, 'active'),
      isNull(schema.roles.deletedAt),
    ),
  )
  if (!role) throw new AppError('role_not_found', { httpStatus: 404 })
}

// ---- 自助申请(requester,设计 3.1) ----

const createBodySchema = v.object({
  project_id: v.pipe(v.string(), v.minLength(1)),
  role_id: v.optional(v.pipe(v.string(), v.minLength(1))),
  justification: v.optional(v.pipe(v.string(), v.maxLength(2000))),
})

// POST /auth/access-requests { project_id, role_id?, justification? }
export async function handleAccessRequestCreate(c: Context<XidHonoEnv>): Promise<Response> {
  const tenant = c.get('tenant')
  const session = await requireSession(c)
  const orgId = requireActiveOrgId(session)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createBodySchema, json.value)

  const db = createTenantDb(c.env.DB, tenant)
  const orgDb = db.forOrg(orgId)
  const membership = await orgDb.memberships.findOne(
    and(eq(schema.memberships.userId, session.userId), eq(schema.memberships.status, 'active')),
  )
  if (!membership) throw new AppError('membership_not_found', { httpStatus: 404 })

  // 枚举防护:不存在 / 不属当前 org / 非 active / policy 不符统一 404 project_not_found。
  const project = await orgDb.projects.findOne(
    and(
      eq(schema.projects.id, body.project_id),
      eq(schema.projects.status, 'active'),
      eq(schema.projects.accessPolicy, 'approval_required'),
      isNull(schema.projects.deletedAt),
    ),
  )
  if (!project) throw new AppError('project_not_found', { httpStatus: 404 })

  if (body.role_id !== undefined) {
    await requireProjectRole(c, tenant, project.id, body.role_id)
  }

  // 同 (user, project) 可能有多行(不同 role、或 JIT 复活后的新旧行):带有效性谓词取全部
  // 匹配行,存在任一有效 grant(未 revoked 且未过期)即 409;过期行视同不存在(isGrantEffective
  // 同款 JIT 语义,落 SQL 谓词避免无 ORDER BY 的 findOne 任意命中过期行误判)。
  const effectiveGrants = await db.userGrants.findMany(
    and(
      eq(schema.userGrants.userId, session.userId),
      eq(schema.userGrants.projectId, project.id),
      isNull(schema.userGrants.grantedViaGrantId),
      isNull(schema.userGrants.revokedAt),
      or(isNull(schema.userGrants.expiresAt), gt(schema.userGrants.expiresAt, new Date())),
    ),
  )
  if (effectiveGrants.length > 0) {
    throw new AppError('grant_already_exists', { httpStatus: 409 })
  }

  const pending = await orgDb.accessRequests.findOne(
    and(
      eq(schema.accessRequests.projectId, project.id),
      eq(schema.accessRequests.requesterUserId, session.userId),
      eq(schema.accessRequests.status, 'pending'),
    ),
  )
  if (pending) throw new AppError('already_exists', { httpStatus: 409 })

  let row: AccessRequestRow
  try {
    row = await orgDb.accessRequests.insert({
      id: createPersistedId('accessRequest'),
      tenantId: tenant.tenantId,
      orgId,
      projectId: project.id,
      roleId: body.role_id ?? null,
      requesterUserId: session.userId,
      justification: body.justification ?? null,
      status: 'pending',
    })
  } catch (cause) {
    // 并发双 pending:partial unique index 兜底(设计 3.1)。
    if (isUniqueViolation(cause)) throw new AppError('already_exists', { httpStatus: 409 })
    throw cause
  }

  emitAccessRequestAudit(c, 'access_request.created', session.userId, {
    requestId: row.id,
    requesterUserId: row.requesterUserId,
    projectId: row.projectId,
    roleId: row.roleId,
  })
  return c.json({ request: serializeAccessRequest(row) }, 201)
}

// GET /auth/access-requests -- 我的申请列表(惰性过期处理)。
export async function handleAccessRequestListMine(c: Context<XidHonoEnv>): Promise<Response> {
  const tenant = c.get('tenant')
  const session = await requireSession(c)
  const orgId = requireActiveOrgId(session)
  const orgDb = createTenantDb(c.env.DB, tenant).forOrg(orgId)
  const rows = await orgDb.accessRequests.findMany(
    eq(schema.accessRequests.requesterUserId, session.userId),
    { orderBy: desc(schema.accessRequests.createdAt) },
  )
  const normalized: AccessRequestRow[] = []
  for (const row of rows) normalized.push(await normalizeExpiredRequest(c, orgDb, row))
  return c.json({ data: normalized.map(serializeAccessRequest) })
}

// POST /auth/access-requests/:id/cancel -- 仅本人 pending 可取消。
export async function handleAccessRequestCancel(c: Context<XidHonoEnv>): Promise<Response> {
  const tenant = c.get('tenant')
  const session = await requireSession(c)
  const orgId = requireActiveOrgId(session)
  const orgDb = createTenantDb(c.env.DB, tenant).forOrg(orgId)
  const loaded = await loadOrgRequest(orgDb, c.req.param('id') ?? '')
  // 非本人 -> 404(不泄露同 org 他人申请的存在性)。
  if (loaded.requesterUserId !== session.userId) {
    throw new AppError('not_found', { httpStatus: 404 })
  }
  const row = await normalizeExpiredRequest(c, orgDb, loaded)
  if (row.status !== 'pending') throw new AppError('request_already_decided', { httpStatus: 409 })

  const now = new Date()
  const updated = await orgDb.accessRequests.update(
    { status: 'cancelled', decidedAt: now, updatedAt: now },
    and(eq(schema.accessRequests.id, row.id), eq(schema.accessRequests.status, 'pending')),
  )
  const cancelled = updated[0]
  if (!cancelled) throw new AppError('request_already_decided', { httpStatus: 409 })

  emitAccessRequestAudit(c, 'access_request.cancelled', session.userId, {
    requestId: cancelled.id,
    requesterUserId: cancelled.requesterUserId,
    projectId: cancelled.projectId,
  })
  return c.json({ request: serializeAccessRequest(cancelled) })
}

// ---- 审批(approver,设计 3.2) ----

// GET /auth/access-approvals -- 待我审批:org 内 pending 候选逐个实时跑解析,比对当前用户。
// 候选 LIMIT 200 兜底 N+1 上限;一次渲染共享一份解析缓存(unit 链按 requester、
// project_manager 按 project、org_manager 至多一次、membership 按 user),对外语义不变。
export async function handleAccessApprovalList(c: Context<XidHonoEnv>): Promise<Response> {
  const tenant = c.get('tenant')
  const session = await requireSession(c)
  const orgId = requireActiveOrgId(session)
  const orgDb = createTenantDb(c.env.DB, tenant).forOrg(orgId)
  const candidates = await orgDb.accessRequests.findMany(
    eq(schema.accessRequests.status, 'pending'),
    { orderBy: schema.accessRequests.createdAt, limit: 200 },
  )
  const scope: OrgUnitScope = { d1: c.env.DB, ctx: tenant, orgId }
  const caches = createApproverResolutionCaches()
  const mine: AccessRequestRow[] = []
  for (const candidate of candidates) {
    const row = await normalizeExpiredRequest(c, orgDb, candidate)
    if (row.status !== 'pending') continue
    const resolution = await resolveAccessRequestApprover(scope, row, caches)
    if (resolution?.approverUserId === session.userId) mine.push(row)
  }
  return c.json({ data: mine.map(serializeAccessRequest) })
}

const approveBodySchema = v.object({
  role_id: v.optional(v.pipe(v.string(), v.minLength(1))),
  grant_expires_at: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
})

// POST /auth/access-approvals/:id/approve { role_id?, grant_expires_at? }
// 事务(d1.batch)三语句:
//   a. 条件 UPDATE 认领请求(status='pending' 兜底并发,影响 0 行 -> 409);
//   b. 复活同 (user, project, role) 已过期旧行(更新 expires_at + 溯源 request id),
//      EXISTS 守卫与 c 同款,仅当 a 认领成功才执行;
//   c. 无旧行时 INSERT ... WHERE EXISTS(已被我认领) AND NOT EXISTS(同 user/project/role
//      未 revoked grant,不限 expires_at -- b 刚复活的行与有效旧行都拦重复插入,设计 1.3:
//      granted_via_request_id 不在唯一索引内,复查是 load-bearing)。
// expires_at 为 NULL 的请求(永久 grant)approve 时 b 恒不匹配任何行,属正常:旧行要么不存在
// (c 插新行),要么有效存在(c 的 NOT EXISTS 拦,b/c 双零 = 幂等 approve)。
export async function handleAccessApprovalApprove(c: Context<XidHonoEnv>): Promise<Response> {
  const tenant = c.get('tenant')
  const session = await requireSession(c)
  const orgId = requireActiveOrgId(session)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(approveBodySchema, json.value)
  const db = createTenantDb(c.env.DB, tenant)
  const orgDb = db.forOrg(orgId)
  const row = await requireApprover({ c, tenant, session, db: orgDb }, c.req.param('id') ?? '')

  // request 带 role_id 优先且审批人不可改;未带则 body 必填(设计 3.2)。
  const roleId = row.roleId ?? body.role_id
  if (!roleId) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'role_id' } })
  }
  if (body.grant_expires_at !== undefined && body.grant_expires_at <= Date.now()) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'grant_expires_at' },
    })
  }
  await requireProjectRole(c, tenant, row.projectId, roleId)

  const now = Date.now()
  const grantExpiresAt = body.grant_expires_at ?? null
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE access_requests
          SET status = 'approved', approver_user_id = ?, decided_at = ?,
              grant_expires_at = ?, updated_at = ?
        WHERE tenant_id = ? AND org_id = ? AND id = ? AND status = 'pending'`,
    ).bind(session.userId, now, grantExpiresAt, now, tenant.tenantId, orgId, row.id),
    c.env.DB.prepare(
      `UPDATE user_grants
          SET expires_at = ?, granted_via_request_id = ?, updated_at = ?
        WHERE tenant_id = ? AND user_id = ? AND project_id = ? AND role_id = ?
          AND granted_via_grant_id IS NULL AND revoked_at IS NULL
          AND expires_at IS NOT NULL AND expires_at <= ?
          AND EXISTS (
            SELECT 1 FROM access_requests
             WHERE tenant_id = ? AND id = ? AND status = 'approved'
               AND approver_user_id = ? AND decided_at = ?
          )`,
    ).bind(
      grantExpiresAt,
      row.id,
      now,
      tenant.tenantId,
      row.requesterUserId,
      row.projectId,
      roleId,
      now,
      tenant.tenantId,
      row.id,
      session.userId,
      now,
    ),
    c.env.DB.prepare(
      `INSERT INTO user_grants (
         id, tenant_id, user_id, project_id, role_id,
         granted_via_grant_id, granted_via_request_id, expires_at, revoked_at,
         created_at, updated_at
       )
       SELECT ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM access_requests
          WHERE tenant_id = ? AND id = ? AND status = 'approved'
            AND approver_user_id = ? AND decided_at = ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM user_grants
          WHERE tenant_id = ? AND user_id = ? AND project_id = ? AND role_id = ?
            AND granted_via_grant_id IS NULL AND revoked_at IS NULL
       )`,
    ).bind(
      createPersistedId('userGrant'),
      tenant.tenantId,
      row.requesterUserId,
      row.projectId,
      roleId,
      row.id,
      grantExpiresAt,
      now,
      now,
      tenant.tenantId,
      row.id,
      session.userId,
      now,
      tenant.tenantId,
      row.requesterUserId,
      row.projectId,
      roleId,
    ),
  ])
  if ((results[0]?.meta.changes ?? 0) === 0) {
    throw new AppError('request_already_decided', { httpStatus: 409 })
  }
  const revived = results[1]?.meta.changes ?? 0
  const inserted = results[2]?.meta.changes ?? 0
  if (revived === 0 && inserted === 0) {
    // 正常情形只剩一种:存在同 (user, project, role) 有效旧行(管理端并发直发),approve
    // 幂等只翻状态。复查不到有效行说明撞上并发极端情况,409 不静默成功。
    const liveGrant = await db.userGrants.findOne(
      and(
        eq(schema.userGrants.userId, row.requesterUserId),
        eq(schema.userGrants.projectId, row.projectId),
        eq(schema.userGrants.roleId, roleId),
        isNull(schema.userGrants.grantedViaGrantId),
        isNull(schema.userGrants.revokedAt),
        or(isNull(schema.userGrants.expiresAt), gt(schema.userGrants.expiresAt, new Date())),
      ),
    )
    if (!liveGrant) throw new AppError('conflict', { httpStatus: 409 })
  }

  const approved = await loadOrgRequest(orgDb, row.id)
  emitAccessRequestAudit(c, 'access_request.approved', session.userId, {
    requestId: approved.id,
    approverUserId: session.userId,
    requesterUserId: approved.requesterUserId,
    projectId: approved.projectId,
    roleId,
    grantExpiresAt: grantExpiresAt === null ? null : new Date(grantExpiresAt).toISOString(),
  })
  return c.json({ request: serializeAccessRequest(approved) })
}

const denyBodySchema = v.object({
  decision_reason: v.pipe(v.string(), v.minLength(1), v.maxLength(2000)),
})

// POST /auth/access-approvals/:id/deny { decision_reason }(必填,设计 1.3)。
export async function handleAccessApprovalDeny(c: Context<XidHonoEnv>): Promise<Response> {
  const tenant = c.get('tenant')
  const session = await requireSession(c)
  const orgId = requireActiveOrgId(session)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(denyBodySchema, json.value)
  const orgDb = createTenantDb(c.env.DB, tenant).forOrg(orgId)
  const row = await requireApprover({ c, tenant, session, db: orgDb }, c.req.param('id') ?? '')

  const now = Date.now()
  const result = await c.env.DB.prepare(
    `UPDATE access_requests
        SET status = 'denied', approver_user_id = ?, decided_at = ?,
            decision_reason = ?, updated_at = ?
      WHERE tenant_id = ? AND org_id = ? AND id = ? AND status = 'pending'`,
  )
    .bind(session.userId, now, body.decision_reason, now, tenant.tenantId, orgId, row.id)
    .run()
  if (result.meta.changes === 0) {
    throw new AppError('request_already_decided', { httpStatus: 409 })
  }

  const denied = await loadOrgRequest(orgDb, row.id)
  emitAccessRequestAudit(c, 'access_request.denied', session.userId, {
    requestId: denied.id,
    approverUserId: session.userId,
    requesterUserId: denied.requesterUserId,
    projectId: denied.projectId,
    roleId: denied.roleId,
    decisionReason: body.decision_reason,
  })
  return c.json({ request: serializeAccessRequest(denied) })
}
