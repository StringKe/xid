// Metering Queue Consumer:认证成功事件去重 + MAU 聚合 + 按天写 usage_daily。
// 见 docs/design/07-platform-operations.md 第 7 节、7.1.2。
// - 按 tenant_id 分组,路由到 MeteringDO(metering:{tenantId})串行去重,解决 KV RMW 竞态。
// - DAU:由 MeteringDO 返回精确日快照，D1 只做单调覆盖，Queue 重投不重复累计。
// - MeteringDO.recordUser 幂等(per-user membership 键去重)，重复计量事件不增 MAU。

import type { MeteringQueueMessage } from '@xid-kit/types'

// MeteringDO RPC stub 形状(见 metering-do.ts)。
type MeteringStub = {
  recordUser(
    tenantId: string,
    userId: string,
    yearMonth: string,
    day: string,
  ): Promise<MeteringSnapshot>
}

type MeteringSnapshot = {
  day: string
  dau: number
}

// ts(Unix 毫秒)-> "YYYY-MM"(UTC)。
export function toYearMonth(ts: number): string {
  const d = new Date(ts)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

// ts(Unix 毫秒)-> "YYYY-MM-DD"(UTC)。
export function toDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

function getMeteringStub(env: Env, tenantId: string): MeteringStub {
  const id = env.METERING.idFromName(`metering:${tenantId}`)
  return env.METERING.get(id) as unknown as DurableObjectStub & MeteringStub
}

function groupByTenant(
  messages: ReadonlyArray<Message<MeteringQueueMessage>>,
): Map<string, Array<Message<MeteringQueueMessage>>> {
  const groups = new Map<string, Array<Message<MeteringQueueMessage>>>()
  for (const message of messages) {
    const tenantId = message.body.tenantId
    const existing = groups.get(tenantId)
    if (existing === undefined) {
      groups.set(tenantId, [message])
    } else {
      existing.push(message)
    }
  }
  return groups
}

// 将 DO 返回的按日精确快照单调覆盖到 D1。D1 成功而 ack 失败时，重投只会覆盖同一值。
async function upsertDailyUsage(
  env: Env,
  tenantId: string,
  snapshots: ReadonlyArray<MeteringSnapshot>,
): Promise<void> {
  const latestByDay = new Map<string, number>()
  for (const snapshot of snapshots) {
    latestByDay.set(snapshot.day, Math.max(latestByDay.get(snapshot.day) ?? 0, snapshot.dau))
  }
  const statements = Array.from(latestByDay.entries()).map(([day, dau]) =>
    env.DB.prepare(
      `INSERT INTO usage_daily (tenant_id, day, dau, api_calls, email_count, created_at, updated_at)
       VALUES (?, ?, ?, 0, 0, ?, ?)
       ON CONFLICT (tenant_id, day) DO UPDATE SET dau = MAX(usage_daily.dau, excluded.dau), updated_at = excluded.updated_at`,
    ).bind(tenantId, day, dau, Date.now(), Date.now()),
  )
  if (statements.length > 0) {
    await env.DB.batch(statements)
  }
}

export async function handleMeteringBatch(
  batch: MessageBatch<MeteringQueueMessage>,
  env: Env,
): Promise<void> {
  const groups = groupByTenant(batch.messages)
  for (const [tenantId, messages] of groups) {
    try {
      const stub = getMeteringStub(env, tenantId)
      const snapshots: MeteringSnapshot[] = []
      // DO 将月度和日度集合一起持久化。每条消息获得该日的精确总数快照。
      for (const message of messages) {
        const yearMonth = toYearMonth(message.body.ts)
        const day = toDay(message.body.ts)
        const snapshot = await stub.recordUser(tenantId, message.body.userId, yearMonth, day)
        snapshots.push({ day, dau: snapshot.dau })
      }
      await upsertDailyUsage(env, tenantId, snapshots)
      for (const message of messages) {
        message.ack()
      }
    } catch {
      for (const message of messages) {
        message.retry()
      }
    }
  }
}
