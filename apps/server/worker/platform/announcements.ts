import { schema } from '@xid-kit/db'
import { and, count, desc, eq, gt, isNull, lt, lte, or } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import { requireSession } from '../me/shared'
import {
  enqueuePersistedPlatformAudit,
  prepareConditionalPlatformAuditOutboxInsert,
  preparePlatformAuditOutboxInsert,
} from './audit-outbox'
import { loadOrganizationPlanMap, ORGANIZATION_PLANS } from './plans'
import {
  decodeCursor,
  encodeCursor,
  managementDb,
  parsePlatformPagination,
  requireInstanceManager,
} from './shared'

const platformApp = new Hono<XidHonoEnv>()
const activeApp = new Hono<XidHonoEnv>()
const ANNOUNCEMENT_SCOPES = ['global', 'tenant', 'plan'] as const
const ANNOUNCEMENT_SEVERITIES = ['info', 'success', 'warning', 'critical'] as const
const ANNOUNCEMENT_STATUSES = ['draft', 'published', 'archived'] as const
const CURSOR_SEPARATOR = '|'

const timestampSchema = v.pipe(v.string(), v.trim(), v.minLength(1))
const nullableStringSchema = v.nullable(v.pipe(v.string(), v.trim(), v.minLength(1)))

const createAnnouncementSchema = v.object({
  scopeType: v.picklist(ANNOUNCEMENT_SCOPES),
  scopeValue: v.optional(nullableStringSchema, null),
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160)),
  body: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4_000)),
  severity: v.picklist(ANNOUNCEMENT_SEVERITIES),
  status: v.picklist(ANNOUNCEMENT_STATUSES),
  startsAt: timestampSchema,
  endsAt: v.optional(v.nullable(timestampSchema), null),
})

const patchAnnouncementSchema = v.partial(createAnnouncementSchema)

type AnnouncementRow = typeof schema.platformAnnouncements.$inferSelect
type AnnouncementInput = v.InferOutput<typeof createAnnouncementSchema>

function toIso(value: Date | null): string | null {
  return value?.toISOString() ?? null
}

function mapAnnouncement(row: AnnouncementRow) {
  return {
    id: row.id,
    scopeType: row.scopeType,
    scopeValue: row.scopeValue ?? null,
    title: row.title,
    body: row.body,
    severity: row.severity,
    status: row.status,
    startsAt: row.startsAt.toISOString(),
    endsAt: toIso(row.endsAt),
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function parseTimestamp(value: string, paramName: string): Date {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName } })
  }
  return parsed
}

async function assertScope(
  env: Env,
  scopeType: AnnouncementInput['scopeType'],
  scopeValue: string | null,
): Promise<void> {
  if (scopeType === 'global') {
    if (scopeValue !== null) {
      throw new AppError('validation_failed', {
        httpStatus: 422,
        meta: { paramName: 'scopeValue' },
      })
    }
    return
  }
  if (!scopeValue) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'scopeValue' },
    })
  }
  if (scopeType === 'plan') {
    if (!ORGANIZATION_PLANS.includes(scopeValue as (typeof ORGANIZATION_PLANS)[number])) {
      throw new AppError('validation_failed', {
        httpStatus: 422,
        meta: { paramName: 'scopeValue' },
      })
    }
    return
  }
  const [tenant] = await managementDb(env)
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(
      and(
        eq(schema.organizations.id, scopeValue),
        eq(schema.organizations.tenantId, scopeValue),
        isNull(schema.organizations.parentOrgId),
      ),
    )
    .limit(1)
  if (!tenant) throw new AppError('not_found', { httpStatus: 404 })
}

function normalizeInput(input: AnnouncementInput): AnnouncementInput & {
  startsAtDate: Date
  endsAtDate: Date | null
} {
  const startsAtDate = parseTimestamp(input.startsAt, 'startsAt')
  const endsAtDate = input.endsAt === null ? null : parseTimestamp(input.endsAt, 'endsAt')
  if (endsAtDate && endsAtDate <= startsAtDate) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName: 'endsAt' } })
  }
  return { ...input, scopeValue: input.scopeValue ?? null, startsAtDate, endsAtDate }
}

function decodeAnnouncementCursor(cursor: string): { createdAt: Date; id: string } {
  const decoded = decodeCursor(cursor)
  const separatorIndex = decoded.indexOf(CURSOR_SEPARATOR)
  if (separatorIndex === -1) throw new AppError('validation_failed', { httpStatus: 422 })
  const createdAt = new Date(Number(decoded.slice(0, separatorIndex)))
  const id = decoded.slice(separatorIndex + 1)
  if (!Number.isFinite(createdAt.getTime()) || id.length === 0) {
    throw new AppError('validation_failed', { httpStatus: 422 })
  }
  return { createdAt, id }
}

function afterAnnouncementCursor(cursor: string | null): SQL | undefined {
  if (!cursor) return undefined
  const decoded = decodeAnnouncementCursor(cursor)
  return or(
    lt(schema.platformAnnouncements.createdAt, decoded.createdAt),
    and(
      eq(schema.platformAnnouncements.createdAt, decoded.createdAt),
      lt(schema.platformAnnouncements.id, decoded.id),
    ),
  )
}

function encodeAnnouncementCursor(row: AnnouncementRow): string {
  return encodeCursor(`${row.createdAt.getTime()}${CURSOR_SEPARATOR}${row.id}`)
}

async function findAnnouncement(env: Env, id: string): Promise<AnnouncementRow | undefined> {
  const rows = await managementDb(env)
    .select()
    .from(schema.platformAnnouncements)
    .where(eq(schema.platformAnnouncements.id, id))
    .limit(1)
  return rows[0]
}

function auditTenantId(scopeType: string, scopeValue: string | null): string {
  return scopeType === 'tenant' && scopeValue ? scopeValue : 'platform'
}

platformApp.get('/', async (c) => {
  await requireInstanceManager(c)
  const db = managementDb(c.env)
  const { limit, cursor } = parsePlatformPagination(c, 30)
  const after = afterAnnouncementCursor(cursor)
  const rows = await db
    .select()
    .from(schema.platformAnnouncements)
    .where(after)
    .orderBy(desc(schema.platformAnnouncements.createdAt), desc(schema.platformAnnouncements.id))
    .limit(limit + 1)
  const [totalRow] = await db.select({ value: count() }).from(schema.platformAnnouncements)
  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const last = pageRows.at(-1)
  return c.json({
    data: pageRows.map(mapAnnouncement),
    nextCursor: hasMore && last ? encodeAnnouncementCursor(last) : null,
    total: totalRow?.value ?? 0,
  })
})

platformApp.post('/', async (c) => {
  const session = await requireInstanceManager(c)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const input = normalizeInput(validateBody(createAnnouncementSchema, json.value))
  await assertScope(c.env, input.scopeType, input.scopeValue)

  const id = createPersistedId('announcement')
  const now = new Date()
  const row: AnnouncementRow = {
    id,
    scopeType: input.scopeType,
    scopeValue: input.scopeValue,
    title: input.title,
    body: input.body,
    severity: input.severity,
    status: input.status,
    startsAt: input.startsAtDate,
    endsAt: input.endsAtDate,
    createdBy: session.userId,
    updatedBy: session.userId,
    createdAt: now,
    updatedAt: now,
  }
  const audit = preparePlatformAuditOutboxInsert(
    c.env,
    {
      tenantId: auditTenantId(row.scopeType, row.scopeValue),
      action: 'platform.announcement.created',
      actorId: session.userId,
      payload: {
        targetType: 'platform_announcement',
        targetId: id,
        scopeType: row.scopeType,
        scopeValue: row.scopeValue,
        severity: row.severity,
        status: row.status,
      },
    },
    now.getTime(),
  )
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO platform_announcements (
         id, scope_type, scope_value, title, body, severity, status, starts_at, ends_at,
         created_by, updated_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.id,
      row.scopeType,
      row.scopeValue,
      row.title,
      row.body,
      row.severity,
      row.status,
      row.startsAt.getTime(),
      row.endsAt?.getTime() ?? null,
      row.createdBy,
      row.updatedBy,
      row.createdAt.getTime(),
      row.updatedAt.getTime(),
    ),
    audit.statement,
  ])
  await enqueuePersistedPlatformAudit(c.env, audit)
  return c.json(mapAnnouncement(row), 201)
})

platformApp.patch('/:id', async (c) => {
  const session = await requireInstanceManager(c)
  const existing = await findAnnouncement(c.env, c.req.param('id'))
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const patch = validateBody(patchAnnouncementSchema, json.value)
  if (Object.keys(patch).length === 0) {
    throw new AppError('validation_failed', { httpStatus: 422 })
  }
  const normalized = normalizeInput({
    scopeType: patch.scopeType ?? (existing.scopeType as AnnouncementInput['scopeType']),
    scopeValue: patch.scopeValue === undefined ? existing.scopeValue : patch.scopeValue,
    title: patch.title ?? existing.title,
    body: patch.body ?? existing.body,
    severity: patch.severity ?? (existing.severity as AnnouncementInput['severity']),
    status: patch.status ?? (existing.status as AnnouncementInput['status']),
    startsAt: patch.startsAt ?? existing.startsAt.toISOString(),
    endsAt: patch.endsAt === undefined ? toIso(existing.endsAt) : patch.endsAt,
  })
  await assertScope(c.env, normalized.scopeType, normalized.scopeValue)
  const now = new Date()
  const updated: AnnouncementRow = {
    ...existing,
    ...normalized,
    scopeValue: normalized.scopeValue,
    startsAt: normalized.startsAtDate,
    endsAt: normalized.endsAtDate,
    updatedBy: session.userId,
    updatedAt: now,
  }
  const audit = prepareConditionalPlatformAuditOutboxInsert(
    c.env,
    {
      tenantId: auditTenantId(updated.scopeType, updated.scopeValue),
      action: 'platform.announcement.updated',
      actorId: session.userId,
      payload: {
        targetType: 'platform_announcement',
        targetId: updated.id,
        scopeType: updated.scopeType,
        scopeValue: updated.scopeValue,
        severity: updated.severity,
        status: updated.status,
      },
    },
    {
      sql: `EXISTS (
        SELECT 1 FROM platform_announcements WHERE id = ? AND updated_at = ?
      )`,
      bindings: [updated.id, existing.updatedAt.getTime()],
    },
    now.getTime(),
  )
  const [auditResult, mutation] = await c.env.DB.batch([
    audit.statement,
    c.env.DB.prepare(
      `UPDATE platform_announcements
       SET scope_type = ?, scope_value = ?, title = ?, body = ?, severity = ?, status = ?,
           starts_at = ?, ends_at = ?, updated_by = ?, updated_at = ?
       WHERE id = ? AND updated_at = ? AND ${audit.mutationGate.sql}`,
    ).bind(
      updated.scopeType,
      updated.scopeValue,
      updated.title,
      updated.body,
      updated.severity,
      updated.status,
      updated.startsAt.getTime(),
      updated.endsAt?.getTime() ?? null,
      updated.updatedBy,
      updated.updatedAt.getTime(),
      updated.id,
      existing.updatedAt.getTime(),
      ...audit.mutationGate.bindings,
    ),
  ])
  if (auditResult?.meta.changes !== 1 || mutation?.meta.changes !== 1) {
    throw new AppError('not_found', { httpStatus: 404 })
  }
  await enqueuePersistedPlatformAudit(c.env, audit)
  return c.json(mapAnnouncement(updated))
})

platformApp.delete('/:id', async (c) => {
  const session = await requireInstanceManager(c)
  const existing = await findAnnouncement(c.env, c.req.param('id'))
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  const now = Date.now()
  const audit = prepareConditionalPlatformAuditOutboxInsert(
    c.env,
    {
      tenantId: auditTenantId(existing.scopeType, existing.scopeValue),
      action: 'platform.announcement.deleted',
      actorId: session.userId,
      payload: {
        targetType: 'platform_announcement',
        targetId: existing.id,
        scopeType: existing.scopeType,
        scopeValue: existing.scopeValue,
      },
    },
    {
      sql: `EXISTS (
        SELECT 1 FROM platform_announcements WHERE id = ? AND updated_at = ?
      )`,
      bindings: [existing.id, existing.updatedAt.getTime()],
    },
    now,
  )
  const [auditResult, mutation] = await c.env.DB.batch([
    audit.statement,
    c.env.DB.prepare(
      `DELETE FROM platform_announcements
        WHERE id = ? AND updated_at = ? AND ${audit.mutationGate.sql}`,
    ).bind(existing.id, existing.updatedAt.getTime(), ...audit.mutationGate.bindings),
  ])
  if (auditResult?.meta.changes !== 1 || mutation?.meta.changes !== 1) {
    throw new AppError('not_found', { httpStatus: 404 })
  }
  await enqueuePersistedPlatformAudit(c.env, audit)
  return c.json({ deleted: true as const })
})

activeApp.get('/', async (c) => {
  await requireSession(c)
  const tenant = c.get('tenant')
  const plan =
    (await loadOrganizationPlanMap(c.env, [tenant.tenantId])).get(tenant.tenantId) ?? 'free'
  const now = new Date()
  const rows = await managementDb(c.env)
    .select()
    .from(schema.platformAnnouncements)
    .where(
      and(
        eq(schema.platformAnnouncements.status, 'published'),
        lte(schema.platformAnnouncements.startsAt, now),
        or(
          isNull(schema.platformAnnouncements.endsAt),
          gt(schema.platformAnnouncements.endsAt, now),
        ),
        or(
          eq(schema.platformAnnouncements.scopeType, 'global'),
          and(
            eq(schema.platformAnnouncements.scopeType, 'tenant'),
            eq(schema.platformAnnouncements.scopeValue, tenant.tenantId),
          ),
          and(
            eq(schema.platformAnnouncements.scopeType, 'plan'),
            eq(schema.platformAnnouncements.scopeValue, plan),
          ),
        ),
      ),
    )
    .orderBy(desc(schema.platformAnnouncements.startsAt), desc(schema.platformAnnouncements.id))
    .limit(20)
  c.header('Cache-Control', 'private, max-age=30')
  return c.json(rows.map(mapAnnouncement))
})

export function registerPlatformAnnouncementRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/platform/announcements', platformApp)
}

export function registerActiveAnnouncementRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/announcements/active', activeApp)
}
