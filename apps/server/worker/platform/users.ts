// GET /v1/platform/users:跨所有 organization 浏览与搜索用户(契约 Page<GlobalUser>,nextCursor + total)。
// q 为空时按最近登录倒序浏览全部;organizationId 收窄到一个顶层组织(租户),status 按公开状态过滤。
// 最近登录取该用户非模拟会话 last_active_at 的最大值。
// 跨 organization 走独立管理路径(requireInstanceManager + managementDb,见 shared.ts、tenant-isolation rule)。
// GDPR:每次跨租户用户访问都落平台审计(经 outbox + AUDIT_QUEUE,不阻塞响应)。

import { schema } from '@xid-kit/db'
import type {
  GlobalUser,
  GlobalUserOrganization,
  GlobalUserStatus,
  PlatformOrganizationStatus,
} from '@xid-kit/types'
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  like,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { logWorkerError } from '../lib/safe-log'
import type { XidHonoEnv } from '../lib/types'
import { validateQuery } from '../lib/validate'
import { recordPlatformAudit } from './audit-outbox'
import {
  decodeCursor,
  encodeCursor,
  managementDb,
  parsePlatformPagination,
  requireInstanceManager,
} from './shared'
import { displayNameOf, toGlobalUserStatus } from './user-display'

const app = new Hono<XidHonoEnv>()

type Db = ReturnType<typeof managementDb>

export type PlatformUserListItem = GlobalUser & {
  lastSignInAt: string | null
  tenantId: string
  organizationName: string | null
  organizationStatus: PlatformOrganizationStatus
}

const GLOBAL_USER_STATUSES = [
  'active',
  'inactive',
  'banned',
] as const satisfies readonly GlobalUserStatus[]

const listQuerySchema = v.object({
  q: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200))),
  organizationId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
  status: v.optional(v.picklist(GLOBAL_USER_STATUSES)),
})

// 非模拟会话的最近活跃时间(毫秒);没有会话为 0,倒序时排在最后。
const lastSignInExpr = sql<number>`coalesce((
  SELECT max(${schema.sessions.lastActiveAt})
    FROM ${schema.sessions}
   WHERE ${schema.sessions.tenantId} = ${schema.users.tenantId}
     AND ${schema.sessions.userId} = ${schema.users.id}
     AND ${schema.sessions.isImpersonation} = 0
), 0)`

export async function lastActiveAtByUser(
  db: Db,
  users: readonly { tenantId: string; userId: string }[],
): Promise<Map<string, number>> {
  if (users.length === 0) return new Map()
  const rows = await db
    .select({
      tenantId: schema.sessions.tenantId,
      userId: schema.sessions.userId,
      value: sql<number | null>`max(${schema.sessions.lastActiveAt})`,
    })
    .from(schema.sessions)
    .where(
      and(
        inArray(
          schema.sessions.userId,
          users.map((user) => user.userId),
        ),
        eq(schema.sessions.isImpersonation, false),
      ),
    )
    .groupBy(schema.sessions.tenantId, schema.sessions.userId)
  const wanted = new Set(users.map((user) => `${user.tenantId}:${user.userId}`))
  const result = new Map<string, number>()
  for (const row of rows) {
    const key = `${row.tenantId}:${row.userId}`
    if (wanted.has(key) && row.value !== null) result.set(key, Number(row.value))
  }
  return result
}

function searchFilter(q: string | undefined): SQL | undefined {
  if (!q) return undefined
  const pattern = `%${q}%`
  return or(
    like(schema.userEmails.email, pattern),
    like(schema.users.displayName, pattern),
    like(schema.users.firstName, pattern),
    like(schema.users.lastName, pattern),
    eq(schema.users.id, q),
    eq(schema.users.externalId, q),
    sql`exists (
      SELECT 1 FROM ${schema.userPhones}
       WHERE ${schema.userPhones.tenantId} = ${schema.users.tenantId}
         AND ${schema.userPhones.userId} = ${schema.users.id}
         AND ${schema.userPhones.phone} LIKE ${pattern}
    )`,
  )
}

function statusFilter(status: GlobalUserStatus | undefined): SQL | undefined {
  if (status === 'active') return eq(schema.users.status, 'active')
  if (status === 'banned') return eq(schema.users.status, 'banned')
  if (status === 'inactive') return notInArray(schema.users.status, ['active', 'banned'])
  return undefined
}

function cursorFilter(cursor: string | null): SQL | undefined {
  if (!cursor) return undefined
  const raw = decodeCursor(cursor)
  const separator = raw.indexOf(':')
  const ms = Number(raw.slice(0, separator))
  if (separator < 1 || !Number.isInteger(ms)) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'cursor' } })
  }
  const id = raw.slice(separator + 1)
  return or(lt(lastSignInExpr, ms), and(eq(lastSignInExpr, ms), sql`${schema.users.id} > ${id}`))
}

function andAll(filters: readonly (SQL | undefined)[]): SQL {
  return and(...filters.filter((f): f is SQL => f !== undefined)) as SQL
}

// GDPR 审计:跨 organization 用户访问落审计(actorId=Instance Manager userId,不阻塞响应)。
function auditGlobalUserAccess(
  c: Context<XidHonoEnv>,
  actorId: string,
  payload: Record<string, unknown>,
): void {
  c.executionCtx.waitUntil(
    recordPlatformAudit(c.env, {
      tenantId: 'platform',
      action: 'platform.users.searched',
      actorId,
      payload,
    }).catch((error) => {
      logWorkerError('platform.users.search_audit_failed', error, {
        component: 'platform-users',
      })
    }),
  )
}

async function loadActiveMembershipOrganizations(
  db: Db,
  users: { id: string; tenantId: string }[],
): Promise<Map<string, GlobalUserOrganization[]>> {
  if (users.length === 0) return new Map()

  const tenantIdByUserId = new Map(users.map((user) => [user.id, user.tenantId]))
  const rows = await db
    .select({
      userId: schema.memberships.userId,
      tenantId: schema.memberships.tenantId,
      id: schema.organizations.id,
      slug: schema.organizations.slug,
      name: schema.organizations.name,
    })
    .from(schema.memberships)
    .innerJoin(
      schema.organizations,
      and(
        eq(schema.organizations.id, schema.memberships.orgId),
        eq(schema.organizations.tenantId, schema.memberships.tenantId),
      ),
    )
    .where(
      and(
        inArray(
          schema.memberships.userId,
          users.map((user) => user.id),
        ),
        eq(schema.memberships.status, 'active'),
        eq(schema.organizations.status, 'active'),
        isNull(schema.organizations.deletedAt),
      ),
    )
    .orderBy(schema.memberships.userId, schema.organizations.name, schema.organizations.id)

  const organizationsByUserId = new Map<string, GlobalUserOrganization[]>()
  for (const row of rows) {
    // 跨租户搜索:暴露模拟目标前须与 Membership->Org join 的 tenant 绑定一致。
    if (tenantIdByUserId.get(row.userId) !== row.tenantId) continue
    const organizations = organizationsByUserId.get(row.userId) ?? []
    organizations.push({ id: row.id, slug: row.slug, name: row.name })
    organizationsByUserId.set(row.userId, organizations)
  }
  return organizationsByUserId
}

function toOrganizationStatus(status: string | null): PlatformOrganizationStatus {
  if (status === 'suspended') return 'suspended'
  if (status === 'deleted') return 'deleted'
  return 'active'
}

const primaryEmailJoin = and(
  eq(schema.userEmails.tenantId, schema.users.tenantId),
  eq(schema.userEmails.userId, schema.users.id),
  eq(schema.userEmails.isPrimary, true),
)

const tenantOrganizationJoin = and(
  eq(schema.organizations.id, schema.users.tenantId),
  isNull(schema.organizations.parentOrgId),
)

app.get('/', async (c) => {
  const session = await requireInstanceManager(c)
  const db = managementDb(c.env)
  const { limit, cursor } = parsePlatformPagination(c, 20)
  const query = validateQuery(listQuerySchema, c.req.query())
  auditGlobalUserAccess(c, session.userId, {
    query: query.q ?? '',
    organizationId: query.organizationId ?? null,
    status: query.status ?? null,
  })

  const filters = [
    ne(schema.users.status, 'deleted'),
    isNull(schema.users.deletedAt),
    searchFilter(query.q),
    query.organizationId ? eq(schema.users.tenantId, query.organizationId) : undefined,
    statusFilter(query.status),
  ]
  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        id: schema.users.id,
        tenantId: schema.users.tenantId,
        displayName: schema.users.displayName,
        firstName: schema.users.firstName,
        lastName: schema.users.lastName,
        status: schema.users.status,
        createdAt: schema.users.createdAt,
        email: schema.userEmails.email,
        organizationName: schema.organizations.name,
        organizationStatus: schema.organizations.status,
        lastSignIn: lastSignInExpr,
      })
      .from(schema.users)
      .leftJoin(schema.userEmails, primaryEmailJoin)
      .leftJoin(schema.organizations, tenantOrganizationJoin)
      .where(andAll([...filters, cursorFilter(cursor)]))
      .orderBy(desc(lastSignInExpr), asc(schema.users.id))
      .limit(limit + 1),
    db
      .select({ value: count() })
      .from(schema.users)
      .leftJoin(schema.userEmails, primaryEmailJoin)
      .where(andAll(filters)),
  ])

  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const last = pageRows.at(-1)
  const nextCursor = hasMore && last ? encodeCursor(`${Number(last.lastSignIn)}:${last.id}`) : null
  const organizationsByUserId = await loadActiveMembershipOrganizations(db, pageRows)

  const data: PlatformUserListItem[] = pageRows.map((row) => ({
    id: row.id,
    email: row.email ?? '',
    name: displayNameOf(row),
    organizations: organizationsByUserId.get(row.id) ?? [],
    status: toGlobalUserStatus(row.status),
    createdAt: row.createdAt.toISOString(),
    lastSignInAt:
      Number(row.lastSignIn) > 0 ? new Date(Number(row.lastSignIn)).toISOString() : null,
    tenantId: row.tenantId,
    organizationName: row.organizationName ?? null,
    organizationStatus: toOrganizationStatus(row.organizationStatus),
  }))

  return c.json({ data, nextCursor, total: totalRow?.value ?? 0 })
})

export function registerPlatformUsersRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/platform/users', app)
}
