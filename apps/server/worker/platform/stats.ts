// GET /v1/platform/stats:平台全局聚合(契约 PlatformStats 超集,非分页)。
// 跨所有租户聚合走独立管理路径(requireInstanceManager 后用 managementDb,见 shared.ts)。
// 数据源:D1 count + usage_daily/usage_monthly(dau/mau)+ audit_events 登录成功/失败计数。
// Analytics Engine 在 Workers 运行时无读 API(writeDataPoint 仅写),统计读 D1 计量与审计表。

import { schema } from '@xid-kit/db'
import type { PlatformStats } from '@xid-kit/types'
import { and, asc, count, desc, eq, isNull, like, lt, lte, ne, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import { LOGIN_STATS_WINDOW_MS, loginOutcomeFilters, loginSuccessRate } from '../lib/login-audit'
import { JWKS_CACHE_TTL_SEC } from '../lib/ttl'
import type { XidHonoEnv } from '../lib/types'
import { loadUserDisplayNames } from './audit-events'
import { managementDb, requireInstanceManager, topLevelOrgFilter } from './shared'

const app = new Hono<XidHonoEnv>()
const MAU_QUOTA_ATTENTION_RATIO = 0.9
const RECENT_PLATFORM_ACTIVITY_LIMIT = 5
const DAY_MS = 24 * 60 * 60 * 1000

type Db = ReturnType<typeof managementDb>

export type PlatformAttentionKind =
  | 'dead_letters'
  | 'incident_open'
  | 'signing_key_next_ready'
  | 'mau_quota_high'
  | 'organization_suspended'

export type PlatformAttentionItem = {
  kind: PlatformAttentionKind
  facts: Record<string, unknown>
}

export type PlatformActivityKey = 'dau' | 'mau' | 'login_success_rate' | 'organizations' | 'users'

export type PlatformActivityMetric = {
  key: PlatformActivityKey
  now: number | null
  previous: number | null
}

export type PlatformRecentActivity = {
  id: string
  eventType: string
  actorId: string | null
  actorName: string | null
  targetType: string | null
  targetId: string | null
  occurredAt: string
}

export type PlatformOverviewStats = PlatformStats & {
  attention: PlatformAttentionItem[]
  activity: PlatformActivityMetric[]
  recentPlatformActivity: PlatformRecentActivity[]
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function utcYearMonth(date: Date): string {
  return date.toISOString().slice(0, 7)
}

function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

async function sumDau(db: Db, day: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`coalesce(sum(${schema.usageDaily.dau}), 0)` })
    .from(schema.usageDaily)
    .where(eq(schema.usageDaily.day, day))
  return Number(row?.value ?? 0)
}

async function sumMau(db: Db, yearMonth: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`coalesce(sum(${schema.usageMonthly.mau}), 0)` })
    .from(schema.usageMonthly)
    .where(eq(schema.usageMonthly.yearMonth, yearMonth))
  return Number(row?.value ?? 0)
}

async function countAudit(db: Db, filter: SQL | undefined): Promise<number> {
  const [row] = await db.select({ value: count() }).from(schema.auditEvents).where(filter)
  return row?.value ?? 0
}

async function loginRates(
  db: Db,
  now: Date,
): Promise<{ now: number | null; previous: number | null }> {
  const current = loginOutcomeFilters(now)
  const previousEnd = new Date(now.getTime() - LOGIN_STATS_WINDOW_MS)
  const previous = loginOutcomeFilters(previousEnd)
  const previousWindow = and(
    previous.window,
    lt(schema.auditEvents.occurredAt, previousEnd.toISOString()),
  )
  const [success, failure, previousSuccess, previousFailure] = await Promise.all([
    countAudit(db, and(current.window, current.succeeded)),
    countAudit(db, and(current.window, current.failed)),
    countAudit(db, and(previousWindow, previous.succeeded)),
    countAudit(db, and(previousWindow, previous.failed)),
  ])
  return {
    now: loginSuccessRate(success, failure),
    previous: loginSuccessRate(previousSuccess, previousFailure),
  }
}

async function countOrganizations(db: Db, filter?: SQL): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(schema.organizations)
    .where(and(topLevelOrgFilter(), filter))
  return row?.value ?? 0
}

async function countUsers(db: Db, filter?: SQL): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(schema.users)
    .where(and(ne(schema.users.status, 'deleted'), isNull(schema.users.deletedAt), filter))
  return row?.value ?? 0
}

async function deadLetterAttention(db: Db): Promise<PlatformAttentionItem[]> {
  const rows = await db
    .select({
      queue: schema.queueDeadLetters.sourceQueue,
      count: count(),
      oldestFailedAt: sql<number>`min(${schema.queueDeadLetters.failedAt})`,
    })
    .from(schema.queueDeadLetters)
    .where(eq(schema.queueDeadLetters.status, 'pending'))
    .groupBy(schema.queueDeadLetters.sourceQueue)
    .orderBy(desc(count()))
  const total = rows.reduce((sum, row) => sum + row.count, 0)
  if (total === 0) return []
  const oldest = Math.min(...rows.map((row) => Number(row.oldestFailedAt)))
  return [
    {
      kind: 'dead_letters',
      facts: {
        count: total,
        byQueue: rows.map((row) => ({ queue: row.queue, count: row.count })),
        oldestFailedAt: new Date(oldest).toISOString(),
      },
    },
  ]
}

async function incidentAttention(db: Db): Promise<PlatformAttentionItem[]> {
  const incidents = await db
    .select({
      id: schema.statusIncidents.id,
      title: schema.statusIncidents.title,
      status: schema.statusIncidents.status,
      startedAt: schema.statusIncidents.startedAt,
      lastUpdateAt: sql<number | null>`(
        SELECT max(${schema.statusIncidentUpdates.createdAt})
          FROM ${schema.statusIncidentUpdates}
         WHERE ${schema.statusIncidentUpdates.incidentId} = ${schema.statusIncidents.id}
      )`,
    })
    .from(schema.statusIncidents)
    .where(ne(schema.statusIncidents.status, 'resolved'))
    .orderBy(asc(schema.statusIncidents.startedAt))
  return incidents.map((incident) => ({
    kind: 'incident_open',
    facts: {
      incidentId: incident.id,
      title: incident.title,
      status: incident.status,
      startedAt: incident.startedAt.toISOString(),
      lastUpdateAt:
        incident.lastUpdateAt === null
          ? null
          : new Date(Number(incident.lastUpdateAt)).toISOString(),
    },
  }))
}

// 只读公钥元数据;发布满 JWKS 缓存 TTL 后 RP 已拿到新公钥,提升为 active 仍是显式管理操作。
async function signingKeyAttention(db: Db, now: Date): Promise<PlatformAttentionItem[]> {
  const readyBefore = new Date(now.getTime() - JWKS_CACHE_TTL_SEC * 1000)
  const keys = await db
    .select({
      kid: schema.instanceSigningKeys.kid,
      createdAt: schema.instanceSigningKeys.createdAt,
    })
    .from(schema.instanceSigningKeys)
    .where(
      and(
        eq(schema.instanceSigningKeys.status, 'next'),
        lte(schema.instanceSigningKeys.createdAt, readyBefore),
      ),
    )
  return keys.map((key) => ({
    kind: 'signing_key_next_ready',
    facts: { kid: key.kid, publishedAt: key.createdAt.toISOString() },
  }))
}

async function mauQuotaAttention(db: Db, now: Date): Promise<PlatformAttentionItem[]> {
  const rows = await db
    .select({
      organizationId: schema.organizations.id,
      name: schema.organizations.name,
      mau: schema.usageMonthly.mau,
      limit: schema.organizationQuotas.limit,
    })
    .from(schema.organizationQuotas)
    .innerJoin(
      schema.organizations,
      eq(schema.organizations.id, schema.organizationQuotas.tenantId),
    )
    .innerJoin(
      schema.usageMonthly,
      and(
        eq(schema.usageMonthly.tenantId, schema.organizationQuotas.tenantId),
        eq(schema.usageMonthly.yearMonth, utcYearMonth(now)),
      ),
    )
    .where(
      and(
        eq(schema.organizationQuotas.quotaKey, 'mau'),
        sql`${schema.organizationQuotas.limit} > 0`,
        sql`${schema.usageMonthly.mau} >= ${schema.organizationQuotas.limit} * ${MAU_QUOTA_ATTENTION_RATIO}`,
        topLevelOrgFilter(),
      ),
    )
    .orderBy(asc(schema.organizations.name))
  if (rows.length === 0) return []
  return [
    {
      kind: 'mau_quota_high',
      facts: {
        organizations: rows.map((row) => ({
          organizationId: row.organizationId,
          name: row.name,
          mau: row.mau,
          limit: row.limit,
        })),
      },
    },
  ]
}

async function suspendedAttention(db: Db): Promise<PlatformAttentionItem[]> {
  const rows = await db
    .select({
      id: schema.organizations.id,
      name: schema.organizations.name,
      updatedAt: schema.organizations.updatedAt,
    })
    .from(schema.organizations)
    .where(and(topLevelOrgFilter(), eq(schema.organizations.status, 'suspended')))
    .orderBy(desc(schema.organizations.updatedAt))
  return rows.map((row) => ({
    kind: 'organization_suspended',
    facts: { organizationId: row.id, name: row.name, suspendedAt: row.updatedAt.toISOString() },
  }))
}

async function platformAttention(db: Db, now: Date): Promise<PlatformAttentionItem[]> {
  const groups = await Promise.all([
    deadLetterAttention(db),
    incidentAttention(db),
    signingKeyAttention(db, now),
    mauQuotaAttention(db, now),
    suspendedAttention(db),
  ])
  return groups.flat()
}

async function recentPlatformActivity(db: Db): Promise<PlatformRecentActivity[]> {
  const rows = await db
    .select({
      id: schema.auditEvents.id,
      eventType: schema.auditEvents.eventType,
      actorId: schema.auditEvents.actorId,
      targetType: schema.auditEvents.targetType,
      targetId: schema.auditEvents.targetId,
      occurredAt: schema.auditEvents.occurredAt,
    })
    .from(schema.auditEvents)
    .where(like(schema.auditEvents.eventType, 'platform.%'))
    .orderBy(desc(schema.auditEvents.occurredAt), desc(schema.auditEvents.id))
    .limit(RECENT_PLATFORM_ACTIVITY_LIMIT)
  const names = await loadUserDisplayNames(
    db,
    rows.flatMap((row) => (row.actorId ? [row.actorId] : [])),
  )
  return rows.map((row) => ({
    ...row,
    actorName: row.actorId ? (names.get(row.actorId) ?? null) : null,
  }))
}

async function activityMetrics(db: Db, now: Date): Promise<PlatformActivityMetric[]> {
  const monthStart = startOfUtcMonth(now)
  const previousMonth = new Date(monthStart.getTime() - DAY_MS)
  const [
    dau,
    previousDau,
    mau,
    previousMau,
    rates,
    organizations,
    previousOrganizations,
    users,
    previousUsers,
  ] = await Promise.all([
    sumDau(db, utcDay(now)),
    sumDau(db, utcDay(new Date(now.getTime() - DAY_MS))),
    sumMau(db, utcYearMonth(now)),
    sumMau(db, utcYearMonth(previousMonth)),
    loginRates(db, now),
    countOrganizations(db),
    countOrganizations(db, lt(schema.organizations.createdAt, monthStart)),
    countUsers(db),
    countUsers(db, lt(schema.users.createdAt, monthStart)),
  ])
  return [
    { key: 'dau', now: dau, previous: previousDau },
    { key: 'mau', now: mau, previous: previousMau },
    { key: 'login_success_rate', now: rates.now, previous: rates.previous },
    { key: 'organizations', now: organizations, previous: previousOrganizations },
    { key: 'users', now: users, previous: previousUsers },
  ]
}

function metricValue(metrics: PlatformActivityMetric[], key: PlatformActivityKey): number | null {
  return metrics.find((metric) => metric.key === key)?.now ?? null
}

app.get('/', async (c) => {
  await requireInstanceManager(c)
  const db = managementDb(c.env)
  const now = new Date()
  const [activity, activeOrgCount, attention, recent] = await Promise.all([
    activityMetrics(db, now),
    countOrganizations(db, eq(schema.organizations.status, 'active')),
    platformAttention(db, now),
    recentPlatformActivity(db),
  ])

  const stats: PlatformOverviewStats = {
    organizationCount: metricValue(activity, 'organizations') ?? 0,
    totalUsers: metricValue(activity, 'users') ?? 0,
    dau: metricValue(activity, 'dau') ?? 0,
    mau: metricValue(activity, 'mau') ?? 0,
    loginSuccessRate: metricValue(activity, 'login_success_rate'),
    activeOrgCount,
    attention,
    activity,
    recentPlatformActivity: recent,
  }
  return c.json(stats)
})

export function registerPlatformStatsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/platform/stats', app)
}
