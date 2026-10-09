// 出站 SCIM 入队:单用户变化入队增量消息;org 级变化入队全量对账,同一 target 未开始的全量只保留一条。

import { createTenantDb, schema } from '@xid-kit/db'
import type { ScimSyncQueueMessage, TenantContext } from '@xid-kit/types'
import { and, eq, isNull, lt, or } from 'drizzle-orm'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import type { ScimTarget } from './outbound-mapping'
import { runScimBackgroundTask } from './shared'
import { assertScimTargetHasToken, scimTargetHasToken } from './target-credentials'

// 入队标记超过这个时长仍未被消费时视为消息丢失,允许重新入队。
const FULL_SYNC_DEDUPE_WINDOW_MS = 60 * 60 * 1000

function scimSyncMessage(
  tenant: TenantContext,
  target: ScimTarget,
  extra: { actorId?: string; userId?: string },
): ScimSyncQueueMessage {
  return {
    tenantId: tenant.tenantId,
    orgId: target.orgId,
    targetId: target.id,
    issuer: tenant.issuer,
    runId: crypto.randomUUID(),
    requestedAt: Date.now(),
    ...(extra.actorId === undefined ? {} : { actorId: extra.actorId }),
    ...(extra.userId === undefined ? {} : { userId: extra.userId }),
  }
}

export async function enqueueScimTargetSync(
  c: Context<XidHonoEnv>,
  target: ScimTarget,
  actorId?: string,
): Promise<{ runId: string; targetId: string; status: 'queued' }> {
  assertScimTargetHasToken(c.env, target)
  const message = scimSyncMessage(c.get('tenant'), target, { actorId })
  await c.env.SCIM_QUEUE.send(message)
  return { runId: message.runId, targetId: target.id, status: 'queued' }
}

export type OrgScimSyncRequest = {
  env: Env
  tenant: TenantContext
  orgId: string
  userId?: string
}

async function claimFullSync(request: OrgScimSyncRequest, target: ScimTarget): Promise<boolean> {
  const now = Date.now()
  const claimed = await createTenantDb(request.env.DB, request.tenant)
    .forOrg(target.orgId)
    .scimTargets.update(
      { fullSyncQueuedAt: new Date(now) },
      and(
        eq(schema.scimTargets.id, target.id),
        or(
          isNull(schema.scimTargets.fullSyncQueuedAt),
          lt(schema.scimTargets.fullSyncQueuedAt, new Date(now - FULL_SYNC_DEDUPE_WINDOW_MS)),
        ),
      ),
    )
  return claimed.length > 0
}

// 消费者开始执行全量对账时释放标记,此后的变化会重新入队。
export async function releaseFullSyncClaim(
  env: Env,
  tenant: TenantContext,
  target: ScimTarget,
): Promise<void> {
  await createTenantDb(env.DB, tenant)
    .forOrg(target.orgId)
    .scimTargets.update({ fullSyncQueuedAt: null }, eq(schema.scimTargets.id, target.id))
}

export async function enqueueOrgScimTargetSyncs(request: OrgScimSyncRequest): Promise<number> {
  const targets = await createTenantDb(request.env.DB, request.tenant)
    .forOrg(request.orgId)
    .scimTargets.findMany(eq(schema.scimTargets.status, 'active'))
  let queued = 0
  for (const target of targets) {
    if (!scimTargetHasToken(request.env, target)) continue
    if (request.userId === undefined && !(await claimFullSync(request, target))) continue
    await request.env.SCIM_QUEUE.send(
      scimSyncMessage(request.tenant, target, { userId: request.userId }),
    )
    queued += 1
  }
  return queued
}

export function scheduleOrgScimTargetSyncs(
  c: Context<XidHonoEnv>,
  orgId: string,
  userId?: string,
): void {
  const task = enqueueOrgScimTargetSyncs({ env: c.env, tenant: c.get('tenant'), orgId, userId })
  runScimBackgroundTask(c, task, 'outbound_scim.auto_enqueue_failed')
}

// 账号状态是租户级的,该用户所在每个 org 的 target 都要同步这个用户。
export function scheduleUserScimTargetSyncs(c: Context<XidHonoEnv>, userId: string): void {
  const env = c.env
  const tenant = c.get('tenant')
  const task = (async () => {
    const memberships = await createTenantDb(env.DB, tenant).memberships.findMany(
      eq(schema.memberships.userId, userId),
    )
    for (const orgId of new Set(memberships.map((membership) => membership.orgId))) {
      await enqueueOrgScimTargetSyncs({ env, tenant, orgId, userId })
    }
  })()
  runScimBackgroundTask(c, task, 'outbound_scim.auto_enqueue_failed')
}
