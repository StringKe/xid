// Outbound SCIM:XID 向下游 SaaS SCIM target 推送 users/groups 的手动触发入口。
// 与 inbound `/scim/v2/organizations/:organization_id/*` 分离,避免方向混淆。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { AppError } from '../lib/errors'
import type { SessionData, XidHonoEnv } from '../lib/types'
import { assertOrgSelfServiceEditable } from '../v1/org-self-service'
import { requireOrg, requireOrgManager } from '../v1/shared'
import { enqueueScimTargetSync } from './outbound-enqueue'
import type { ScimTarget } from './outbound-mapping'

export { OutboundScimRequestError } from './outbound-client'
export {
  enqueueOrgScimTargetSyncs,
  enqueueScimTargetSync,
  scheduleOrgScimTargetSyncs,
  scheduleUserScimTargetSyncs,
} from './outbound-enqueue'
export { executeScimTargetSync, executeScimUserSync } from './outbound-sync'

const outbound = new Hono<XidHonoEnv>()

function requireSession(c: Context<XidHonoEnv>): SessionData {
  const session = c.get('session')
  if (!session || session.status !== 'active') {
    throw new AppError('unauthorized', { httpStatus: 401 })
  }
  return session
}

async function resolveTarget(
  c: Context<XidHonoEnv>,
  targetId: string | undefined,
): Promise<ScimTarget> {
  if (!targetId) throw new AppError('invalid_request', { httpStatus: 400 })
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const target = await db.scimTargets.findOne(
    and(eq(schema.scimTargets.id, targetId), eq(schema.scimTargets.status, 'active')),
  )
  if (!target) throw new AppError('not_found', { httpStatus: 404 })
  return target
}

outbound.post('/:targetId/sync', async (c) => {
  // 触发入队必须是 org admin/owner 或 org_manager,普通 member 只读不放行。
  const session = requireSession(c)
  const target = await resolveTarget(c, c.req.param('targetId'))
  const manager = await requireOrgManager(c, target.orgId)
  await assertOrgSelfServiceEditable(
    c,
    { kind: 'org_console', ...manager },
    await requireOrg(c, target.orgId),
  )
  return c.json(await enqueueScimTargetSync(c, target, session.userId), 202)
})

export function registerOutboundScimRoutes(app: Hono<XidHonoEnv>): void {
  app.route('/scim/outbound', outbound)
}
