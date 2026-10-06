// GET /v1/platform/stats:平台全局聚合(契约 PlatformStats,非分页)。
// 跨所有租户聚合走独立管理路径(requireInstanceManager 后用 managementDb,见 shared.ts)。
// 数据源:D1 count(organizationCount/totalUsers/activeOrgCount)+ usage_daily/usage_monthly(dau/mau)
//   + 近 30 天 audit_events 登录成功/失败计数(loginSuccessRate,无样本为 null)。
// Analytics Engine 在 Workers 运行时无读 API(writeDataPoint 仅写),统计读 D1 计量与审计表。

import { schema } from '@xid-kit/db'
import type { PlatformStats } from '@xid-kit/types'
import { and, count, eq, isNull, ne, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { loginOutcomeFilters, loginSuccessRate } from '../lib/login-audit'
import type { XidHonoEnv } from '../lib/types'
import { managementDb, requireInstanceManager, topLevelOrgFilter } from './shared'

const app = new Hono<XidHonoEnv>()

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10)
}

function utcYearMonth(now: Date): string {
  return now.toISOString().slice(0, 7)
}

app.get('/', async (c) => {
  await requireInstanceManager(c)
  const db = managementDb(c.env)
  const now = new Date()
  const login = loginOutcomeFilters(now)

  const [
    [organizationRow],
    [activeOrgRow],
    [userRow],
    [dauRow],
    [mauRow],
    [successRow],
    [failureRow],
  ] = await Promise.all([
    db.select({ value: count() }).from(schema.organizations).where(topLevelOrgFilter()),
    db
      .select({ value: count() })
      .from(schema.organizations)
      .where(and(topLevelOrgFilter(), eq(schema.organizations.status, 'active'))),
    db
      .select({ value: count() })
      .from(schema.users)
      .where(and(ne(schema.users.status, 'deleted'), isNull(schema.users.deletedAt))),
    db
      .select({ value: sql<number>`coalesce(sum(${schema.usageDaily.dau}), 0)` })
      .from(schema.usageDaily)
      .where(eq(schema.usageDaily.day, utcDay(now))),
    db
      .select({ value: sql<number>`coalesce(sum(${schema.usageMonthly.mau}), 0)` })
      .from(schema.usageMonthly)
      .where(eq(schema.usageMonthly.yearMonth, utcYearMonth(now))),
    db
      .select({ value: count() })
      .from(schema.auditEvents)
      .where(and(login.window, login.succeeded)),
    db.select({ value: count() }).from(schema.auditEvents).where(and(login.window, login.failed)),
  ])

  const stats: PlatformStats = {
    organizationCount: organizationRow?.value ?? 0,
    totalUsers: userRow?.value ?? 0,
    dau: Number(dauRow?.value ?? 0),
    mau: Number(mauRow?.value ?? 0),
    loginSuccessRate: loginSuccessRate(successRow?.value ?? 0, failureRow?.value ?? 0),
    activeOrgCount: activeOrgRow?.value ?? 0,
  }
  return c.json(stats)
})

export function registerPlatformStatsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/platform/stats', app)
}
