// POST /v1/me/organizations/:orgId/leave:本人离开组织。
// org 只在当前租户内按本人的 active membership 查找,别的租户或没有成员关系都返回 404。
// 唯一 owner 不能离开(last_owner);目录同步托管的成员关系由 IdP 决定,本人不能自行离开。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { AppError } from '../lib/errors'
import type { XidHonoEnv } from '../lib/types'
import { scheduleOrgScimTargetSyncs } from '../scim/outbound'
import { mutateMembership } from '../v1/memberships'
import { emitManagementAuditAsync, emitWebhookAsync } from '../v1/shared'
import { requireSession } from './shared'

const app = new Hono<XidHonoEnv>()

app.post('/:orgId/leave', async (c) => {
  const session = await requireSession(c)
  const tenant = c.get('tenant')
  const orgId = c.req.param('orgId')
  const db = createTenantDb(c.env.DB, tenant)
  const orgDb = db.forOrg(orgId)

  const membership = await orgDb.memberships.findOne(
    and(eq(schema.memberships.userId, session.userId), eq(schema.memberships.status, 'active')),
  )
  if (!membership) throw new AppError('not_found', { httpStatus: 404 })
  if (membership.isManaged) throw new AppError('forbidden', { httpStatus: 403 })

  const changed = await mutateMembership(c.env, {
    tenantId: tenant.tenantId,
    orgId,
    membershipId: membership.id,
    expectedStatus: 'active',
    status: 'inactive',
    protectActiveOwner: true,
  })
  if (!changed) {
    throw new AppError(membership.role === 'owner' ? 'last_owner' : 'conflict')
  }

  if (session.activeOrgId === orgId) {
    await db.sessions.update({ activeOrgId: null }, eq(schema.sessions.id, session.sessionId))
  }
  emitWebhookAsync(c, {
    tenantId: tenant.tenantId,
    event: 'organizationMembership.deleted',
    payload: { orgId, membershipId: membership.id, userId: session.userId },
  })
  scheduleOrgScimTargetSyncs(c, orgId)
  emitManagementAuditAsync(c, {
    action: 'membership.left',
    actorId: session.userId,
    orgId,
    targetType: 'membership',
    targetId: membership.id,
    details: { userId: session.userId, role: membership.role },
  })
  return new Response(null, { status: 204 })
})

export function registerMeOrganizationsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/me/organizations', app)
}
