// /v1/organizations/:id/stats 与 /members:Console 与 Management API 共用的成员只读视图。
// 成员写操作统一走 memberships.ts(owner 保护与条件更新只有一份实现)。

import { createTenantDb, schema } from '@xid-kit/db'
import { ORGANIZATION_MEMBERSHIP_ROLES } from '@xid-kit/types'
import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { loginOutcomeFilters, loginSuccessRate } from '../lib/login-audit'
import type { XidHonoEnv } from '../lib/types'
import { paginationQuerySchema, validateQuery } from '../lib/validate'
import { ORG_LIST_BATCH_SIZE, readAllByIds, toIso } from './org-shared'
import { MAX_PAGE_SIZE, idAfterCursor, paginate, requireApiKeyOrOrgManager } from './shared'

const app = new Hono<XidHonoEnv>()
const ORG_STATS_MEMBER_BATCH_SIZE = 100

type OrgStats = {
  dau: number
  mau: number
  loginSuccessRate: number | null
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

  const login = loginOutcomeFilters(now)
  const orgAuditFilter = and(
    or(eq(schema.auditEvents.orgId, orgId), isNull(schema.auditEvents.orgId)),
    login.window,
  )
  const mfaUserCount = await countActiveMfaUsers(db, memberUserIds)
  const [loginSuccesses, loginFailures] = await Promise.all([
    db.auditEvents.count(and(orgAuditFilter, login.succeeded)),
    db.auditEvents.count(and(orgAuditFilter, login.failed)),
  ])

  return {
    dau: Number(usageDay?.dau ?? 0),
    mau: Number(usageMonth?.mau ?? 0),
    loginSuccessRate: loginSuccessRate(loginSuccesses, loginFailures),
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
  const inviterIds = [
    ...new Set(rows.map((row) => row.invitedByUserId).filter((id): id is string => Boolean(id))),
  ]
  const inviters =
    inviterIds.length === 0
      ? []
      : await db.users.findMany(inArray(schema.users.id, inviterIds), { limit: inviterIds.length })
  const userById = new Map([...users, ...inviters].map((user) => [user.id, user]))
  const emailsByUser = new Map<string, (typeof schema.userEmails.$inferSelect)[]>()
  for (const email of emails) {
    emailsByUser.set(email.userId, [...(emailsByUser.get(email.userId) ?? []), email])
  }
  const nameOf = (user: typeof schema.users.$inferSelect | undefined): string | null => {
    const parts = [user?.firstName, user?.lastName].filter((part): part is string => Boolean(part))
    return user?.displayName ?? (parts.length > 0 ? parts.join(' ') : null)
  }
  return rows.map((row) => {
    const user = userById.get(row.userId)
    const candidates = emailsByUser.get(row.userId) ?? []
    const email =
      candidates.find((candidate) => candidate.id === user?.primaryEmailId) ??
      candidates.find((candidate) => candidate.isPrimary) ??
      candidates[0]
    return {
      id: row.id,
      userId: row.userId,
      email: email?.email ?? '',
      name: nameOf(user),
      role: row.role,
      status: row.status,
      joinedAt: toIso(row.joinedAt) ?? toIso(row.createdAt) ?? '',
      lastSignInAt: toIso(user?.lastLoginAt),
      joinedThrough: row.isManaged
        ? 'directory_sync'
        : row.invitedByUserId
          ? 'invitation'
          : 'added',
      invitedByName: row.invitedByUserId
        ? (nameOf(userById.get(row.invitedByUserId)) ?? null)
        : null,
    }
  })
}

const membersQuerySchema = v.object({
  ...paginationQuerySchema.entries,
  role: v.optional(v.picklist(ORGANIZATION_MEMBERSHIP_ROLES)),
  search: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200))),
})

// 姓名或邮箱包含查询词;子查询按外层 memberships.tenant_id 关联,外层由 forOrg 注入租户与组织谓词。
function memberSearchFilter(search: string): SQL {
  const pattern = `%${search.replace(/[\\%_]/g, (match) => `\\${match}`)}%`
  return sql`EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = ${schema.memberships.tenantId}
      AND u.id = ${schema.memberships.userId}
      AND (u.first_name LIKE ${pattern} ESCAPE '\\' OR u.last_name LIKE ${pattern} ESCAPE '\\'
        OR u.display_name LIKE ${pattern} ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM user_emails ue WHERE ue.tenant_id = u.tenant_id
          AND ue.user_id = u.id AND ue.email LIKE ${pattern} ESCAPE '\\')))`
}

// GET /v1/organizations/:id/stats
app.get('/:id/stats', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'organizations:read')
  return c.json(await buildOrgStats(c, id))
})

// GET /v1/organizations/:id/members?role=&search=
app.get('/:id/members', async (c) => {
  const id = c.req.param('id')
  await requireApiKeyOrOrgManager(c, id, 'memberships:read')
  const orgDb = createTenantDb(c.env.DB, c.get('tenant')).forOrg(id)
  const query = validateQuery(membersQuerySchema, c.req.query())
  const limit = query.limit ?? MAX_PAGE_SIZE
  const active = eq(schema.memberships.status, 'active')
  const filters = [
    active,
    query.role ? eq(schema.memberships.role, query.role) : undefined,
    query.search ? memberSearchFilter(query.search) : undefined,
  ]
  const afterCond = idAfterCursor(schema.memberships.id, query.cursor ?? null)
  const [total, owners, admins, rows] = await Promise.all([
    orgDb.memberships.count(and(...filters)),
    orgDb.memberships.count(and(active, eq(schema.memberships.role, 'owner'))),
    orgDb.memberships.count(and(active, eq(schema.memberships.role, 'admin'))),
    orgDb.memberships.findMany(and(...filters, afterCond), {
      orderBy: asc(schema.memberships.id),
      limit: limit + 1,
    }),
  ])
  const page = paginate(rows, (row) => row.id, limit)
  return c.json({
    ...page,
    data: await toMemberViews(c, page.data),
    total,
    counts: { owner: owners, admin: admins },
  })
})

export function registerOrgMembersRoutes(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/organizations', app)
}
