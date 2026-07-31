// Instance Manager provisioning is intentionally isolated from tenant-scoped Management APIs.
// This route uses the platform raw DB only after requireInstanceManager and never accepts API keys.

import { schema } from '@xid-kit/db'
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { isUniqueConstraintError } from '../lib/d1-errors'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { readJsonBody, validateBody } from '../lib/validate'
import {
  enqueuePersistedPlatformAudit,
  prepareConditionalPlatformAuditOutboxInsert,
} from './audit-outbox'
import {
  decodeCursor,
  encodeCursor,
  managementDb,
  parsePlatformPagination,
  requireInstanceManager,
} from './shared'

const app = new Hono<XidHonoEnv>()

const createBodySchema = v.object({
  user_id: v.pipe(v.string(), v.minLength(1)),
})

function toResponse(row: typeof schema.managerAssignments.$inferSelect) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    managerRole: row.managerRole,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

const instanceManagerFilter = and(
  eq(schema.managerAssignments.managerRole, 'instance_manager'),
  eq(schema.managerAssignments.scopeType, 'instance'),
  isNull(schema.managerAssignments.scopeId),
)

app.get('/', async (c) => {
  await requireInstanceManager(c)
  const db = managementDb(c.env)
  const { limit, cursor } = parsePlatformPagination(c, 20)
  const where = cursor
    ? and(instanceManagerFilter, gt(schema.managerAssignments.id, decodeCursor(cursor)))
    : instanceManagerFilter
  const [rows, countRows] = await Promise.all([
    db
      .select()
      .from(schema.managerAssignments)
      .where(where)
      .orderBy(asc(schema.managerAssignments.id))
      .limit(limit + 1),
    db
      .select({ value: sql<number>`count(*)` })
      .from(schema.managerAssignments)
      .where(instanceManagerFilter),
  ])
  const hasMore = rows.length > limit
  const dataRows = hasMore ? rows.slice(0, limit) : rows
  return c.json({
    data: dataRows.map(toResponse),
    nextCursor: hasMore ? encodeCursor(dataRows.at(-1)!.id) : null,
    total: countRows[0]?.value ?? 0,
  })
})

app.post('/', async (c) => {
  const session = await requireInstanceManager(c)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createBodySchema, json.value)
  if (body.user_id === session.userId) throw new AppError('forbidden', { httpStatus: 403 })

  const db = managementDb(c.env)
  const users = await db
    .select()
    .from(schema.users)
    .where(
      and(
        eq(schema.users.id, body.user_id),
        eq(schema.users.status, 'active'),
        isNull(schema.users.deletedAt),
      ),
    )
    .limit(1)
  const user = users[0]
  if (!user) throw new AppError('not_found', { httpStatus: 404 })
  const existing = await db
    .select({ id: schema.managerAssignments.id })
    .from(schema.managerAssignments)
    .where(and(instanceManagerFilter, eq(schema.managerAssignments.userId, body.user_id)))
    .limit(1)
  if (existing[0]) throw new AppError('already_exists', { httpStatus: 409 })

  const now = new Date()
  const row: typeof schema.managerAssignments.$inferSelect = {
    id: createPersistedId('managerAssignment'),
    tenantId: user.tenantId,
    userId: user.id,
    managerRole: 'instance_manager',
    scopeType: 'instance',
    scopeId: null,
    createdAt: now,
    updatedAt: now,
  }
  const audit = prepareConditionalPlatformAuditOutboxInsert(
    c.env,
    {
      tenantId: row.tenantId,
      action: 'platform.instance_manager.granted',
      actorId: session.userId,
      payload: {
        targetType: 'manager_assignment',
        targetId: row.id,
        userId: row.userId,
      },
    },
    {
      sql: `NOT EXISTS (
        SELECT 1
          FROM manager_assignments
         WHERE tenant_id = ?
           AND user_id = ?
           AND manager_role = 'instance_manager'
           AND scope_type = 'instance'
           AND scope_id IS NULL
      )`,
      bindings: [row.tenantId, row.userId],
    },
    now.getTime(),
  )
  let auditResult: D1Result<unknown> | undefined
  let mutation: D1Result<unknown> | undefined
  try {
    ;[auditResult, mutation] = await c.env.DB.batch([
      audit.statement,
      c.env.DB.prepare(
        `INSERT INTO manager_assignments (
           id, tenant_id, user_id, manager_role, scope_type, scope_id, created_at, updated_at
         )
         SELECT ?, ?, ?, 'instance_manager', 'instance', NULL, ?, ?
          WHERE ${audit.mutationGate.sql}`,
      ).bind(
        row.id,
        row.tenantId,
        row.userId,
        row.createdAt.getTime(),
        row.updatedAt.getTime(),
        ...audit.mutationGate.bindings,
      ),
    ])
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new AppError('already_exists', { httpStatus: 409, cause: error })
    }
    throw error
  }
  const auditPersisted = auditResult?.meta.changes === 1
  const assignmentCreated = mutation?.meta.changes === 1
  if (auditPersisted !== assignmentCreated) {
    throw new AppError('internal_error', { httpStatus: 500 })
  }
  if (!assignmentCreated) throw new AppError('already_exists', { httpStatus: 409 })
  await enqueuePersistedPlatformAudit(c.env, audit)
  return c.json(toResponse(row), 201)
})

app.delete('/:id', async (c) => {
  const session = await requireInstanceManager(c)
  const db = managementDb(c.env)
  const rows = await db
    .select()
    .from(schema.managerAssignments)
    .where(and(instanceManagerFilter, eq(schema.managerAssignments.id, c.req.param('id'))))
    .limit(1)
  const row = rows[0]
  if (!row) throw new AppError('not_found', { httpStatus: 404 })
  if (row.userId === session.userId) throw new AppError('forbidden', { httpStatus: 403 })
  const audit = prepareConditionalPlatformAuditOutboxInsert(
    c.env,
    {
      tenantId: row.tenantId,
      action: 'platform.instance_manager.revoked',
      actorId: session.userId,
      payload: {
        targetType: 'manager_assignment',
        targetId: row.id,
        userId: row.userId,
      },
    },
    {
      sql: `EXISTS (
        SELECT 1
          FROM manager_assignments
         WHERE id = ?
           AND manager_role = 'instance_manager'
           AND scope_type = 'instance'
           AND scope_id IS NULL
           AND user_id <> ?
      ) AND (
        SELECT COUNT(*)
          FROM manager_assignments
         WHERE manager_role = 'instance_manager'
           AND scope_type = 'instance'
           AND scope_id IS NULL
      ) > 1`,
      bindings: [row.id, session.userId],
    },
  )
  const [auditResult, mutation] = await c.env.DB.batch([
    audit.statement,
    c.env.DB.prepare(
      `DELETE FROM manager_assignments
       WHERE id = ?
         AND manager_role = 'instance_manager'
         AND scope_type = 'instance'
         AND scope_id IS NULL
         AND user_id <> ?
         AND (
           SELECT COUNT(*)
           FROM manager_assignments
           WHERE manager_role = 'instance_manager'
             AND scope_type = 'instance'
             AND scope_id IS NULL
         ) > 1
         AND ${audit.mutationGate.sql}`,
    ).bind(row.id, session.userId, ...audit.mutationGate.bindings),
  ])
  const auditPersisted = auditResult?.meta.changes === 1
  const assignmentDeleted = mutation?.meta.changes === 1
  if (auditPersisted !== assignmentDeleted) {
    throw new AppError('internal_error', { httpStatus: 500 })
  }
  if (!assignmentDeleted) {
    throw new AppError('conflict', {
      httpStatus: 409,
      longMessage: 'At least one instance manager must remain.',
    })
  }
  await enqueuePersistedPlatformAudit(c.env, audit)
  return new Response(null, { status: 204 })
})

export function registerPlatformManagerAssignmentRoutes(parent: Hono<XidHonoEnv>): void {
  parent.route('/v1/platform/manager-assignments', app)
}
