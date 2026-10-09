// Instance Manager 配给与租户 Management API 隔离:仅 requireInstanceManager 后门控 raw DB,不接受 API key。

import { schema } from '@xid-kit/db'
import type { GlobalUserStatus, InstanceManagerAssignment } from '@xid-kit/types'
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { isUniqueConstraintError } from '../lib/d1-errors'
import { AppError } from '../lib/errors'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { emailSchema, readJsonBody, validateBody } from '../lib/validate'
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
import { displayNameOf, toGlobalUserStatus } from './user-display'
import { lastActiveAtByUser } from './users'

const app = new Hono<XidHonoEnv>()

type Db = ReturnType<typeof managementDb>
type AssignmentRow = typeof schema.managerAssignments.$inferSelect

// 授予对象二选一:精确 user ID,或组织 + 主邮箱精确匹配(不做模糊建议,表单不能用来探测账户)。
const createBodySchema = v.union([
  v.object({ user_id: v.pipe(v.string(), v.minLength(1)) }),
  v.object({
    organization_id: v.pipe(v.string(), v.minLength(1)),
    email: emailSchema,
  }),
])

type ManagerIdentity = {
  email: string | null
  displayName: string | null
  userStatus: GlobalUserStatus | null
  organizationName: string | null
}

const UNKNOWN_IDENTITY: ManagerIdentity = {
  email: null,
  displayName: null,
  userStatus: null,
  organizationName: null,
}

export type PlatformManagerAssignment = InstanceManagerAssignment & {
  grantedBy: { userId: string; displayName: string | null; email: string | null } | null
  lastActiveAt: string | null
}

type AssignmentFacts = {
  identities: Map<string, ManagerIdentity>
  grantors: Map<string, { displayName: string | null; email: string | null }>
  lastActive: Map<string, number>
}

function toResponse(row: AssignmentRow, facts: AssignmentFacts): PlatformManagerAssignment {
  const lastActive = facts.lastActive.get(`${row.tenantId}:${row.userId}`)
  const grantor = row.grantedBy ? facts.grantors.get(row.grantedBy) : undefined
  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    ...(facts.identities.get(`${row.tenantId}:${row.userId}`) ?? UNKNOWN_IDENTITY),
    managerRole: 'instance_manager',
    scopeType: 'instance',
    scopeId: null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    grantedBy: row.grantedBy
      ? {
          userId: row.grantedBy,
          displayName: grantor?.displayName ?? null,
          email: grantor?.email ?? null,
        }
      : null,
    lastActiveAt: lastActive === undefined ? null : new Date(lastActive).toISOString(),
  }
}

// 撤销前须让管理员认出对象:按当前页 user/tenant 批量取主邮箱、显示名与组织名。
async function loadManagerIdentities(
  db: Db,
  rows: readonly AssignmentRow[],
): Promise<Map<string, ManagerIdentity>> {
  if (rows.length === 0) return new Map()
  const userIds = rows.map((row) => row.userId)
  const tenantIds = [...new Set(rows.map((row) => row.tenantId))]
  const [users, organizations] = await Promise.all([
    db
      .select({
        id: schema.users.id,
        tenantId: schema.users.tenantId,
        displayName: schema.users.displayName,
        firstName: schema.users.firstName,
        lastName: schema.users.lastName,
        status: schema.users.status,
        email: schema.userEmails.email,
      })
      .from(schema.users)
      .leftJoin(
        schema.userEmails,
        and(eq(schema.userEmails.userId, schema.users.id), eq(schema.userEmails.isPrimary, true)),
      )
      .where(inArray(schema.users.id, userIds)),
    db
      .select({ id: schema.organizations.id, name: schema.organizations.name })
      .from(schema.organizations)
      .where(inArray(schema.organizations.id, tenantIds)),
  ])
  const organizationNames = new Map(organizations.map((org) => [org.id, org.name]))
  const identities = new Map<string, ManagerIdentity>()
  for (const user of users) {
    identities.set(`${user.tenantId}:${user.id}`, {
      email: user.email ?? null,
      displayName: displayNameOf(user),
      userStatus: toGlobalUserStatus(user.status),
      organizationName: organizationNames.get(user.tenantId) ?? null,
    })
  }
  return identities
}

async function loadGrantors(
  db: Db,
  rows: readonly AssignmentRow[],
): Promise<AssignmentFacts['grantors']> {
  const grantorIds = [...new Set(rows.flatMap((row) => (row.grantedBy ? [row.grantedBy] : [])))]
  if (grantorIds.length === 0) return new Map()
  const users = await db
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
      and(eq(schema.userEmails.userId, schema.users.id), eq(schema.userEmails.isPrimary, true)),
    )
    .where(inArray(schema.users.id, grantorIds))
  return new Map(
    users.map((user) => [user.id, { displayName: displayNameOf(user), email: user.email ?? null }]),
  )
}

async function loadAssignmentFacts(
  db: Db,
  rows: readonly AssignmentRow[],
): Promise<AssignmentFacts> {
  const [identities, grantors, lastActive] = await Promise.all([
    loadManagerIdentities(db, rows),
    loadGrantors(db, rows),
    lastActiveAtByUser(
      db,
      rows.map((row) => ({ tenantId: row.tenantId, userId: row.userId })),
    ),
  ])
  return { identities, grantors, lastActive }
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
  const facts = await loadAssignmentFacts(db, dataRows)
  return c.json({
    data: dataRows.map((row) => toResponse(row, facts)),
    nextCursor: hasMore ? encodeCursor(dataRows.at(-1)!.id) : null,
    total: countRows[0]?.value ?? 0,
  })
})

// 只接受 active、未删除的账户;邮箱按组织(租户)内主邮箱精确匹配,大小写不敏感。
async function findGrantee(
  db: Db,
  body: v.InferOutput<typeof createBodySchema>,
): Promise<typeof schema.users.$inferSelect | undefined> {
  const activeUser = and(eq(schema.users.status, 'active'), isNull(schema.users.deletedAt))
  if ('user_id' in body) {
    const [user] = await db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.id, body.user_id), activeUser))
      .limit(1)
    return user
  }
  const [match] = await db
    .select({ user: schema.users })
    .from(schema.users)
    .innerJoin(
      schema.userEmails,
      and(
        eq(schema.userEmails.tenantId, schema.users.tenantId),
        eq(schema.userEmails.userId, schema.users.id),
        eq(schema.userEmails.isPrimary, true),
      ),
    )
    .where(
      and(
        eq(schema.users.tenantId, body.organization_id),
        eq(schema.userEmails.email, body.email.trim().toLowerCase()),
        activeUser,
      ),
    )
    .limit(1)
  return match?.user
}

app.post('/', async (c) => {
  const session = await requireInstanceManager(c)
  const json = await readJsonBody(c)
  if (!json.ok) throw new AppError('validation_failed', { httpStatus: 422 })
  const body = validateBody(createBodySchema, json.value)

  const db = managementDb(c.env)
  const user = await findGrantee(db, body)
  if (!user) throw new AppError('not_found', { httpStatus: 404 })
  if (user.id === session.userId) throw new AppError('forbidden', { httpStatus: 403 })
  const existing = await db
    .select({ id: schema.managerAssignments.id })
    .from(schema.managerAssignments)
    .where(and(instanceManagerFilter, eq(schema.managerAssignments.userId, user.id)))
    .limit(1)
  if (existing[0]) throw new AppError('already_exists', { httpStatus: 409 })

  const now = new Date()
  const row: AssignmentRow = {
    id: createPersistedId('managerAssignment'),
    tenantId: user.tenantId,
    userId: user.id,
    managerRole: 'instance_manager',
    scopeType: 'instance',
    scopeId: null,
    grantedBy: session.userId,
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
           id, tenant_id, user_id, manager_role, scope_type, scope_id, granted_by, created_at, updated_at
         )
         SELECT ?, ?, ?, 'instance_manager', 'instance', NULL, ?, ?, ?
          WHERE ${audit.mutationGate.sql}`,
      ).bind(
        row.id,
        row.tenantId,
        row.userId,
        row.grantedBy,
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
  return c.json(toResponse(row, await loadAssignmentFacts(db, [row])), 201)
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
