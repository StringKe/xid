// Organization Overview 的三个只读视图:待处理事项、登录活动对比、新组织引导进度。
// 只返回事实字段,句子由 Console 用 lingui 组装;全部读取经 createTenantDb,组织级实体再经 forOrg。

import { createTenantDb, schema } from '@xid-kit/db'
import { loadIdpVerifyKey, setSamlEngine } from '@xid-kit/saml'
import { AUTH_LOGIN_FAILED_EVENT, AUTH_LOGIN_SUCCEEDED_EVENT } from '@xid-kit/types'
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { Hono } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import { validateQuery } from '../lib/validate'
import { toIso } from './org-shared'
import { requireApiKeyOrOrgManager } from './shared'

type TenantDb = ReturnType<typeof createTenantDb>

const DAY_MS = 24 * 60 * 60 * 1000
const CERTIFICATE_WARNING_DAYS = 30
const CERTIFICATE_CRITICAL_DAYS = 14
const WEBHOOK_FAILURE_WINDOW_MS = DAY_MS
const EXPIRED_INVITATION_WINDOW_MS = 30 * DAY_MS
const MAX_ACTIVITY_DAYS = 28

export const ATTENTION_KINDS = [
  'sso_certificate_expiring',
  'webhook_failing',
  'domain_unverified',
  'invitation_expired',
] as const
export type AttentionKind = (typeof ATTENTION_KINDS)[number]
export type AttentionSeverity = 'critical' | 'warning' | 'notice'

export type AttentionItem = {
  kind: AttentionKind
  severity: AttentionSeverity
  targetId: string
  facts: Record<string, string | number | null>
}

const SEVERITY_RANK: Record<AttentionSeverity, number> = { critical: 0, warning: 1, notice: 2 }

export function sortAttention(items: readonly AttentionItem[]): AttentionItem[] {
  return [...items].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      ATTENTION_KINDS.indexOf(a.kind) - ATTENTION_KINDS.indexOf(b.kind),
  )
}

type CertificateExpiry = { connectionId: string; connectionName: string | null; notAfter: number }

// 每个连接取最晚到期的证书:同时登记新旧证书时,旧证书到期不影响登录。
async function latestCertificateExpiry(
  connection: typeof schema.ssoConnections.$inferSelect,
): Promise<CertificateExpiry | null> {
  let latest: number | null = null
  for (const certificate of connection.idpCertificates) {
    const parsed = await loadIdpVerifyKey(certificate)
    if (!parsed.ok) continue
    latest = latest === null ? parsed.value.notAfter : Math.max(latest, parsed.value.notAfter)
  }
  if (latest === null) return null
  return { connectionId: connection.id, connectionName: connection.displayName, notAfter: latest }
}

async function certificateFindings(
  db: TenantDb,
  orgId: string,
  now: number,
): Promise<{ items: AttentionItem[]; next: CertificateExpiry | null }> {
  const connections = await db
    .forOrg(orgId)
    .ssoConnections.findMany(
      and(eq(schema.ssoConnections.status, 'active'), eq(schema.ssoConnections.protocol, 'saml')),
      { orderBy: asc(schema.ssoConnections.id), limit: 10 },
    )
  if (connections.length === 0) return { items: [], next: null }
  setSamlEngine(globalThis.crypto)
  const expiries = (await Promise.all(connections.map(latestCertificateExpiry))).filter(
    (expiry): expiry is CertificateExpiry => expiry !== null,
  )
  const next = expiries.reduce<CertificateExpiry | null>(
    (soonest, expiry) =>
      soonest === null || expiry.notAfter < soonest.notAfter ? expiry : soonest,
    null,
  )
  const expiring = expiries.filter(
    (expiry) => expiry.notAfter - now <= CERTIFICATE_WARNING_DAYS * DAY_MS,
  )
  const items = await Promise.all(
    expiring.map(async (expiry): Promise<AttentionItem> => {
      const affectedUserCount = await db.userIdentities.countDistinct(
        schema.userIdentities.userId,
        and(
          eq(schema.userIdentities.provider, expiry.connectionId),
          isNull(schema.userIdentities.revokedAt),
        ),
      )
      return {
        kind: 'sso_certificate_expiring',
        severity:
          expiry.notAfter - now <= CERTIFICATE_CRITICAL_DAYS * DAY_MS ? 'critical' : 'warning',
        targetId: expiry.connectionId,
        facts: {
          connectionName: expiry.connectionName,
          notAfter: new Date(expiry.notAfter).toISOString(),
          affectedUserCount,
        },
      }
    }),
  )
  return { items, next }
}

// 失败投递:已放弃(dead),或仍在重试且至少失败过一次(attempt_count >= 2)。
function failingDeliveryFilter(since: Date): SQL | undefined {
  return and(
    gte(schema.webhookDeliveries.createdAt, since),
    or(
      eq(schema.webhookDeliveries.status, 'dead'),
      and(
        eq(schema.webhookDeliveries.status, 'pending'),
        gte(schema.webhookDeliveries.attemptCount, 2),
      ),
    ),
  )
}

// Webhook 属于租户顶层组织;子组织 Overview 不展示。
async function webhookFindings(db: TenantDb, now: number): Promise<AttentionItem[]> {
  const since = new Date(now - WEBHOOK_FAILURE_WINDOW_MS)
  const failing = failingDeliveryFilter(since)
  const counts = await db.webhookDeliveries.countBy(schema.webhookDeliveries.webhookId, failing)
  if (counts.size === 0) return []
  // 按失败数取前 20 个端点,inArray 绑定参数保持在 D1 单语句上限内。
  const webhookIds = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([id]) => id)
  const hooks = await db.webhooks.findMany(
    and(inArray(schema.webhooks.id, webhookIds), eq(schema.webhooks.status, 'active')),
    { limit: webhookIds.length },
  )
  return Promise.all(
    hooks.map(async (hook): Promise<AttentionItem> => {
      const forHook = and(failing, eq(schema.webhookDeliveries.webhookId, hook.id))
      const [first, latest, deadCount] = await Promise.all([
        db.webhookDeliveries.findMany(forHook, {
          orderBy: asc(schema.webhookDeliveries.createdAt),
          limit: 1,
        }),
        db.webhookDeliveries.findMany(forHook, {
          orderBy: desc(schema.webhookDeliveries.updatedAt),
          limit: 1,
        }),
        db.webhookDeliveries.count(and(forHook, eq(schema.webhookDeliveries.status, 'dead'))),
      ])
      return {
        kind: 'webhook_failing',
        severity: 'critical',
        targetId: hook.id,
        facts: {
          url: hook.url,
          failedCount: counts.get(hook.id) ?? 0,
          deadCount,
          since: toIso(first[0]?.createdAt),
          lastResponseStatus: latest[0]?.responseStatus ?? null,
        },
      }
    }),
  )
}

async function domainFindings(
  db: TenantDb,
  orgId: string,
  connectionName: string | null,
): Promise<AttentionItem[]> {
  const domains = await db
    .forOrg(orgId)
    .organizationDomains.findMany(
      and(
        ne(schema.organizationDomains.verificationStatus, 'verified'),
        eq(schema.organizationDomains.status, 'active'),
        isNull(schema.organizationDomains.deletedAt),
      ),
      { orderBy: asc(schema.organizationDomains.createdAt), limit: 20 },
    )
  return domains.map((domain) => ({
    kind: 'domain_unverified',
    severity: 'warning',
    targetId: domain.id,
    facts: {
      domain: domain.domain,
      addedAt: toIso(domain.createdAt),
      lastCheckedAt: toIso(domain.lastCheckedAt),
      ssoConnectionName: connectionName,
    },
  }))
}

// 过期邀请只提示近 30 天的,并合并成一条;重新发送或撤销后即离开列表。
async function invitationFindings(
  db: TenantDb,
  orgId: string,
  now: number,
): Promise<AttentionItem[]> {
  const nowDate = new Date(now)
  const expired = and(
    gte(schema.invitations.expiresAt, new Date(now - EXPIRED_INVITATION_WINDOW_MS)),
    or(
      eq(schema.invitations.status, 'expired'),
      and(eq(schema.invitations.status, 'pending'), lt(schema.invitations.expiresAt, nowDate)),
    ),
  )
  const orgDb = db.forOrg(orgId)
  const [count, latest] = await Promise.all([
    orgDb.invitations.count(expired),
    orgDb.invitations.findMany(expired, { orderBy: desc(schema.invitations.expiresAt), limit: 1 }),
  ])
  const newest = latest[0]
  if (count === 0 || !newest) return []
  return [
    {
      kind: 'invitation_expired',
      severity: 'notice',
      targetId: newest.id,
      facts: { count, email: newest.email, expiredAt: toIso(newest.expiresAt) },
    },
  ]
}

export async function buildOrgAttention(
  db: TenantDb,
  input: { orgId: string; isTopLevel: boolean; now: number },
): Promise<{
  items: AttentionItem[]
  checkedAt: string
  nextCertificateExpiry: { connectionName: string | null; notAfter: string } | null
}> {
  const certificates = await certificateFindings(db, input.orgId, input.now)
  const connectionName =
    certificates.next?.connectionName ??
    (
      await db
        .forOrg(input.orgId)
        .ssoConnections.findOne(eq(schema.ssoConnections.status, 'active'))
    )?.displayName ??
    null
  const [webhooks, domains, invitations] = await Promise.all([
    input.isTopLevel ? webhookFindings(db, input.now) : Promise.resolve([]),
    domainFindings(db, input.orgId, connectionName),
    invitationFindings(db, input.orgId, input.now),
  ])
  return {
    items: sortAttention([...certificates.items, ...webhooks, ...domains, ...invitations]),
    checkedAt: new Date(input.now).toISOString(),
    nextCertificateExpiry: certificates.next
      ? {
          connectionName: certificates.next.connectionName,
          notAfter: new Date(certificates.next.notAfter).toISOString(),
        }
      : null,
  }
}

type DayRange = { from: string; to: string }

function dayString(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function addDays(day: string, offset: number): string {
  return dayString(new Date(Date.parse(`${day}T00:00:00.000Z`) + offset * DAY_MS))
}

// 上一期是上个月的同一组日期;上个月没有的日期取当月最后一天。
export function shiftMonth(day: string, months: number): string {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number)
  const target = new Date(Date.UTC(year, month - 1 + months, 1))
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate()
  target.setUTCDate(Math.min(date, lastDay))
  return dayString(target)
}

export function activityPeriods(
  now: Date,
  days: number,
): { period: DayRange; previous: DayRange; days: string[] } {
  const to = dayString(now)
  const from = addDays(to, 1 - days)
  return {
    period: { from, to },
    previous: { from: shiftMonth(from, -1), to: shiftMonth(to, -1) },
    days: Array.from({ length: days }, (_, index) => addDays(from, index)),
  }
}

function dayStart(day: string): string {
  return `${day}T00:00:00.000Z`
}

function monthStart(day: string): string {
  return dayStart(`${day.slice(0, 7)}-01`)
}

export type ActivityMetric = {
  key: 'mau' | 'sign_in_succeeded' | 'sign_in_failed'
  value: number
  previousValue: number
  series: number[]
}

// 月活按登录成功事件的去重用户计;每个点是截至当天的当月月活。
export async function buildSignInActivity(
  db: TenantDb,
  input: { orgId: string; now: Date; days: number },
): Promise<{ period: DayRange; previous: DayRange; metrics: ActivityMetric[] }> {
  const { period, previous, days } = activityPeriods(input.now, input.days)
  const scope = or(eq(schema.auditEvents.orgId, input.orgId), isNull(schema.auditEvents.orgId))
  const succeeded = eq(schema.auditEvents.eventType, AUTH_LOGIN_SUCCEEDED_EVENT)
  const failed = eq(schema.auditEvents.eventType, AUTH_LOGIN_FAILED_EVENT)
  const between = (from: string, toExclusive: string): SQL | undefined =>
    and(gte(schema.auditEvents.occurredAt, from), lt(schema.auditEvents.occurredAt, toExclusive))
  const dayWindow = (day: string) => between(dayStart(day), dayStart(addDays(day, 1)))
  const monthToDate = (day: string) => between(monthStart(day), dayStart(addDays(day, 1)))
  const periodWindow = (range: DayRange) =>
    between(dayStart(range.from), dayStart(addDays(range.to, 1)))
  const distinctUsers = (window: SQL | undefined) =>
    db.auditEvents.countDistinct(schema.auditEvents.actorId, and(scope, succeeded, window))
  const countOf = (outcome: SQL, window: SQL | undefined) =>
    db.auditEvents.count(and(scope, outcome, window))

  const [mauSeries, successSeries, failureSeries, previousMau, previousSuccess, previousFailure] =
    await Promise.all([
      Promise.all(days.map((day) => distinctUsers(monthToDate(day)))),
      Promise.all(days.map((day) => countOf(succeeded, dayWindow(day)))),
      Promise.all(days.map((day) => countOf(failed, dayWindow(day)))),
      distinctUsers(monthToDate(previous.to)),
      countOf(succeeded, periodWindow(previous)),
      countOf(failed, periodWindow(previous)),
    ])
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)
  return {
    period,
    previous,
    metrics: [
      {
        key: 'mau',
        value: mauSeries[mauSeries.length - 1] ?? 0,
        previousValue: previousMau,
        series: mauSeries,
      },
      {
        key: 'sign_in_succeeded',
        value: sum(successSeries),
        previousValue: previousSuccess,
        series: successSeries,
      },
      {
        key: 'sign_in_failed',
        value: sum(failureSeries),
        previousValue: previousFailure,
        series: failureSeries,
      },
    ],
  }
}

export async function buildSetupProgress(
  db: TenantDb,
  orgId: string,
): Promise<{
  domainVerified: boolean
  signInDecided: boolean
  membersInvited: boolean
  pendingDomain: string | null
}> {
  const orgDb = db.forOrg(orgId)
  const liveDomain = and(
    eq(schema.organizationDomains.status, 'active'),
    isNull(schema.organizationDomains.deletedAt),
  )
  const [verifiedDomains, pending, connections, policy, invitations, members] = await Promise.all([
    orgDb.organizationDomains.count(
      and(liveDomain, eq(schema.organizationDomains.verificationStatus, 'verified')),
    ),
    orgDb.organizationDomains.findMany(liveDomain, {
      orderBy: asc(schema.organizationDomains.createdAt),
      limit: 1,
    }),
    orgDb.ssoConnections.count(eq(schema.ssoConnections.status, 'active')),
    orgDb.orgPolicies.findOne(),
    orgDb.invitations.count(),
    orgDb.memberships.count(eq(schema.memberships.status, 'active')),
  ])
  const pendingDomain = pending[0]
  return {
    domainVerified: verifiedDomains > 0,
    signInDecided: connections > 0 || policy?.mfaPolicy === 'required',
    membersInvited: invitations > 0 || members > 1,
    pendingDomain:
      pendingDomain && pendingDomain.verificationStatus !== 'verified'
        ? pendingDomain.domain
        : null,
  }
}

const activityQuerySchema = v.object({
  days: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^\d{1,2}$/),
      v.transform(Number),
      v.minValue(1),
      v.maxValue(MAX_ACTIVITY_DAYS),
    ),
  ),
})

export function registerOrgOverviewHandlers(app: Hono<XidHonoEnv>): void {
  // GET /v1/organizations/:id/attention
  app.get('/:id/attention', async (c) => {
    const id = c.req.param('id')
    await requireApiKeyOrOrgManager(c, id, 'organizations:read')
    const tenant = c.get('tenant')
    const db = createTenantDb(c.env.DB, tenant)
    return c.json(
      await buildOrgAttention(db, {
        orgId: id,
        isTopLevel: id === tenant.tenantId,
        now: Date.now(),
      }),
    )
  })

  // GET /v1/organizations/:id/sign-in-activity?days=7
  app.get('/:id/sign-in-activity', async (c) => {
    const id = c.req.param('id')
    await requireApiKeyOrOrgManager(c, id, 'organizations:read')
    const query = validateQuery(activityQuerySchema, c.req.query())
    const db = createTenantDb(c.env.DB, c.get('tenant'))
    return c.json(
      await buildSignInActivity(db, { orgId: id, now: new Date(), days: query.days ?? 7 }),
    )
  })

  // GET /v1/organizations/:id/setup-progress
  app.get('/:id/setup-progress', async (c) => {
    const id = c.req.param('id')
    await requireApiKeyOrOrgManager(c, id, 'organizations:read')
    const db = createTenantDb(c.env.DB, c.get('tenant'))
    return c.json(await buildSetupProgress(db, id))
  })
}
