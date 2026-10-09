// /v1/platform/organizations:跨所有顶层 organization 的列表、详情、只读成员与域名、创建和状态变更。
// 顶层 organization(parent_org_id IS NULL,tenant_id = 自身 id);计数按 tenant_id 聚合。
// 跨租户走独立管理路径(requireInstanceManager + managementDb,见 shared.ts、tenant-isolation rule)。
// status 没有变更时间列:deleted 取 deleted_at,其他取平台审计 outbox 里最近一次状态变更的写入时间。

import { schema } from '@xid-kit/db'
import { DEFAULT_HOSTED_AUTH_POLICY } from '@xid-kit/types'
import type { PlatformOrganization, PlatformOrganizationStatus } from '@xid-kit/types'
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  like,
  lt,
  max,
  ne,
  or,
  sql,
} from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { isUniqueConstraintError } from '../lib/d1-errors'
import { AppError } from '../lib/errors'
import { resolveLocale } from '../lib/locale'
import { createPersistedId } from '../lib/persisted-id'
import { INVITATION_TTL_DAYS } from '../lib/ttl'
import type { XidHonoEnv } from '../lib/types'
import { emailSchema, readJsonBody, slugSchema, validateBody, validateQuery } from '../lib/validate'
import { enqueuePersistedEmailNotification } from '../queues/notification-delivery-state'
import { prepareInvitation } from '../v1/invitations'
import {
  enqueuePersistedPlatformAudit,
  prepareConditionalPlatformAuditOutboxInsert,
  preparePlatformAuditOutboxInsert,
} from './audit-outbox'
import {
  decodeCursor,
  encodeCursor,
  managementDb,
  parsePlatformPagination,
  requireInstanceManager,
} from './shared'
import { displayNameOf } from './user-display'

const app = new Hono<XidHonoEnv>()

type Db = ReturnType<typeof managementDb>
type OrganizationRow = typeof schema.organizations.$inferSelect

const ORGANIZATION_STATUSES = [
  'active',
  'suspended',
  'deleted',
] as const satisfies readonly PlatformOrganizationStatus[]
const DEFAULT_ORGANIZATION_SLUG = 'default'
const STATUS_CHANGED_ACTION = 'platform.tenant_status_changed'
const CREATED_ACTION = 'platform.organization.created'

export type PlatformOrganizationListItem = PlatformOrganization & {
  primaryHost: string | null
  mauThisMonth: number
  mauQuota: number | null
  statusChangedAt: string | null
}

const listQuerySchema = v.object({
  q: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200))),
  status: v.optional(v.picklist(ORGANIZATION_STATUSES)),
  sort: v.optional(v.picklist(['mau_desc'])),
})

const patchOrganizationBodySchema = v.object({
  status: v.picklist(ORGANIZATION_STATUSES),
  confirmSlug: v.optional(v.string()),
})

const createOrganizationBodySchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
  slug: slugSchema,
  ownerEmail: emailSchema,
})

function utcYearMonth(now: Date): string {
  return now.toISOString().slice(0, 7)
}

// org 行 status -> 契约 PlatformOrganizationStatus(未知值回退 active,不泄露内部状态名)。
function toOrganizationStatus(status: string): PlatformOrganizationStatus {
  if (status === 'suspended') return 'suspended'
  if (status === 'deleted') return 'deleted'
  return 'active'
}

function assertMutableOrganizationStatus(
  row: OrganizationRow,
  status: PlatformOrganizationStatus,
): void {
  if (row.slug === DEFAULT_ORGANIZATION_SLUG && status !== 'active') {
    throw new AppError('conflict', {
      longMessage: 'Default organization cannot be suspended or deleted.',
    })
  }
}

function searchFilter(q: string | undefined): SQL | undefined {
  if (!q) return undefined
  const pattern = `%${q}%`
  return or(
    like(schema.organizations.name, pattern),
    like(schema.organizations.slug, pattern),
    eq(schema.organizations.id, q),
  )
}

const mauExpr = sql<number>`coalesce(${schema.usageMonthly.mau}, 0)`

type ListCursor = { id: string; mau: number | null }

function parseListCursor(cursor: string | null, byMau: boolean): ListCursor | null {
  if (!cursor) return null
  const raw = decodeCursor(cursor)
  if (!byMau) return { id: raw, mau: null }
  const separator = raw.indexOf(':')
  const mau = Number(raw.slice(0, separator))
  if (separator < 1 || !Number.isInteger(mau)) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'cursor' } })
  }
  return { id: raw.slice(separator + 1), mau }
}

function cursorFilter(cursor: ListCursor | null): SQL | undefined {
  if (!cursor) return undefined
  if (cursor.mau === null) return gt(schema.organizations.id, cursor.id)
  return or(
    lt(mauExpr, cursor.mau),
    and(eq(mauExpr, cursor.mau), gt(schema.organizations.id, cursor.id)),
  )
}

function andAll(filters: readonly (SQL | undefined)[]): SQL {
  return and(...filters.filter((f): f is SQL => f !== undefined)) as SQL
}

// 当前页 tenant 的 users / organizations / 当月 MAU / MAU 配额 / 状态变更时间 / 主机名,一次分组查询一类。
type PageFacts = {
  users: Map<string, number>
  orgs: Map<string, number>
  mau: Map<string, number>
  mauQuota: Map<string, number | null>
  statusChangedAt: Map<string, number>
  hosts: Map<string, { primaryDomain: string; mode: string }>
}

async function countsByTenant(
  db: Db,
  tenantIds: readonly string[],
): Promise<Pick<PageFacts, 'users' | 'orgs'>> {
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

async function usageFactsByTenant(
  db: Db,
  tenantIds: readonly string[],
): Promise<Pick<PageFacts, 'mau' | 'mauQuota' | 'statusChangedAt'>> {
  const [mauRows, quotaRows, changeRows] = await Promise.all([
    db
      .select({ tenantId: schema.usageMonthly.tenantId, value: schema.usageMonthly.mau })
      .from(schema.usageMonthly)
      .where(
        and(
          eq(schema.usageMonthly.yearMonth, utcYearMonth(new Date())),
          inArray(schema.usageMonthly.tenantId, tenantIds),
        ),
      ),
    db
      .select({
        tenantId: schema.organizationQuotas.tenantId,
        value: schema.organizationQuotas.limit,
      })
      .from(schema.organizationQuotas)
      .where(
        and(
          eq(schema.organizationQuotas.quotaKey, 'mau'),
          inArray(schema.organizationQuotas.tenantId, tenantIds),
        ),
      ),
    db
      .select({
        tenantId: schema.platformAuditOutbox.tenantId,
        value: max(schema.platformAuditOutbox.createdAt),
      })
      .from(schema.platformAuditOutbox)
      .where(
        and(
          eq(schema.platformAuditOutbox.action, STATUS_CHANGED_ACTION),
          inArray(schema.platformAuditOutbox.tenantId, tenantIds),
        ),
      )
      .groupBy(schema.platformAuditOutbox.tenantId),
  ])
  return {
    mau: new Map(mauRows.map((r) => [r.tenantId, r.value])),
    mauQuota: new Map(quotaRows.map((r) => [r.tenantId, r.value ?? null])),
    statusChangedAt: new Map(
      changeRows.flatMap((r) => (r.value === null ? [] : [[r.tenantId, toMs(r.value)] as const])),
    ),
  }
}

function toMs(value: Date | number | string): number {
  if (value instanceof Date) return value.getTime()
  return typeof value === 'number' ? value : Number(value)
}

async function hostsByInstance(
  db: Db,
  instanceIds: readonly string[],
): Promise<PageFacts['hosts']> {
  if (instanceIds.length === 0) return new Map()
  const rows = await db
    .select({
      id: schema.instances.id,
      primaryDomain: schema.instances.primaryDomain,
      mode: schema.instances.mode,
    })
    .from(schema.instances)
    .where(inArray(schema.instances.id, [...new Set(instanceIds)]))
  return new Map(rows.map((r) => [r.id, { primaryDomain: r.primaryDomain, mode: r.mode }]))
}

async function loadPageFacts(db: Db, rows: readonly OrganizationRow[]): Promise<PageFacts> {
  const tenantIds = rows.map((row) => row.id)
  if (tenantIds.length === 0) {
    return {
      users: new Map(),
      orgs: new Map(),
      mau: new Map(),
      mauQuota: new Map(),
      statusChangedAt: new Map(),
      hosts: new Map(),
    }
  }
  const [counts, usage, hosts] = await Promise.all([
    countsByTenant(db, tenantIds),
    usageFactsByTenant(db, tenantIds),
    hostsByInstance(
      db,
      rows.map((row) => row.instanceId),
    ),
  ])
  return { ...counts, ...usage, hosts }
}

function primaryHostOf(row: OrganizationRow, facts: PageFacts): string | null {
  const host = facts.hosts.get(row.instanceId)
  if (!host) return null
  return host.mode === 'single_tenant' ? host.primaryDomain : `${row.slug}.${host.primaryDomain}`
}

function statusChangedAtOf(row: OrganizationRow, facts: PageFacts): string | null {
  if (row.status === 'deleted' && row.deletedAt) return row.deletedAt.toISOString()
  const changed = facts.statusChangedAt.get(row.id)
  return changed === undefined ? null : new Date(changed).toISOString()
}

function toListItem(row: OrganizationRow, facts: PageFacts): PlatformOrganizationListItem {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: toOrganizationStatus(row.status),
    userCount: facts.users.get(row.id) ?? 0,
    orgCount: facts.orgs.get(row.id) ?? 0,
    createdAt: row.createdAt.toISOString(),
    canChangeStatus: row.slug !== DEFAULT_ORGANIZATION_SLUG,
    primaryHost: primaryHostOf(row, facts),
    mauThisMonth: facts.mau.get(row.id) ?? 0,
    mauQuota: facts.mauQuota.get(row.id) ?? null,
    statusChangedAt: statusChangedAtOf(row, facts),
  }
}

async function listCounts(
  db: Db,
  q: string | undefined,
): Promise<{ total: number; suspended: number; deleted: number }> {
  const rows = await db
    .select({ status: schema.organizations.status, value: count() })
    .from(schema.organizations)
    .where(andAll([isNull(schema.organizations.parentOrgId), searchFilter(q)]))
    .groupBy(schema.organizations.status)
  const byStatus = new Map<PlatformOrganizationStatus, number>()
  for (const row of rows) {
    const status = toOrganizationStatus(row.status)
    byStatus.set(status, (byStatus.get(status) ?? 0) + row.value)
  }
  return {
    total: rows.reduce((sum, row) => sum + row.value, 0),
    suspended: byStatus.get('suspended') ?? 0,
    deleted: byStatus.get('deleted') ?? 0,
  }
}

app.get('/', async (c) => {
  await requireInstanceManager(c)
  const db = managementDb(c.env)
  const { limit, cursor } = parsePlatformPagination(c, 20)
  const query = validateQuery(listQuerySchema, c.req.query())
  const byMau = query.sort === 'mau_desc'
  const filters = [
    isNull(schema.organizations.parentOrgId),
    searchFilter(query.q),
    query.status ? eq(schema.organizations.status, query.status) : undefined,
  ]
  const rows = await db
    .select({ organization: schema.organizations, mau: mauExpr })
    .from(schema.organizations)
    .leftJoin(
      schema.usageMonthly,
      and(
        eq(schema.usageMonthly.tenantId, schema.organizations.id),
        eq(schema.usageMonthly.yearMonth, utcYearMonth(new Date())),
      ),
    )
    .where(andAll([...filters, cursorFilter(parseListCursor(cursor, byMau))]))
    .orderBy(
      ...(byMau ? [desc(mauExpr), asc(schema.organizations.id)] : [asc(schema.organizations.id)]),
    )
    .limit(limit + 1)

  const [totalRow] = await db
    .select({ value: count() })
    .from(schema.organizations)
    .where(andAll(filters))

  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const last = pageRows.at(-1)
  const nextCursor =
    hasMore && last
      ? encodeCursor(byMau ? `${last.mau}:${last.organization.id}` : last.organization.id)
      : null
  const organizations = pageRows.map((row) => row.organization)
  const [facts, counts] = await Promise.all([
    loadPageFacts(db, organizations),
    listCounts(db, query.q),
  ])
  return c.json({
    data: organizations.map((row) => toListItem(row, facts)),
    nextCursor,
    total: totalRow?.value ?? 0,
    counts,
  })
})

async function findTopLevelOrganization(db: Db, organizationId: string): Promise<OrganizationRow> {
  const [row] = await db
    .select()
    .from(schema.organizations)
    .where(
      and(
        eq(schema.organizations.id, organizationId),
        eq(schema.organizations.tenantId, organizationId),
        isNull(schema.organizations.parentOrgId),
      ),
    )
    .limit(1)
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  return row
}

app.post('/', async (c) => {
  const session = await requireInstanceManager(c)
  const tenant = c.get('tenant')
  const instanceId = tenant.instanceId
  if (!instanceId) throw new AppError('server_error')
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createOrganizationBodySchema, json.value)
  const db = managementDb(c.env)
  const [taken] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(
      and(
        eq(schema.organizations.instanceId, instanceId),
        eq(schema.organizations.slug, body.slug),
      ),
    )
    .limit(1)
  if (taken) throw new AppError('conflict', { httpStatus: 409, meta: { paramName: 'slug' } })

  const organizationId = createPersistedId('organization')
  const now = Date.now()
  const invitation = await prepareInvitation(c.env, {
    tenantId: organizationId,
    orgId: organizationId,
    orgName: body.name,
    email: body.ownerEmail,
    role: 'owner',
    invitedByUserId: null,
    expiresInDays: INVITATION_TTL_DAYS,
    authOrigin: tenant.issuer,
    locale: resolveLocale({ userLocale: null }),
  })
  const audit = preparePlatformAuditOutboxInsert(
    c.env,
    {
      tenantId: organizationId,
      orgId: organizationId,
      action: CREATED_ACTION,
      actorId: session.userId,
      payload: {
        targetType: 'organization',
        targetId: organizationId,
        slug: body.slug,
        invitationId: invitation.invitation.id,
      },
    },
    now,
  )
  try {
    await c.env.DB.batch([
      createOrganizationStatement(c.env, { id: organizationId, instanceId, ...body, now }),
      ...invitation.statements,
      audit.statement,
    ])
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new AppError('conflict', { httpStatus: 409, meta: { paramName: 'slug' }, cause: error })
    }
    throw error
  }
  await Promise.all([
    enqueuePersistedEmailNotification(c.env, invitation.delivery),
    enqueuePersistedPlatformAudit(c.env, audit),
  ])
  const created = await findTopLevelOrganization(db, organizationId)
  return c.json(toListItem(created, await loadPageFacts(db, [created])), 201)
})

// 与 bootstrap 的顶层组织同形:tenant_id = 自身 id,邀请制加入,带默认 Hosted Auth 策略。
function createOrganizationStatement(
  env: Env,
  input: { id: string; instanceId: string; slug: string; name: string; now: number },
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO organizations (
       id, tenant_id, instance_id, parent_org_id, slug, name,
       public_metadata, private_metadata, seat_limit, seat_used,
       enrollment_mode, allow_org_self_service, status, created_at, updated_at
     ) VALUES (?, ?, ?, NULL, ?, ?, '{}', ?, NULL, 0, 'invite_required', 1, 'active', ?, ?)`,
  ).bind(
    input.id,
    input.id,
    input.instanceId,
    input.slug,
    input.name,
    JSON.stringify({ hostedAuth: DEFAULT_HOSTED_AUTH_POLICY }),
    input.now,
    input.now,
  )
}

type PersonRef = { userId: string; name: string | null; email: string | null }

async function loadPeople(
  db: Db,
  tenantId: string,
  userIds: readonly string[],
): Promise<Map<string, PersonRef>> {
  if (userIds.length === 0) return new Map()
  const rows = await db
    .select({
      id: schema.users.id,
      displayName: schema.users.displayName,
      firstName: schema.users.firstName,
      lastName: schema.users.lastName,
      email: schema.userEmails.email,
    })
    .from(schema.users)
    .leftJoin(
      schema.userEmails,
      and(
        eq(schema.userEmails.tenantId, schema.users.tenantId),
        eq(schema.userEmails.userId, schema.users.id),
        eq(schema.userEmails.isPrimary, true),
      ),
    )
    .where(
      and(eq(schema.users.tenantId, tenantId), inArray(schema.users.id, [...new Set(userIds)])),
    )
  return new Map(
    rows.map((row) => [
      row.id,
      { userId: row.id, name: displayNameOf(row), email: row.email ?? null },
    ]),
  )
}

// 平台审计 actor 是 Instance Manager,账户可能在任何租户:只按 user id 取显示名。
async function loadCreator(db: Db, organizationId: string): Promise<PersonRef | null> {
  const [audit] = await db
    .select({ actorId: schema.platformAuditOutbox.actorId })
    .from(schema.platformAuditOutbox)
    .where(
      and(
        eq(schema.platformAuditOutbox.tenantId, organizationId),
        eq(schema.platformAuditOutbox.action, CREATED_ACTION),
      ),
    )
    .limit(1)
  if (!audit?.actorId) return null
  const [user] = await db
    .select({ tenantId: schema.users.tenantId })
    .from(schema.users)
    .where(eq(schema.users.id, audit.actorId))
    .limit(1)
  if (!user) return { userId: audit.actorId, name: null, email: null }
  const people = await loadPeople(db, user.tenantId, [audit.actorId])
  return people.get(audit.actorId) ?? null
}

async function loadOwner(db: Db, organizationId: string): Promise<PersonRef | null> {
  const [owner] = await db
    .select({ userId: schema.memberships.userId })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.tenantId, organizationId),
        eq(schema.memberships.orgId, organizationId),
        eq(schema.memberships.role, 'owner'),
        eq(schema.memberships.status, 'active'),
      ),
    )
    .orderBy(asc(schema.memberships.createdAt), asc(schema.memberships.id))
    .limit(1)
  if (!owner) return null
  const people = await loadPeople(db, organizationId, [owner.userId])
  return people.get(owner.userId) ?? null
}

async function loadCustomHostname(
  db: Db,
  organizationId: string,
): Promise<{ hostname: string; status: string } | null> {
  const [row] = await db
    .select({ hostname: schema.customHostnames.hostname, status: schema.customHostnames.status })
    .from(schema.customHostnames)
    .where(
      and(
        eq(schema.customHostnames.tenantId, organizationId),
        isNull(schema.customHostnames.deletedAt),
      ),
    )
    .orderBy(desc(schema.customHostnames.updatedAt))
    .limit(1)
  return row ?? null
}

async function loadSeatsAndAudit(
  db: Db,
  organizationId: string,
): Promise<{ seatsUsed: number; auditEntryCount: number }> {
  const [[seats], [audit]] = await Promise.all([
    db
      .select({ value: sql<number>`count(distinct ${schema.memberships.userId})` })
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.tenantId, organizationId),
          eq(schema.memberships.status, 'active'),
        ),
      ),
    db
      .select({ value: count() })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.tenantId, organizationId)),
  ])
  return { seatsUsed: seats?.value ?? 0, auditEntryCount: audit?.value ?? 0 }
}

app.get('/:organizationId', async (c) => {
  await requireInstanceManager(c)
  const db = managementDb(c.env)
  const row = await findTopLevelOrganization(db, c.req.param('organizationId'))
  const [facts, owner, createdBy, customHostname, usage] = await Promise.all([
    loadPageFacts(db, [row]),
    loadOwner(db, row.id),
    loadCreator(db, row.id),
    loadCustomHostname(db, row.id),
    loadSeatsAndAudit(db, row.id),
  ])
  const item = toListItem(row, facts)
  return c.json({
    ...item,
    customHostname,
    owner,
    subOrganizationCount: Math.max(0, item.orgCount - 1),
    selfServiceAllowed: row.allowOrgSelfService,
    createdBy,
    seatLimit: row.seatLimit ?? null,
    ...usage,
  })
})

app.get('/:organizationId/members', async (c) => {
  await requireInstanceManager(c)
  const db = managementDb(c.env)
  const organization = await findTopLevelOrganization(db, c.req.param('organizationId'))
  const { limit, cursor } = parsePlatformPagination(c, 50)
  const scope = and(
    eq(schema.memberships.tenantId, organization.id),
    eq(schema.memberships.status, 'active'),
  )
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: schema.memberships.id,
        userId: schema.memberships.userId,
        role: schema.memberships.role,
        joinedAt: schema.memberships.joinedAt,
        organizationId: schema.organizations.id,
        organizationName: schema.organizations.name,
      })
      .from(schema.memberships)
      .innerJoin(
        schema.organizations,
        and(
          eq(schema.organizations.tenantId, schema.memberships.tenantId),
          eq(schema.organizations.id, schema.memberships.orgId),
        ),
      )
      .where(cursor ? and(scope, gt(schema.memberships.id, decodeCursor(cursor))) : scope)
      .orderBy(asc(schema.memberships.id))
      .limit(limit + 1),
    db.select({ value: count() }).from(schema.memberships).where(scope),
  ])
  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const people = await loadPeople(
    db,
    organization.id,
    pageRows.map((row) => row.userId),
  )
  return c.json({
    data: pageRows.map((row) => ({
      id: row.id,
      user: people.get(row.userId) ?? { userId: row.userId, name: null, email: null },
      role: row.role,
      joinedAt: row.joinedAt?.toISOString() ?? null,
      organizationId: row.organizationId,
      organizationName: row.organizationName,
    })),
    nextCursor: hasMore && pageRows.at(-1) ? encodeCursor(pageRows.at(-1)!.id) : null,
    total: total?.value ?? 0,
  })
})

app.get('/:organizationId/domains', async (c) => {
  await requireInstanceManager(c)
  const db = managementDb(c.env)
  const organization = await findTopLevelOrganization(db, c.req.param('organizationId'))
  const { limit, cursor } = parsePlatformPagination(c, 50)
  const scope = and(
    eq(schema.organizationDomains.tenantId, organization.id),
    isNull(schema.organizationDomains.deletedAt),
  )
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: schema.organizationDomains.id,
        domain: schema.organizationDomains.domain,
        orgId: schema.organizationDomains.orgId,
        verificationStatus: schema.organizationDomains.verificationStatus,
        verifiedAt: schema.organizationDomains.verifiedAt,
        createdAt: schema.organizationDomains.createdAt,
      })
      .from(schema.organizationDomains)
      .where(cursor ? and(scope, gt(schema.organizationDomains.id, decodeCursor(cursor))) : scope)
      .orderBy(asc(schema.organizationDomains.id))
      .limit(limit + 1),
    db.select({ value: count() }).from(schema.organizationDomains).where(scope),
  ])
  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  return c.json({
    data: pageRows.map((row) => ({
      id: row.id,
      domain: row.domain,
      organizationId: row.orgId,
      verified: row.verificationStatus === 'verified',
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: hasMore && pageRows.at(-1) ? encodeCursor(pageRows.at(-1)!.id) : null,
    total: total?.value ?? 0,
  })
})

app.patch('/:organizationId', async (c) => {
  const session = await requireInstanceManager(c)
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
  if (status === 'deleted' && body.confirmSlug !== existing.slug) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'confirmSlug' } })
  }
  const now = Date.now()
  const audit = prepareConditionalPlatformAuditOutboxInsert(
    c.env,
    {
      tenantId: existing.tenantId,
      action: STATUS_CHANGED_ACTION,
      actorId: session.userId,
      payload: {
        targetType: 'organization',
        targetId: existing.id,
        fromStatus: existing.status,
        toStatus: status,
      },
    },
    {
      sql: `EXISTS (
        SELECT 1
          FROM organizations
         WHERE tenant_id = ? AND id = ? AND parent_org_id IS NULL AND status = ?
      )`,
      bindings: [existing.tenantId, organizationId, existing.status],
    },
    now,
  )
  const [auditResult, mutation] = await c.env.DB.batch([
    audit.statement,
    c.env.DB.prepare(
      `UPDATE organizations
       SET status = ?, deleted_at = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND parent_org_id IS NULL AND status = ?
         AND ${audit.mutationGate.sql}`,
    ).bind(
      status,
      status === 'deleted' ? now : null,
      now,
      existing.tenantId,
      organizationId,
      existing.status,
      ...audit.mutationGate.bindings,
    ),
  ])
  if (auditResult?.meta.changes !== 1 || mutation?.meta.changes !== 1) {
    throw new AppError('not_found', { httpStatus: 404 })
  }
  await enqueuePersistedPlatformAudit(c.env, audit)
  const updated = await findTopLevelOrganization(db, organizationId)
  return c.json(toListItem(updated, await loadPageFacts(db, [updated])))
})

export function registerPlatformOrganizationsRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/platform/organizations', app)
}
