// GET /v1/platform/users:跨所有 organization 用户搜索(契约 Page<GlobalUser>,nextCursor + total)。
// q 必填(前端 enabled:Boolean(query) 空 q 不发请求,端点假定 q 非空;空则返回空页)。
// 跨 organization 走独立管理路径(requireInstanceManager + managementDb,见 shared.ts、tenant-isolation rule)。
// GDPR:跨租户访问用户须审计落库(前端文案明示),经 AUDIT_QUEUE 异步写不阻塞响应(见 cloudflare-bindings 审计链)。
// email 取 primary user_emails;name 取 display_name 回退 first+last;organizations 取 active Membership。

import { schema } from '@xid-kit/db'
import { and, count, eq, gt, inArray, isNull, like, ne, or } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import { logWorkerError } from '../lib/safe-log'
import { recordPlatformAudit } from './audit-outbox'
import {
  decodeCursor,
  encodeCursor,
  managementDb,
  parsePlatformPagination,
  requireInstanceManager,
} from './shared'

const app = new Hono<XidHonoEnv>()

const USER_STATUSES = ['active', 'inactive', 'banned'] as const
type UserStatus = (typeof USER_STATUSES)[number]

type GlobalUserOrganization = {
  id: string
  slug: string
  name: string
}

type GlobalUser = {
  id: string
  email: string
  name: string | null
  organizations: GlobalUserOrganization[]
  status: UserStatus
  createdAt: string
}

// users.status(active/banned/deleted/inactive/...) -> 公开契约(active|inactive|banned)。
// banned 显式;active 显式;其余(deleted/pending/...)模糊归 inactive,不泄露内部状态名。
function toUserStatus(status: string): UserStatus {
  if (status === 'banned') return 'banned'
  if (status === 'active') return 'active'
  return 'inactive'
}

function displayNameOf(row: {
  displayName: string | null
  firstName: string | null
  lastName: string | null
}): string | null {
  if (row.displayName) return row.displayName
  const joined = [row.firstName, row.lastName].filter(Boolean).join(' ').trim()
  return joined.length > 0 ? joined : null
}

// 搜索谓词:email(primary user_emails)或 name(display/first/last)模糊;+ cursor。
function buildWhere(q: string, cursor: string | null): SQL {
  const pattern = `%${q}%`
  const filters: (SQL | undefined)[] = [
    or(
      like(schema.userEmails.email, pattern),
      like(schema.users.displayName, pattern),
      like(schema.users.firstName, pattern),
      like(schema.users.lastName, pattern),
    ),
    ne(schema.users.status, 'deleted'),
    isNull(schema.users.deletedAt),
  ]
  if (cursor) filters.push(gt(schema.users.id, decodeCursor(cursor)))
  return and(...filters.filter((f): f is SQL => f !== undefined)) as SQL
}

// GDPR 审计:跨 organization 用户访问落审计队列(actorId=Instance Manager userId,不阻塞响应)。
function auditGlobalUserAccess(c: Context<XidHonoEnv>, actorId: string, q: string): void {
  c.executionCtx.waitUntil(
    recordPlatformAudit(c.env, {
      tenantId: 'platform',
      action: 'platform.users.searched',
      actorId,
      payload: { query: q },
    }).catch((error) => {
      logWorkerError('platform.users.search_audit_failed', error, {
        component: 'platform-users',
      })
    }),
  )
}

async function loadActiveMembershipOrganizations(
  db: ReturnType<typeof managementDb>,
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

app.get('/', async (c) => {
  const session = await requireInstanceManager(c)
  const db = managementDb(c.env)
  const { limit, cursor } = parsePlatformPagination(c, 20)
  const q = c.req.query('q') ?? ''

  if (!q) return c.json({ data: [], nextCursor: null, total: 0 })

  auditGlobalUserAccess(c, session.userId, q)

  const where = buildWhere(q, cursor)
  const rows = await db
    .select({
      id: schema.users.id,
      tenantId: schema.users.tenantId,
      displayName: schema.users.displayName,
      firstName: schema.users.firstName,
      lastName: schema.users.lastName,
      status: schema.users.status,
      createdAt: schema.users.createdAt,
      email: schema.userEmails.email,
    })
    .from(schema.users)
    .leftJoin(
      schema.userEmails,
      and(eq(schema.userEmails.userId, schema.users.id), eq(schema.userEmails.isPrimary, true)),
    )
    .where(where)
    .orderBy(schema.users.id)
    .limit(limit + 1)

  const totalWhere = buildWhere(q, null)
  const [totalRow] = await db
    .select({ value: count() })
    .from(schema.users)
    .leftJoin(
      schema.userEmails,
      and(eq(schema.userEmails.userId, schema.users.id), eq(schema.userEmails.isPrimary, true)),
    )
    .where(totalWhere)

  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const last = pageRows[pageRows.length - 1]
  const nextCursor = hasMore && last !== undefined ? encodeCursor(last.id) : null
  const organizationsByUserId = await loadActiveMembershipOrganizations(db, pageRows)

  const data: GlobalUser[] = pageRows.map((row) => ({
    id: row.id,
    email: row.email ?? '',
    name: displayNameOf(row),
    organizations: organizationsByUserId.get(row.id) ?? [],
    status: toUserStatus(row.status),
    createdAt: row.createdAt.toISOString(),
  }))

  return c.json({ data, nextCursor, total: totalRow?.value ?? 0 })
})

export function registerPlatformUsersRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/platform/users', app)
}
