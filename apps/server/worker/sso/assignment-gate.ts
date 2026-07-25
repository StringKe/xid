// 下游 SaaS assignment gate:按 org/app 限制可 SSO 或 SCIM 同步的用户与角色。
// 存于 attributeMapping / userFilter 的 `_xidAssignmentGate` 键,不进入 SAML assertion 或 SCIM filter 表达式。

import { schema } from '@xid-kit/db'
import type { createTenantDb } from '@xid-kit/db'
import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import { AppError } from '../lib/errors'
import { readAllById } from '../lib/db-pagination'

export const ASSIGNMENT_GATE_KEY = '_xidAssignmentGate'
const ASSIGNMENT_GATE_BATCH_SIZE = 100

export type AssignmentGate = {
  mode: 'all' | 'restricted'
  allowedUserIds: readonly string[]
  allowedRoles: readonly string[]
}

type TenantDb = ReturnType<typeof createTenantDb>

export function defaultAssignmentGate(): AssignmentGate {
  return { mode: 'all', allowedUserIds: [], allowedRoles: [] }
}

export function parseAssignmentGate(container: Record<string, unknown>): AssignmentGate {
  const raw = container[ASSIGNMENT_GATE_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultAssignmentGate()
  const gate = raw as Record<string, unknown>
  const mode = gate.mode === 'restricted' ? 'restricted' : 'all'
  const allowedUserIds = readStringList(gate.allowed_user_ids ?? gate.allowedUserIds)
  const allowedRoles = readStringList(gate.allowed_roles ?? gate.allowedRoles)
  return { mode, allowedUserIds, allowedRoles }
}

export function assignmentGateFromBody(body: Record<string, unknown>): AssignmentGate | null {
  const raw = body.assignment_gate ?? body.assignmentGate
  if (raw === undefined) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'assignment_gate' },
    })
  }
  const gate = raw as Record<string, unknown>
  const mode = gate.mode === 'restricted' ? 'restricted' : gate.mode === 'all' ? 'all' : null
  if (!mode) {
    throw new AppError('validation_failed', {
      httpStatus: 422,
      meta: { paramName: 'assignment_gate.mode' },
    })
  }
  return {
    mode,
    allowedUserIds: readStringList(gate.allowed_user_ids ?? gate.allowedUserIds),
    allowedRoles: readStringList(gate.allowed_roles ?? gate.allowedRoles),
  }
}

export function serializeAssignmentGate(gate: AssignmentGate): Record<string, unknown> {
  return {
    mode: gate.mode,
    allowed_user_ids: [...gate.allowedUserIds],
    allowed_roles: [...gate.allowedRoles],
  }
}

export function withAssignmentGate(
  container: Record<string, unknown>,
  gate: AssignmentGate,
): Record<string, unknown> {
  return { ...container, [ASSIGNMENT_GATE_KEY]: serializeAssignmentGate(gate) }
}

export function withoutAssignmentGate(container: Record<string, unknown>): Record<string, unknown> {
  const { [ASSIGNMENT_GATE_KEY]: _removed, ...rest } = container
  return rest
}

export async function assertUserPassesAssignmentGate(
  db: TenantDb,
  input: { orgId: string; userId: string; gate: AssignmentGate },
): Promise<void> {
  if (input.gate.mode !== 'restricted') return

  if (input.gate.allowedUserIds.includes(input.userId)) return

  if (input.gate.allowedRoles.length > 0) {
    const membership = await db.memberships.findOne(
      and(
        eq(schema.memberships.orgId, input.orgId),
        eq(schema.memberships.userId, input.userId),
        eq(schema.memberships.status, 'active'),
      ),
    )
    if (membership && input.gate.allowedRoles.includes(membership.role)) return
  }

  throw new AppError('access_denied', { httpStatus: 403 })
}

export async function filterMembershipsByAssignmentGate(
  _db: TenantDb,
  input: {
    orgId: string
    memberships: readonly (typeof schema.memberships.$inferSelect)[]
    gate: AssignmentGate
  },
): Promise<(typeof schema.memberships.$inferSelect)[]> {
  if (input.gate.mode !== 'restricted') return [...input.memberships]

  const allowedUserIds = new Set(input.gate.allowedUserIds)
  const allowedRoles = new Set(input.gate.allowedRoles)

  return input.memberships.filter((membership) => {
    if (allowedUserIds.has(membership.userId)) return true
    return allowedRoles.has(membership.role)
  })
}

export async function filterUsersByAssignmentGate(
  db: TenantDb,
  input: {
    orgId: string
    users: readonly (typeof schema.users.$inferSelect)[]
    gate: AssignmentGate
  },
): Promise<(typeof schema.users.$inferSelect)[]> {
  if (input.gate.mode !== 'restricted') return [...input.users]

  if (input.users.length === 0) return []
  const memberships: (typeof schema.memberships.$inferSelect)[] = []
  for (let start = 0; start < input.users.length; start += ASSIGNMENT_GATE_BATCH_SIZE) {
    const userIds = input.users
      .slice(start, start + ASSIGNMENT_GATE_BATCH_SIZE)
      .map((user) => user.id)
    const filter = and(
      eq(schema.memberships.orgId, input.orgId),
      eq(schema.memberships.status, 'active'),
      inArray(schema.memberships.userId, userIds),
    )
    memberships.push(
      ...(await readAllById((cursor, limit) =>
        db.memberships.findMany(cursor ? and(filter, gt(schema.memberships.id, cursor)) : filter, {
          orderBy: asc(schema.memberships.id),
          limit,
        }),
      )),
    )
  }
  const allowed = await filterMembershipsByAssignmentGate(db, {
    orgId: input.orgId,
    memberships,
    gate: input.gate,
  })
  const allowedUserIds = new Set(allowed.map((row) => row.userId))
  return input.users.filter((user) => allowedUserIds.has(user.id))
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}
