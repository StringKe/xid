// GET /v1/platform/usage:所有顶层 organization 的用量总览(契约 Page<UsageOverview>,nextCursor + total)。
// 主键即 organizationId;cursor 按 organizationId 字典序。跨 organization 走独立管理路径
// (requireInstanceManager + managementDb,见 shared.ts、tenant-isolation rule)。
// mau/dau 取 usage_monthly/usage_daily 当期;seatUsed 为全租户 distinct active 成员,只做观测。
// 计费开启时附带 billingStatus:计费账户 past_due -> overdue,其余 ok。

import { schema } from '@xid-kit/db'
import type { UsageBillingStatus, UsageOverview } from '@xid-kit/types'
import { and, count, countDistinct, eq, gt, inArray, isNull } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { billingEnabled } from '../lib/usage-billing'
import {
  decodeCursor,
  encodeCursor,
  managementDb,
  parsePlatformPagination,
  requireInstanceManager,
} from './shared'

const app = new Hono<XidHonoEnv>()

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10)
}

function utcYearMonth(now: Date): string {
  return now.toISOString().slice(0, 7)
}

// 顶层 organization + cursor 谓词(organizationId = org.id 字典序)。
function buildWhere(cursor: string | null): SQL {
  const filters: (SQL | undefined)[] = [isNull(schema.organizations.parentOrgId)]
  if (cursor) filters.push(gt(schema.organizations.id, decodeCursor(cursor)))
  return and(...filters.filter((f): f is SQL => f !== undefined)) as SQL
}

// 当期 dau/mau 按 tenant_id 聚合(单查分组,避免逐租户 N+1)。
async function usageByTenant(
  db: ReturnType<typeof managementDb>,
  now: Date,
  tenantIds: readonly string[],
): Promise<{ dau: Map<string, number>; mau: Map<string, number> }> {
  if (tenantIds.length === 0) return { dau: new Map(), mau: new Map() }
  const [dailyRows, monthlyRows] = await Promise.all([
    db
      .select({ tenantId: schema.usageDaily.tenantId, value: schema.usageDaily.dau })
      .from(schema.usageDaily)
      .where(
        and(eq(schema.usageDaily.day, utcDay(now)), inArray(schema.usageDaily.tenantId, tenantIds)),
      ),
    db
      .select({ tenantId: schema.usageMonthly.tenantId, value: schema.usageMonthly.mau })
      .from(schema.usageMonthly)
      .where(
        and(
          eq(schema.usageMonthly.yearMonth, utcYearMonth(now)),
          inArray(schema.usageMonthly.tenantId, tenantIds),
        ),
      ),
  ])
  return {
    dau: new Map(dailyRows.map((r) => [r.tenantId, r.value])),
    mau: new Map(monthlyRows.map((r) => [r.tenantId, r.value])),
  }
}

async function activeSeatsByTenant(
  db: ReturnType<typeof managementDb>,
  tenantIds: readonly string[],
): Promise<Map<string, number>> {
  if (tenantIds.length === 0) return new Map()
  const rows = await db
    .select({
      tenantId: schema.memberships.tenantId,
      value: countDistinct(schema.memberships.userId),
    })
    .from(schema.memberships)
    .where(
      and(inArray(schema.memberships.tenantId, tenantIds), eq(schema.memberships.status, 'active')),
    )
    .groupBy(schema.memberships.tenantId)
  return new Map(rows.map((row) => [row.tenantId, row.value]))
}

async function billingStatusByTenant(
  db: ReturnType<typeof managementDb>,
  tenantIds: readonly string[],
): Promise<Map<string, UsageBillingStatus>> {
  if (tenantIds.length === 0) return new Map()
  const rows = await db
    .select({
      tenantId: schema.organizationBillingAccounts.tenantId,
      status: schema.organizationBillingAccounts.status,
    })
    .from(schema.organizationBillingAccounts)
    .where(inArray(schema.organizationBillingAccounts.tenantId, tenantIds))
  return new Map(
    rows.map((row) => [row.tenantId, row.status === 'past_due' ? 'overdue' : 'ok'] as const),
  )
}

app.get('/', async (c) => {
  await requireInstanceManager(c)
  const db = managementDb(c.env)
  const { limit, cursor } = parsePlatformPagination(c, 20)
  const now = new Date()
  const withBilling = billingEnabled(c.env)

  const rows = await db
    .select()
    .from(schema.organizations)
    .where(buildWhere(cursor))
    .orderBy(schema.organizations.id)
    .limit(limit + 1)

  const [totalRow] = await db
    .select({ value: count() })
    .from(schema.organizations)
    .where(isNull(schema.organizations.parentOrgId))

  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const last = pageRows[pageRows.length - 1]
  const nextCursor = hasMore && last !== undefined ? encodeCursor(last.id) : null

  const tenantIds = pageRows.map((row) => row.id)
  const [{ dau, mau }, seats, billing] = await Promise.all([
    usageByTenant(db, now, tenantIds),
    activeSeatsByTenant(db, tenantIds),
    withBilling ? billingStatusByTenant(db, tenantIds) : Promise.resolve(null),
  ])
  const data: UsageOverview[] = pageRows.map((row) => ({
    organizationId: row.id,
    organizationName: row.name,
    mau: mau.get(row.id) ?? 0,
    dau: dau.get(row.id) ?? 0,
    seatUsed: seats.get(row.id) ?? 0,
    ...(billing ? { billingStatus: billing.get(row.id) ?? 'ok' } : {}),
  }))

  return c.json({ data, nextCursor, total: totalRow?.value ?? 0 })
})

export function registerPlatformUsageRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/platform/usage', app)
}
