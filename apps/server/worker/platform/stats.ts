// GET /v1/platform/stats:平台全局聚合(契约 PlatformStats,非分页,全字段必填)。
// 跨所有租户聚合走独立管理路径(requireInstanceManager 守卫后用 managementDb,见 shared.ts)。
// 数据源:D1 count(organizationCount/totalUsers/activeOrgCount)+ usage_daily/usage_monthly(dau/mau)
//   + audit_events 登录成功/失败计数(loginSuccessRate)。
// 注:Analytics Engine 在 Workers 运行时无读 API(writeDataPoint 仅写),DAU/MAU/成功率读 D1 计量与审计表。

import { schema } from '@xid-kit/db'
import { and, count, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { managementDb, requireInstanceManager, topLevelOrgFilter } from './shared'

const app = new Hono<XidHonoEnv>()

// 前端 *100 .toFixed(1) 显示,>=0.95 判 trend(见 PlatformAdminOverview.tsx)。无登录事件时默认 1.0。
type PlatformStats = {
  organizationCount: number
  totalUsers: number
  dau: number
  mau: number
  loginSuccessRate: number
  activeOrgCount: number
}

// 登录成功/失败审计事件类型(审计链 event_type,见 cloudflare-bindings rule 审计链)。
const LOGIN_SUCCESS_EVENTS = ['authentication.login_succeeded', 'user.signed_in'] as const
const LOGIN_FAILURE_EVENTS = ['authentication.login_failed', 'user.sign_in_failed'] as const

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
      .where(eq(schema.organizations.status, 'active')),
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
      .where(inArray(schema.auditEvents.eventType, [...LOGIN_SUCCESS_EVENTS])),
    db
      .select({ value: count() })
      .from(schema.auditEvents)
      .where(inArray(schema.auditEvents.eventType, [...LOGIN_FAILURE_EVENTS])),
  ])

  const successes = successRow?.value ?? 0
  const failures = failureRow?.value ?? 0
  const totalLogins = successes + failures
  const loginSuccessRate = totalLogins === 0 ? 1 : successes / totalLogins

  const stats: PlatformStats = {
    organizationCount: organizationRow?.value ?? 0,
    totalUsers: userRow?.value ?? 0,
    dau: Number(dauRow?.value ?? 0),
    mau: Number(mauRow?.value ?? 0),
    loginSuccessRate,
    activeOrgCount: activeOrgRow?.value ?? 0,
  }
  return c.json(stats)
})

export function registerPlatformStatsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/platform/stats', app)
}
