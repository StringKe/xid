// 消息渠道近 24 小时失败统计:合并投递前失败(notification_failures)与 provider 层失败
// (notification_delivery_failures)。两张表都不在 createTenantDb 表集中,此处显式绑定租户谓词,
// 只读 channel 与 reason,不读 recipient / payload。

import { schema } from '@xid-kit/db'
import { and, eq, gte, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../lib/types'

const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000
export const DELIVERY_FAILURE_CHANNELS = ['email', 'sms', 'whatsapp'] as const
type DeliveryFailureChannel = (typeof DELIVERY_FAILURE_CHANNELS)[number]

export type DeliveryFailures24h = Record<
  DeliveryFailureChannel,
  { count: number; topReason: string | null }
>

type FailureCountRow = { channel: string; reason: string; count: number }

async function preDeliveryFailureCounts(
  d1: D1Database,
  tenantId: string,
  since: Date,
): Promise<FailureCountRow[]> {
  const table = schema.notificationFailures
  return drizzle(d1, { schema })
    .select({ channel: table.channel, reason: table.reason, count: sql<number>`count(*)` })
    .from(table)
    .where(and(eq(table.tenantId, tenantId), gte(table.failedAt, since.toISOString())))
    .groupBy(table.channel, table.reason)
}

async function providerFailureCounts(
  d1: D1Database,
  tenantId: string,
  since: Date,
): Promise<FailureCountRow[]> {
  const table = schema.notificationDeliveryFailures
  return drizzle(d1, { schema })
    .select({ channel: table.channel, reason: table.reason, count: sql<number>`count(*)` })
    .from(table)
    .where(and(eq(table.tenantId, tenantId), gte(table.failedAt, since)))
    .groupBy(table.channel, table.reason)
}

export function summarizeDeliveryFailures(rows: readonly FailureCountRow[]): DeliveryFailures24h {
  const byReason = new Map<DeliveryFailureChannel, Map<string, number>>()
  for (const row of rows) {
    const channel = DELIVERY_FAILURE_CHANNELS.find((name) => name === row.channel)
    if (!channel) continue
    const reasons = byReason.get(channel) ?? new Map<string, number>()
    reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + Number(row.count))
    byReason.set(channel, reasons)
  }
  const result: DeliveryFailures24h = {
    email: { count: 0, topReason: null },
    sms: { count: 0, topReason: null },
    whatsapp: { count: 0, topReason: null },
  }
  for (const [channel, reasons] of byReason) {
    let topCount = 0
    for (const [reason, count] of reasons) {
      result[channel].count += count
      if (count > topCount) {
        topCount = count
        result[channel].topReason = reason
      }
    }
  }
  return result
}

export async function deliveryFailures24h(
  c: Context<XidHonoEnv>,
  now = Date.now(),
): Promise<DeliveryFailures24h> {
  const tenantId = c.get('tenant').tenantId
  const since = new Date(now - FAILURE_WINDOW_MS)
  const [preDelivery, provider] = await Promise.all([
    preDeliveryFailureCounts(c.env.DB, tenantId, since),
    providerFailureCounts(c.env.DB, tenantId, since),
  ])
  return summarizeDeliveryFailures([...preDelivery, ...provider])
}
