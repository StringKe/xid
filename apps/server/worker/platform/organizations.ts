// GET /v1/platform/organizations:跨所有顶层 organization 列表(契约 Page<OrganizationItem>,nextCursor + total)。
// 顶层 organization(parent_org_id IS NULL,tenant_id = 自身 id)。userCount/orgCount 按 tenant_id 聚合。
// 跨租户走独立管理路径(requireInstanceManager + managementDb,见 shared.ts、tenant-isolation rule)。
// q 按 name 或 slug 模糊搜(空 q 前端不发该 param);limit 默认 20(前端固定 20)。
// plan 列在 organizations 无对应字段 -> 默认 'free'(契约 plan 必填,deterministic 回退,不臆造)。

import { schema } from '@xid-kit/db'
import { and, count, eq, gt, inArray, isNull, like, ne, or } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import { AppError } from '../lib/errors'
import { readJsonBody, validateBody } from '../lib/validate'
import {
  decodeCursor,
  encodeCursor,
  managementDb,
  parsePlatformPagination,
  requireInstanceManager,
} from './shared'

const app = new Hono<XidHonoEnv>()

const ORGANIZATION_PLANS = ['free', 'pro', 'enterprise'] as const
type OrganizationPlan = (typeof ORGANIZATION_PLANS)[number]

const ORGANIZATION_STATUSES = ['active', 'suspended', 'deleted'] as const
type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number]
const DEFAULT_ORGANIZATION_SLUG = 'default'

const patchOrganizationBodySchema = v.object({
  status: v.picklist(ORGANIZATION_STATUSES),
})

type OrganizationItem = {
  id: string
  slug: string
  name: string
  plan: OrganizationPlan
  status: OrganizationStatus
  userCount: number
  orgCount: number
  createdAt: string
}

function toOrganizationItem(
  row: typeof schema.organizations.$inferSelect,
  users: Map<string, number>,
  orgs: Map<string, number>,
): OrganizationItem {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    plan: 'free',
    status: toOrganizationStatus(row.status),
    userCount: users.get(row.id) ?? 0,
    orgCount: orgs.get(row.id) ?? 0,
    createdAt: row.createdAt.toISOString(),
  }
}

// org 行 status -> 契约 OrganizationStatus(未知值模糊回退 active,不泄露内部状态名)。
function toOrganizationStatus(status: string): OrganizationStatus {
  if (status === 'suspended') return 'suspended'
  if (status === 'deleted') return 'deleted'
  return 'active'
}

function assertMutableOrganizationStatus(
  row: typeof schema.organizations.$inferSelect,
  status: OrganizationStatus,
): void {
  if (row.slug === DEFAULT_ORGANIZATION_SLUG && status !== 'active') {
    throw new AppError('conflict', {
      longMessage: 'Default organization cannot be suspended or deleted.',
    })
  }
}

// 顶层 organization 搜索谓词 + cursor 组合。
function buildWhere(q: string | null, cursor: string | null): SQL {
  const filters: (SQL | undefined)[] = [isNull(schema.organizations.parentOrgId)]
  if (q) {
    const pattern = `%${q}%`
    filters.push(
      or(like(schema.organizations.name, pattern), like(schema.organizations.slug, pattern)),
    )
  }
  if (cursor) filters.push(gt(schema.organizations.id, decodeCursor(cursor)))
  return and(...filters.filter((f): f is SQL => f !== undefined)) as SQL
}

// 按当前页面的 tenant_id 聚合 users / organizations 计数,避免每次扫描全租户表。
async function countsByTenant(
  db: ReturnType<typeof managementDb>,
  tenantIds: readonly string[],
): Promise<{ users: Map<string, number>; orgs: Map<string, number> }> {
  if (tenantIds.length === 0) return { users: new Map(), orgs: new Map() }
  const [userRows, orgRows] = await Promise.all([
    db
      .select({ tenantId: schema.users.tenantId, value: count() })
      .from(schema.users)
      .where(
        and(
          inArray(schema.users.tenantId, tenantIds),
          ne(schema.users.status, 'deleted'),
          isNull(schema.users.deletedAt),
        ),
      )
      .groupBy(schema.users.tenantId),
    db
      .select({ tenantId: schema.organizations.tenantId, value: count() })
      .from(schema.organizations)
      .where(inArray(schema.organizations.tenantId, tenantIds))
      .groupBy(schema.organizations.tenantId),
  ])
  return {
    users: new Map(userRows.map((r) => [r.tenantId, r.value])),
    orgs: new Map(orgRows.map((r) => [r.tenantId, r.value])),
  }
}

app.get('/', async (c) => {
  await requireInstanceManager(c)
  const db = managementDb(c.env)
  const { limit, cursor } = parsePlatformPagination(c, 20)
  const q = c.req.query('q') ?? null

  const where = buildWhere(q, cursor)
  // 多取 1 条判是否有下一页。
  const rows = await db
    .select()
    .from(schema.organizations)
    .where(where)
    .orderBy(schema.organizations.id)
    .limit(limit + 1)

  // total:匹配的顶层 organization 总数(不含 cursor 过滤)。
  const totalWhere = q ? buildWhere(q, null) : isNull(schema.organizations.parentOrgId)
  const [totalRow] = await db
    .select({ value: count() })
    .from(schema.organizations)
    .where(totalWhere)

  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const last = pageRows[pageRows.length - 1]
  const nextCursor = hasMore && last !== undefined ? encodeCursor(last.id) : null

  const { users, orgs } = await countsByTenant(
    db,
    pageRows.map((row) => row.id),
  )
  const data: OrganizationItem[] = pageRows.map((row) => toOrganizationItem(row, users, orgs))

  return c.json({ data, nextCursor, total: totalRow?.value ?? 0 })
})

app.patch('/:organizationId', async (c) => {
  await requireInstanceManager(c)
  const db = managementDb(c.env)
  const organizationId = c.req.param('organizationId')
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(patchOrganizationBodySchema, json.value)

  const [existing] = await db
    .select()
    .from(schema.organizations)
    .where(
      and(eq(schema.organizations.id, organizationId), isNull(schema.organizations.parentOrgId)),
    )
    .limit(1)
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })

  const status = body.status
  assertMutableOrganizationStatus(existing, status)
  const [updated] = await db
    .update(schema.organizations)
    .set({ status, deletedAt: status === 'deleted' ? new Date() : null })
    .where(eq(schema.organizations.id, organizationId))
    .returning()
  if (!updated) throw new AppError('not_found', { httpStatus: 404 })

  const { users, orgs } = await countsByTenant(db, [updated.tenantId])
  return c.json(toOrganizationItem(updated, users, orgs))
})

export function registerPlatformOrganizationsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/platform/organizations', app)
}
