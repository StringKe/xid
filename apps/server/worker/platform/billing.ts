// GET /v1/platform/billing:所有 organization 计费总览(契约 Page<BillingOverview>,nextCursor + total)。
// BillingOverview 无独立 id,主键即 organizationId;cursor 按 organizationId 字典序。
// 跨 organization 走独立管理路径(requireInstanceManager + managementDb,见 shared.ts、tenant-isolation rule)。
// seat:org.seat_used / seat_limit(denormalized 计数列,见 08 章 10.2);mau/dau:usage_monthly/usage_daily 当期。
// status:seatLimit 非空且 seatUsed > seatLimit -> exceeded;否则 ok(overdue 需账务状态源,首版无 -> 不臆造,归 ok)。

import { schema } from '@xid-kit/db'
import { and, count, eq, gt, inArray, isNull } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import {
  decodeCursor,
  encodeCursor,
  managementDb,
  parsePlatformPagination,
  requireInstanceManager,
} from './shared'

const app = new Hono<XidHonoEnv>()

const BILLING_STATUSES = ['ok', 'overdue', 'exceeded'] as const
type BillingStatus = (typeof BILLING_STATUSES)[number]

type BillingOverview = {
  organizationId: string
  organizationName: string
  plan: string
  mau: number
  dau: number
  seatUsed: number
  seatLimit: number | null
  status: BillingStatus
}

function billingStatus(seatUsed: number, seatLimit: number | null): BillingStatus {
  if (seatLimit !== null && seatUsed > seatLimit) return 'exceeded'
  return 'ok'
}

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

app.get('/', async (c) => {
  await requireInstanceManager(c)
  const db = managementDb(c.env)
  const { limit, cursor } = parsePlatformPagination(c, 20)
  const now = new Date()

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

  const { dau, mau } = await usageByTenant(
    db,
    now,
    pageRows.map((row) => row.id),
  )
  const data: BillingOverview[] = pageRows.map((row) => ({
    organizationId: row.id,
    organizationName: row.name,
    plan: 'free',
    mau: mau.get(row.id) ?? 0,
    dau: dau.get(row.id) ?? 0,
    seatUsed: row.seatUsed,
    seatLimit: row.seatLimit ?? null,
    status: billingStatus(row.seatUsed, row.seatLimit ?? null),
  }))

  return c.json({ data, nextCursor, total: totalRow?.value ?? 0 })
})

export function registerPlatformBillingRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/platform/billing', app)
}
