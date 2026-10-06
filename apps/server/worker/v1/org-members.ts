// /v1/organizations/:id/stats 与 /members:Console 与 Management API 共用的成员只读视图。
// 成员写操作统一走 memberships.ts(owner 保护与条件更新只有一份实现)。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, gt, gte, inArray, isNull, or } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { paginationQuerySchema, validateQuery } from '../lib/validate'
import { ORG_LIST_BATCH_SIZE, readAllByIds, toIso } from './org-shared'
import { MAX_PAGE_SIZE, idAfterCursor, paginate, requireApiKeyOrOrgManager } from './shared'

const app = new Hono<XidHonoEnv>()
const ORG_STATS_MEMBER_BATCH_SIZE = 100
const LOGIN_SUCCESS_EVENTS = ['authentication.login_succeeded', 'user.signed_in'] as const
const LOGIN_FAILURE_EVENTS = ['authentication.login_failed', 'user.sign_in_failed'] as const
const LOGIN_STATS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

type OrgStats = {
  dau: number
  mau: number
  loginSuccessRate: number
  mfaAdoptionRate: number
  activeMemberCount: number
  pendingInvitationCount: number
}

type TenantDb = ReturnType<typeof createTenantDb>

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10)
}

function utcYearMonth(now: Date): string {
  return now.toISOString().slice(0, 7)
}

function ratio(numerator: number, denominator: number, fallback: number): number {
  return denominator === 0 ? fallback : numerator / denominator
}

async function listActiveMemberUserIds(db: TenantDb, orgId: string): Promise<string[]> {
  const orgDb = db.forOrg(orgId)
  const userIds: string[] = []
  let cursor: string | null = null
  while (true) {
    const after = cursor ? gt(schema.memberships.id, cursor) : undefined
    const rows = await orgDb.memberships.findMany(
      after
        ? and(eq(schema.memberships.status, 'active'), after)
        : eq(schema.memberships.status, 'active'),
      { orderBy: asc(schema.memberships.id), limit: ORG_STATS_MEMBER_BATCH_SIZE },
    )
    if (rows.length === 0) break
    userIds.push(...rows.map((row) => row.userId))
    cursor = rows[rows.length - 1]?.id ?? null
    if (rows.length < ORG_STATS_MEMBER_BATCH_SIZE) break
  }
  return [...new Set(userIds)]
}

async function countActiveMfaUsers(db: TenantDb, userIds: readonly string[]): Promise<number> {
  let count = 0
  for (let offset = 0; offset < userIds.length; offset += ORG_STATS_MEMBER_BATCH_SIZE) {
    const batch = userIds.slice(offset, offset + ORG_STATS_MEMBER_BATCH_SIZE)
    count += await db.mfaFactors.countDistinct(
      schema.mfaFactors.userId,
      and(eq(schema.mfaFactors.status, 'active'), inArray(schema.mfaFactors.userId, batch)),
    )
  }
  return count
}

async function buildOrgStats(c: Context<XidHonoEnv>, orgId: string): Promise<OrgStats> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const now = new Date()

  const [usageDay, usageMonth, memberUserIds, pendingInvitationCount] = await Promise.all([
    db.usageDaily.findOne(eq(schema.usageDaily.day, utcDay(now))),
    db.usageMonthly.findOne(eq(schema.usageMonthly.yearMonth, utcYearMonth(now))),
    listActiveMemberUserIds(db, orgId),
    db.forOrg(orgId).invitations.count(eq(schema.invitations.status, 'pending')),
  ])

  const orgAuditFilter = and(
    or(eq(schema.auditEvents.orgId, orgId), isNull(schema.auditEvents.orgId)),
    gte(
      schema.auditEvents.occurredAt,
      new Date(now.getTime() - LOGIN_STATS_WINDOW_MS).toISOString(),
    ),
  )
  const mfaUserCount = await countActiveMfaUsers(db, memberUserIds)
  const [loginSuccesses, loginFailures] = await Promise.all([
    db.auditEvents.count(
      and(orgAuditFilter, inArray(schema.auditEvents.eventType, [...LOGIN_SUCCESS_EVENTS])),
    ),
    db.auditEvents.count(
      and(orgAuditFilter, inArray(schema.auditEvents.eventType, [...LOGIN_FAILURE_EVENTS])),
    ),
  ])
  const totalLogins = loginSuccesses + loginFailures

  return {
    dau: Number(usageDay?.dau ?? 0),
    mau: Number(usageMonth?.mau ?? 0),
    loginSuccessRate: ratio(loginSuccesses, totalLogins, 1),
    mfaAdoptionRate: ratio(mfaUserCount, memberUserIds.length, 0),
    activeMemberCount: memberUserIds.length,
    pendingInvitationCount,
  }
}

async function toMemberViews(
  c: Context<XidHonoEnv>,
  rows: readonly (typeof schema.memberships.$inferSelect)[],
) {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  if (rows.length === 0) return []
  const userIds = [...new Set(rows.map((row) => row.userId))]
  const [users, emails] = await Promise.all([
    readAllByIds(userIds, (batch, cursor) =>
      db.users.findMany(
        and(inArray(schema.users.id, batch), ...(cursor ? [gt(schema.users.id, cursor)] : [])),
        { orderBy: asc(schema.users.id), limit: ORG_LIST_BATCH_SIZE },
      ),
    ),
    readAllByIds(userIds, (batch, cursor) =>
      db.userEmails.findMany(
        and(
          inArray(schema.userEmails.userId, batch),
          ...(cursor ? [gt(schema.userEmails.id, cursor)] : []),
        ),
        { orderBy: asc(schema.userEmails.id), limit: ORG_LIST_BATCH_SIZE },
      ),
    ),
  ])
  const userById = new Map(users.map((user) => [user.id, user]))
  const emailsByUser = new Map<string, (typeof schema.userEmails.$inferSelect)[]>()
  for (const email of emails) {
    emailsByUser.set(email.userId, [...(emailsByUser.get(email.userId) ?? []), email])
  }
  return rows.map((row) => {
    const user = userById.get(row.userId)
    const candidates = emailsByUser.get(row.userId) ?? []
    const email =
      candidates.find((candidate) => candidate.id === user?.primaryEmailId) ??
      candidates.find((candidate) => candidate.isPrimary) ??
      candidates[0]
    const parts = [user?.firstName, user?.lastName].filter((part): part is string => Boolean(part))
    return {
      id: row.id,
      userId: row.userId,
      email: email?.email ?? '',
      name: user?.displayName ?? (parts.length > 0 ? parts.join(' ') : null),
      role: row.role,
      status: row.status,
      joinedAt: toIso(row.joinedAt) ?? toIso(row.createdAt) ?? '',
    }
  })
}

// GET /v1/organizations/:id/stats
app.get('/:id/stats', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'organizations:read')
  return c.json(await buildOrgStats(c, id))
})

// GET /v1/organizations/:id/members
app.get('/:id/members', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'memberships:read')
  const orgDb = createTenantDb(c.env.DB, c.get('tenant')).forOrg(id)
  const query = validateQuery(paginationQuerySchema, c.req.query())
  const limit = query.limit ?? MAX_PAGE_SIZE
  const active = eq(schema.memberships.status, 'active')
  const afterCond = idAfterCursor(schema.memberships.id, query.cursor ?? null)
  const [total, rows] = await Promise.all([
    orgDb.memberships.count(active),
    orgDb.memberships.findMany(afterCond ? and(active, afterCond) : active, {
      orderBy: asc(schema.memberships.id),
      limit: limit + 1,
    }),
  ])
  const page = paginate(rows, (row) => row.id, limit)
  return c.json({ ...page, data: await toMemberViews(c, page.data), total })
})

export function registerOrgMembersRoutes(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/organizations', app)
}
