// 访问申请:同 (tenant, project, requester) 至多一个 pending(partial unique 兜底并发);无 FK。

import { sql } from 'drizzle-orm'
import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { tenantId, timestamps, tsMs } from './common'

export const accessRequests = sqliteTable(
  'access_requests',
  {
    id: text('id').primaryKey(),
    tenantId: tenantId(),
    orgId: text('org_id').notNull(),
    projectId: text('project_id').notNull(),
    roleId: text('role_id'),
    requesterUserId: text('requester_user_id').notNull(),
    justification: text('justification'),
    status: text('status').notNull().default('pending'),
    approverUserId: text('approver_user_id'),
    decidedAt: tsMs('decided_at'),
    decisionReason: text('decision_reason'),
    grantExpiresAt: tsMs('grant_expires_at'),
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
