// Management API v1: /v1/organizations/:orgId/access-requests Project 访问申请只读视图。
// 设计来源 docs/design/org-structure-access/design-access-request.md 3.3。
// 管理端不做代审批(approve/deny 只走 me-auth 3.2 本人路径,审批必须绑定真实负责人身份进审计),
// 此处只有列表 + 详情;org_manager 的退化路径是现有 /v1 user-grants API。
// 认证:sk_live_ Bearer(access-requests:read)或 org manager cookie session。
// 租户隔离:createTenantDb.forOrg 双注入 tenant_id + org_id;跨租户/跨 org id 一律 404,不泄露存在性。
// 读取时惰性过期:pending 超 ACCESS_REQUEST_TTL_MS 顺手翻转 expired(复用 me-auth 同一助手,
// 翻转审计 access_request.expired 由助手内部发出)。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, gt } from 'drizzle-orm'
import { Hono } from 'hono'
import { AppError } from '../lib/errors'
import { ACCESS_REQUEST_TTL_MS } from '../lib/ttl'
import type { XidHonoEnv } from '../lib/types'
import { normalizeExpiredRequest } from '../me-auth/access-requests'
import { idAfterCursor, paginate, parsePagination, requireApiKeyOrOrgManager } from './shared'

const app = new Hono<XidHonoEnv>()

type AccessRequestRow = typeof schema.accessRequests.$inferSelect

// 状态机五态(设计 1.3);?status= 不在集合内 -> 422。
const ACCESS_REQUEST_STATUSES = new Set(['pending', 'approved', 'denied', 'cancelled', 'expired'])

// 行转对外响应(snake_case 白名单):剔除 tenant_id 隔离键。
function toResponse(row: AccessRequestRow) {
  return {
    id: row.id,
    org_id: row.orgId,
    project_id: row.projectId,
    role_id: row.roleId,
    requester_user_id: row.requesterUserId,
    justification: row.justification,
    status: row.status,
    approver_user_id: row.approverUserId,
    decided_at: row.decidedAt,
    decision_reason: row.decisionReason,
    grant_expires_at: row.grantExpiresAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

// GET /v1/organizations/:orgId/access-requests?status=&project_id=&limit=&cursor=
app.get('/:orgId/access-requests', async (c) => {
  const orgId = c.req.param('orgId')
  await requireApiKeyOrOrgManager(c, orgId, 'access-requests:read')

  const status = c.req.query('status')
  if (status !== undefined && !ACCESS_REQUEST_STATUSES.has(status)) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'status' } })
  }
  const projectId = c.req.query('project_id')
  const { limit, cursor } = parsePagination(c)

  const filters = []
  if (status) filters.push(eq(schema.accessRequests.status, status))
  if (projectId) filters.push(eq(schema.accessRequests.projectId, projectId))
  // ?status=pending 时 SQL 层先剔除必过期行(created_at 超 TTL):惰性翻转会把它们剔出本页,
  // 不先过滤会让 visible 缩水、has_more 假阴性,客户端提前停止翻页。翻转保留为纯防御。
  if (status === 'pending') {
    filters.push(gt(schema.accessRequests.createdAt, new Date(Date.now() - ACCESS_REQUEST_TTL_MS)))
  }
  const after = idAfterCursor(schema.accessRequests.id, cursor)
  if (after) filters.push(after)

  const orgDb = createTenantDb(c.env.DB, c.get('tenant')).forOrg(orgId)
  const rows = await orgDb.accessRequests.findMany(and(...filters), {
    orderBy: asc(schema.accessRequests.id),
    limit: limit + 1,
  })
  // 惰性过期可能把 pending 翻成 expired;带 status 过滤时翻转行不再命中,剔除出本页。
  const visible: AccessRequestRow[] = []
  for (const row of rows) {
    const current = await normalizeExpiredRequest(c, orgDb, row)
    if (status && current.status !== status) continue
    visible.push(current)
  }
  return c.json(paginate(visible.map(toResponse), (row) => row.id, limit))
})

// GET /v1/organizations/:orgId/access-requests/:id -- 详情(跨 org/跨租户 404)
app.get('/:orgId/access-requests/:id', async (c) => {
  const orgId = c.req.param('orgId')
  await requireApiKeyOrOrgManager(c, orgId, 'access-requests:read')

  const orgDb = createTenantDb(c.env.DB, c.get('tenant')).forOrg(orgId)
  const row = await orgDb.accessRequests.findOne(eq(schema.accessRequests.id, c.req.param('id')))
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  const current = await normalizeExpiredRequest(c, orgDb, row)
  return c.json(toResponse(current))
})

export function registerAccessRequestsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/organizations', app)
}
