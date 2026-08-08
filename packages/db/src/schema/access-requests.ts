// Project 访问申请(见 docs/design/org-structure-access/design-access-request.md 1.2):
// 同 (tenant, project, requester) 至多一个 pending 由 partial unique index 兜底并发;
// 状态机 pending -> approved/denied/cancelled/expired(终态互斥,见设计 1.3)。
// org_id 冗余自申请发生的 org(= requester active org)免 join。全部表无 FK,一致性由应用层维护。

import { sql } from 'drizzle-orm'
import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { tenantId, timestamps, tsMs } from './common'

export const accessRequests = sqliteTable(
  'access_requests',
  {
    id: text('id').primaryKey(), // ar_ 前缀 ULID
    tenantId: tenantId(),
    orgId: text('org_id').notNull(),
    projectId: text('project_id').notNull(),
    roleId: text('role_id'), // 申请的角色;null = 由审批人决定
    requesterUserId: text('requester_user_id').notNull(),
    justification: text('justification'),
    status: text('status').notNull().default('pending'),
    // 'pending' | 'approved' | 'denied' | 'cancelled' | 'expired'
    approverUserId: text('approver_user_id'), // 实际处理人
    decidedAt: tsMs('decided_at'),
    decisionReason: text('decision_reason'),
    grantExpiresAt: tsMs('grant_expires_at'), // 批准后写入 user_grants.expires_at
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('access_requests_pending_unq')
      .on(t.tenantId, t.projectId, t.requesterUserId)
      .where(sql`${t.status} = 'pending'`),
    index('access_requests_tenant_org_status_idx').on(t.tenantId, t.orgId, t.status, t.id),
    index('access_requests_tenant_project_status_idx').on(t.tenantId, t.projectId, t.status),
    index('access_requests_tenant_requester_idx').on(t.tenantId, t.requesterUserId, t.status),
    index('access_requests_approver_idx').on(t.tenantId, t.approverUserId, t.status),
  ],
)
