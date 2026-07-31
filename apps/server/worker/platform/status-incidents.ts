import { schema } from '@xid-kit/db'
import { and, count, desc, eq, inArray, lt, or } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
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

const app = new Hono<XidHonoEnv>()
const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const
const INCIDENT_IMPACTS = ['none', 'minor', 'major', 'critical'] as const
const CURSOR_SEPARATOR = '|'
const timestampSchema = v.pipe(v.string(), v.trim(), v.minLength(1))

const createIncidentSchema = v.object({
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160)),
  status: v.picklist(INCIDENT_STATUSES),
  impact: v.picklist(INCIDENT_IMPACTS),
  summary: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4_000)),
  startedAt: timestampSchema,
})

const patchIncidentSchema = v.object({
  title: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(160))),
  status: v.optional(v.picklist(INCIDENT_STATUSES)),
  impact: v.optional(v.picklist(INCIDENT_IMPACTS)),
  summary: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4_000))),
  startedAt: v.optional(timestampSchema),
  resolvedAt: v.optional(v.nullable(timestampSchema)),
})

const createUpdateSchema = v.object({
  status: v.picklist(INCIDENT_STATUSES),
  message: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4_000)),
})

type IncidentRow = typeof schema.statusIncidents.$inferSelect
type IncidentUpdateRow = typeof schema.statusIncidentUpdates.$inferSelect

function parseTimestamp(value: string, paramName: string): Date {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) {
    throw new AppError('validation_failed', { httpStatus: 422, meta: { paramName } })
  }
  return date
}

export function resolveIncidentResolvedAt(
  existing: Pick<IncidentRow, 'status' | 'resolvedAt'>,
  status: (typeof INCIDENT_STATUSES)[number],
  input: string | null | undefined,
  now: Date,
): Date | null {
  if (status !== 'resolved') {
    if (input) {
      throw new AppError('validation_failed', {
        httpStatus: 422,
        meta: { paramName: 'resolvedAt' },
      })
    }
    return null
  }
  if (input === null) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'resolvedAt' },
    })
  }
  if (input !== undefined) return parseTimestamp(input, 'resolvedAt')
  return existing.status === 'resolved' ? (existing.resolvedAt ?? now) : now
}

function mapIncidentUpdate(row: IncidentUpdateRow) {
  return {
    id: row.id,
    incidentId: row.incidentId,
    status: row.status,
    message: row.message,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  }
}

function mapIncident(row: IncidentRow, updates: readonly IncidentUpdateRow[] = []) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    impact: row.impact,
    summary: row.summary,
    startedAt: row.startedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    updates: updates.map(mapIncidentUpdate),
  }
}

function decodeIncidentCursor(cursor: string): { startedAt: Date; id: string } {
  const decoded = decodeCursor(cursor)
  const separatorIndex = decoded.indexOf(CURSOR_SEPARATOR)
  if (separatorIndex === -1) throw new AppError('validation_failed', { httpStatus: 422 })
  const startedAt = new Date(Number(decoded.slice(0, separatorIndex)))
  const id = decoded.slice(separatorIndex + 1)
  if (!Number.isFinite(startedAt.getTime()) || id.length === 0) {
    throw new AppError('validation_failed', { httpStatus: 422 })
  }
  return { startedAt, id }
}

function afterIncidentCursor(cursor: string | null): SQL | undefined {
  if (!cursor) return undefined
  const decoded = decodeIncidentCursor(cursor)
  return or(
    lt(schema.statusIncidents.startedAt, decoded.startedAt),
    and(
      eq(schema.statusIncidents.startedAt, decoded.startedAt),
      lt(schema.statusIncidents.id, decoded.id),
    ),
  )
}

function encodeIncidentCursor(row: IncidentRow): string {
  return encodeCursor(`${row.startedAt.getTime()}${CURSOR_SEPARATOR}${row.id}`)
}

async function incidentUpdatesById(
  env: Env,
  incidentIds: readonly string[],
): Promise<Map<string, IncidentUpdateRow[]>> {
  if (incidentIds.length === 0) return new Map()
  const rows = await managementDb(env)
    .select()
    .from(schema.statusIncidentUpdates)
    .where(inArray(schema.statusIncidentUpdates.incidentId, incidentIds))
    .orderBy(desc(schema.statusIncidentUpdates.createdAt), desc(schema.statusIncidentUpdates.id))
  const updates = new Map<string, IncidentUpdateRow[]>()
  for (const row of rows) {
    const list = updates.get(row.incidentId) ?? []
    list.push(row)
    updates.set(row.incidentId, list)
  }
  return updates
}

async function findIncident(env: Env, id: string): Promise<IncidentRow | undefined> {
  const rows = await managementDb(env)
    .select()
    .from(schema.statusIncidents)
    .where(eq(schema.statusIncidents.id, id))
    .limit(1)
  return rows[0]
}

async function responseIncident(env: Env, row: IncidentRow) {
  const updates = await incidentUpdatesById(env, [row.id])
  return mapIncident(row, updates.get(row.id) ?? [])
}

app.get('/', async (c) => {
  await requireInstanceManager(c)
  const db = managementDb(c.env)
  const { limit, cursor } = parsePlatformPagination(c, 30)
  const after = afterIncidentCursor(cursor)
  const rows = await db
    .select()
    .from(schema.statusIncidents)
    .where(after)
    .orderBy(desc(schema.statusIncidents.startedAt), desc(schema.statusIncidents.id))
    .limit(limit + 1)
  const [totalRow] = await db.select({ value: count() }).from(schema.statusIncidents)
  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const updates = await incidentUpdatesById(
    c.env,
    pageRows.map((row) => row.id),
  )
  const last = pageRows.at(-1)
  return c.json({
    data: pageRows.map((row) => mapIncident(row, updates.get(row.id) ?? [])),
    nextCursor: hasMore && last ? encodeIncidentCursor(last) : null,
    total: totalRow?.value ?? 0,
  })
})

app.get('/:id', async (c) => {
  await requireInstanceManager(c)
  const incident = await findIncident(c.env, c.req.param('id'))
  if (!incident) throw new AppError('not_found', { httpStatus: 404 })
  return c.json(await responseIncident(c.env, incident))
})

app.post('/', async (c) => {
  const session = await requireInstanceManager(c)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const input = validateBody(createIncidentSchema, json.value)
  const now = new Date()
  const startedAt = parseTimestamp(input.startedAt, 'startedAt')
  const id = createPersistedId('statusIncident')
  const row: IncidentRow = {
    id,
    title: input.title,
    status: input.status,
    impact: input.impact,
    summary: input.summary,
    startedAt,
    resolvedAt: input.status === 'resolved' ? now : null,
    createdBy: session.userId,
    updatedBy: session.userId,
    createdAt: now,
    updatedAt: now,
  }
  const audit = preparePlatformAuditOutboxInsert(
    c.env,
    {
      tenantId: 'platform',
      action: 'platform.status_incident.created',
      actorId: session.userId,
      payload: {
        targetType: 'status_incident',
        targetId: id,
        status: row.status,
        impact: row.impact,
      },
    },
    now.getTime(),
  )
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO status_incidents (
         id, title, status, impact, summary, started_at, resolved_at,
         created_by, updated_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.id,
      row.title,
      row.status,
      row.impact,
      row.summary,
      row.startedAt.getTime(),
      row.resolvedAt?.getTime() ?? null,
      row.createdBy,
      row.updatedBy,
      row.createdAt.getTime(),
      row.updatedAt.getTime(),
    ),
    audit.statement,
  ])
  await enqueuePersistedPlatformAudit(c.env, audit)
  return c.json(mapIncident(row), 201)
})

app.patch('/:id', async (c) => {
  const session = await requireInstanceManager(c)
  const existing = await findIncident(c.env, c.req.param('id'))
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const patch = validateBody(patchIncidentSchema, json.value)
  if (Object.keys(patch).length === 0) {
    throw new AppError('validation_failed', { httpStatus: 422 })
  }
  const now = new Date()
  const status = patch.status ?? existing.status
  const startedAt =
    patch.startedAt === undefined
      ? existing.startedAt
      : parseTimestamp(patch.startedAt, 'startedAt')
  const resolvedAt = resolveIncidentResolvedAt(
    existing,
    status as (typeof INCIDENT_STATUSES)[number],
    patch.resolvedAt,
    now,
  )
  if (resolvedAt && resolvedAt < startedAt) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'resolvedAt' },
    })
  }
  const updated: IncidentRow = {
    ...existing,
    title: patch.title ?? existing.title,
    status,
    impact: patch.impact ?? existing.impact,
    summary: patch.summary ?? existing.summary,
    startedAt,
    resolvedAt,
    updatedBy: session.userId,
    updatedAt: now,
  }
  const audit = prepareConditionalPlatformAuditOutboxInsert(
    c.env,
    {
      tenantId: 'platform',
      action: 'platform.status_incident.updated',
      actorId: session.userId,
      payload: {
        targetType: 'status_incident',
        targetId: updated.id,
        status: updated.status,
        impact: updated.impact,
      },
    },
    {
      sql: `EXISTS (
        SELECT 1 FROM status_incidents WHERE id = ? AND updated_at = ?
      )`,
      bindings: [updated.id, existing.updatedAt.getTime()],
    },
    now.getTime(),
  )
  const [auditResult, mutation] = await c.env.DB.batch([
    audit.statement,
    c.env.DB.prepare(
      `UPDATE status_incidents
       SET title = ?, status = ?, impact = ?, summary = ?, started_at = ?, resolved_at = ?,
           updated_by = ?, updated_at = ?
       WHERE id = ? AND updated_at = ? AND ${audit.mutationGate.sql}`,
    ).bind(
      updated.title,
      updated.status,
      updated.impact,
      updated.summary,
      updated.startedAt.getTime(),
      updated.resolvedAt?.getTime() ?? null,
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
  return c.json(await responseIncident(c.env, updated))
})

app.post('/:id/updates', async (c) => {
  const session = await requireInstanceManager(c)
  const existing = await findIncident(c.env, c.req.param('id'))
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const input = validateBody(createUpdateSchema, json.value)
  const now = new Date()
  const update: IncidentUpdateRow = {
    id: createPersistedId('statusIncidentUpdate'),
    incidentId: existing.id,
    status: input.status,
    message: input.message,
    createdBy: session.userId,
    createdAt: now,
  }
  const resolvedAt = input.status === 'resolved' ? now : null
  const audit = prepareConditionalPlatformAuditOutboxInsert(
    c.env,
    {
      tenantId: 'platform',
      action: 'platform.status_incident.update_published',
      actorId: session.userId,
      payload: {
        targetType: 'status_incident',
        targetId: existing.id,
        status: input.status,
        updateId: update.id,
      },
    },
    {
      sql: `EXISTS (
        SELECT 1 FROM status_incidents WHERE id = ? AND updated_at = ?
      )`,
      bindings: [existing.id, existing.updatedAt.getTime()],
    },
    now.getTime(),
  )
  const [auditResult, insertResult, updateResult] = await c.env.DB.batch([
    audit.statement,
    c.env.DB.prepare(
      `INSERT INTO status_incident_updates (
         id, incident_id, status, message, created_by, created_at
       )
       SELECT ?, ?, ?, ?, ?, ?
        WHERE ${audit.mutationGate.sql}`,
    ).bind(
      update.id,
      update.incidentId,
      update.status,
      update.message,
      update.createdBy,
      update.createdAt.getTime(),
      ...audit.mutationGate.bindings,
    ),
    c.env.DB.prepare(
      `UPDATE status_incidents
       SET status = ?, resolved_at = ?, updated_by = ?, updated_at = ?
       WHERE id = ? AND updated_at = ? AND ${audit.mutationGate.sql}`,
    ).bind(
      input.status,
      resolvedAt?.getTime() ?? null,
      session.userId,
      now.getTime(),
      existing.id,
      existing.updatedAt.getTime(),
      ...audit.mutationGate.bindings,
    ),
  ])
  if (
    auditResult?.meta.changes !== 1 ||
    insertResult?.meta.changes !== 1 ||
    updateResult?.meta.changes !== 1
  ) {
    throw new AppError('not_found', { httpStatus: 404 })
  }
  await enqueuePersistedPlatformAudit(c.env, audit)
  return c.json(
    await responseIncident(c.env, {
      ...existing,
      status: input.status,
      resolvedAt,
      updatedBy: session.userId,
      updatedAt: now,
    }),
    201,
  )
})

app.delete('/:id', async (c) => {
  const session = await requireInstanceManager(c)
  const existing = await findIncident(c.env, c.req.param('id'))
  if (!existing) throw new AppError('not_found', { httpStatus: 404 })
  const now = Date.now()
  const audit = prepareConditionalPlatformAuditOutboxInsert(
    c.env,
    {
      tenantId: 'platform',
      action: 'platform.status_incident.deleted',
      actorId: session.userId,
      payload: {
        targetType: 'status_incident',
        targetId: existing.id,
        status: existing.status,
        impact: existing.impact,
      },
    },
    {
      sql: `EXISTS (
        SELECT 1 FROM status_incidents WHERE id = ? AND updated_at = ?
      )`,
      bindings: [existing.id, existing.updatedAt.getTime()],
    },
    now,
  )
  const [auditResult, , mutation] = await c.env.DB.batch([
    audit.statement,
    c.env.DB.prepare(
      `DELETE FROM status_incident_updates
        WHERE incident_id = ? AND ${audit.mutationGate.sql}`,
    ).bind(existing.id, ...audit.mutationGate.bindings),
    c.env.DB.prepare(
      `DELETE FROM status_incidents
        WHERE id = ? AND updated_at = ? AND ${audit.mutationGate.sql}`,
    ).bind(existing.id, existing.updatedAt.getTime(), ...audit.mutationGate.bindings),
  ])
  if (auditResult?.meta.changes !== 1 || mutation?.meta.changes !== 1) {
    throw new AppError('not_found', { httpStatus: 404 })
  }
  await enqueuePersistedPlatformAudit(c.env, audit)
  return c.json({ deleted: true as const })
})

export function registerPlatformStatusIncidentRoutes(honoApp: Hono<XidHonoEnv>): void {
  honoApp.route('/v1/platform/status-incidents', app)
}
