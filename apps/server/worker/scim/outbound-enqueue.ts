// 出站 SCIM 入队:单用户变化入队增量消息;org 级变化入队全量对账,同一 target 未开始的全量只保留一条。

import { createTenantDb, schema } from '@xid-kit/db'
import type { ScimSyncQueueMessage, TenantContext } from '@xid-kit/types'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { SCIM_FULL_SYNC_DEDUPE_WINDOW_MS } from '../lib/ttl'
import type { XidHonoEnv } from '../lib/types'
import type { ScimTarget } from './outbound-mapping'
import { runScimBackgroundTask } from './shared'
import { assertScimTargetHasToken, scimTargetHasToken } from './target-credentials'

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

// 管理员「立即同步」不经过全量去重:操作员明确要求现在跑一轮,即使已有未开始的自动全量也照样入队。
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

export type ScimTargetKey = { tenantId: string; orgId: string; targetId: string }

// 自动触发的全量对账入队前先抢占 full_sync_queued_at:标记为空或超过去重窗口才抢到。
// 用条件 UPDATE 做 compare-and-swap,daily cron 没有请求级 TenantContext 也走同一条语句。
export async function claimScimFullSync(
  env: Env,
  key: ScimTargetKey,
  now: number = Date.now(),
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE scim_targets SET full_sync_queued_at = ?1
      WHERE tenant_id = ?2 AND org_id = ?3 AND id = ?4
        AND (full_sync_queued_at IS NULL OR full_sync_queued_at < ?5)`,
  )
    .bind(now, key.tenantId, key.orgId, key.targetId, now - SCIM_FULL_SYNC_DEDUPE_WINDOW_MS)
    .run()
  return result.meta.changes > 0
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
    if (
      request.userId === undefined &&
      !(await claimScimFullSync(request.env, {
        tenantId: request.tenant.tenantId,
        orgId: target.orgId,
        targetId: target.id,
      }))
    ) {
      continue
    }
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
