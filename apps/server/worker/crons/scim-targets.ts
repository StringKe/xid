// daily cron 兜底:给每个已配置 token 的 active 出站 SCIM target 入队一轮同步,
// 覆盖未即时触发的成员与账号变化(04 章 3)。cron 无请求级 TenantContext,按 target 行携带的 tenant 投递。

import { instanceIssuerFor } from '@xid-kit/db'

const PAGE_SIZE = 100

type ScheduledTargetRow = {
  id: string
  tenantId: string
  orgId: string
  primaryDomain: string
}

export async function enqueueScheduledScimTargetSyncs(
  env: Env,
  now: number = Date.now(),
): Promise<number> {
  let cursor = ''
  let total = 0
  while (true) {
    const { results } = await env.DB.prepare(
      `SELECT t.id AS id, t.tenant_id AS tenantId, t.org_id AS orgId,
              i.primary_domain AS primaryDomain
         FROM scim_targets t
         JOIN organizations o ON o.id = t.tenant_id
         JOIN instances i ON i.id = o.instance_id
        WHERE t.status = 'active' AND t.token_ciphertext IS NOT NULL AND t.id > ?
        ORDER BY t.id
        LIMIT ?`,
    )
      .bind(cursor, PAGE_SIZE)
      .all<ScheduledTargetRow>()
    for (const row of results) {
      await env.SCIM_QUEUE.send({
        tenantId: row.tenantId,
        orgId: row.orgId,
        targetId: row.id,
        issuer: instanceIssuerFor(row),
        runId: crypto.randomUUID(),
        requestedAt: now,
      })
    }
    total += results.length
    const last = results[results.length - 1]
    if (!last || results.length < PAGE_SIZE) return total
    cursor = last.id
  }
}
