// Outbound SCIM client:XID 向下游 SaaS SCIM target 推送 users/groups。
// 与 inbound `/scim/v2/organizations/:organization_id/*` 分离,避免方向混淆。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, gt, inArray, isNull, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { trimLeadingSlashes, trimTrailingSlashes } from '../../shared/url'
import { AppError } from '../lib/errors'
import { readAllById } from '../lib/db-pagination'
import { filterMembershipsByAssignmentGate, parseAssignmentGate } from '../sso/assignment-gate'
import type { SessionData, XidHonoEnv } from '../lib/types'
import { requireOrgManager } from '../v1/shared'

type ScimTarget = typeof schema.scimTargets.$inferSelect
type UserRow = typeof schema.users.$inferSelect
type UserEmailRow = typeof schema.userEmails.$inferSelect
type MembershipRow = typeof schema.memberships.$inferSelect

const USER_BATCH_SIZE = 100

const outbound = new Hono<XidHonoEnv>()
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User'
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group'
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'

type SyncSummary = {
  targetId: string
  provider: string
  users: number
  groups: number
  deactivations: number
}

function requireSession(c: Context<XidHonoEnv>): SessionData {
  const session = c.get('session')
  if (!session || session.status !== 'active') {
    throw new AppError('unauthorized', { httpStatus: 401 })
  }
  return session
}

function requiredParam(c: Context<XidHonoEnv>, name: string): string {
  const value = c.req.param(name)
  if (!value) throw new AppError('invalid_request', { httpStatus: 400 })
  return value
}

async function resolveTarget(c: Context<XidHonoEnv>, targetId: string): Promise<ScimTarget> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const target = await db.scimTargets.findOne(
    and(eq(schema.scimTargets.id, targetId), eq(schema.scimTargets.status, 'active')),
  )
  if (!target) throw new AppError('not_found', { httpStatus: 404 })
  return target
}

function secretValue(env: Env, ref: string): string {
  const value = (env as unknown as Record<string, unknown>)[ref]
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('validation_failed', { httpStatus: 422 })
  }
  return value
}

function endpoint(target: ScimTarget, path: string): string {
  return `${trimTrailingSlashes(target.baseUrl)}/${trimLeadingSlashes(path)}`
}

async function scimFetch(
  target: ScimTarget,
  token: string,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('Content-Type', 'application/scim+json')
  const res = await fetch(endpoint(target, path), { ...init, headers })
  if (res.status < 200 || res.status >= 300) {
    const detail = await res.text()
    throw new AppError('service_unavailable', {
      httpStatus: 502,
      longMessage: `outbound_scim_failed:${res.status}:${detail.slice(0, 120)}`,
    })
  }
  return res
}

async function primaryEmails(
  c: Context<XidHonoEnv>,
  users: readonly UserRow[],
): Promise<Map<string, UserEmailRow>> {
  if (users.length === 0) return new Map()
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const filter = inArray(
    schema.userEmails.userId,
    users.map((user) => user.id),
  )
  const rows = await readAllById((cursor, limit) =>
    db.userEmails.findMany(cursor ? and(filter, gt(schema.userEmails.id, cursor)) : filter, {
      orderBy: asc(schema.userEmails.id),
      limit,
    }),
  )
  const byUser = new Map<string, UserEmailRow[]>()
  for (const row of rows) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row])
  const out = new Map<string, UserEmailRow>()
  for (const user of users) {
    const candidates = byUser.get(user.id) ?? []
    const email =
      candidates.find((candidate) => candidate.id === user.primaryEmailId) ??
      candidates.find((candidate) => candidate.isPrimary) ??
      candidates[0]
    if (email) out.set(user.id, email)
  }
  return out
}

function scimUser(user: UserRow, email: UserEmailRow | undefined): Record<string, unknown> {
  const emailValue = email?.email ?? user.username ?? user.id
  return {
    schemas: [USER_SCHEMA],
    externalId: user.id,
    userName: emailValue,
    active: user.status === 'active' && !user.deletedAt,
    name: {
      givenName: user.firstName ?? '',
      familyName: user.lastName ?? '',
      formatted: user.displayName ?? '',
    },
    emails: [{ value: emailValue, primary: true }],
  }
}

async function membershipsForOrg(c: Context<XidHonoEnv>, orgId: string): Promise<MembershipRow[]> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const rows: MembershipRow[] = []
  let cursor: string | null = null
  while (true) {
    const after = cursor ? gt(schema.memberships.id, cursor) : undefined
    const page = await db.memberships.findMany(
      after
        ? and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.status, 'active'), after)
        : and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.status, 'active')),
      { orderBy: asc(schema.memberships.id), limit: USER_BATCH_SIZE },
    )
    if (page.length === 0) break
    rows.push(...page)
    cursor = page[page.length - 1]?.id ?? null
    if (page.length < USER_BATCH_SIZE) break
  }
  return rows
}

function groupedMemberships(memberships: readonly MembershipRow[]): Map<string, MembershipRow[]> {
  const out = new Map<string, MembershipRow[]>()
  for (const membership of memberships) {
    const key = membership.role || 'member'
    const existing = out.get(key) ?? []
    existing.push(membership)
    out.set(key, existing)
  }
  return out
}

function scimGroup(role: string, memberships: readonly MembershipRow[]): Record<string, unknown> {
  return {
    schemas: [GROUP_SCHEMA],
    externalId: `role:${role}`,
    displayName: role,
    members: memberships.map((membership) => ({
      value: membership.userId,
      display: membership.userId,
    })),
  }
}

async function syncUsers(
  c: Context<XidHonoEnv>,
  target: ScimTarget,
  token: string,
  users: readonly UserRow[],
): Promise<{ users: number; deactivations: number }> {
  const emails = await primaryEmails(c, users)
  let deactivations = 0
  for (const user of users) {
    const body = scimUser(user, emails.get(user.id))
    const res = await scimFetch(target, token, '/Users', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    const created = (await res.json()) as { id?: unknown }
    if (body['active'] === false && typeof created.id === 'string') {
      deactivations += 1
      await scimFetch(target, token, `/Users/${encodeURIComponent(created.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          schemas: [PATCH_SCHEMA],
          Operations: [{ op: 'replace', path: 'active', value: false }],
        }),
      })
    }
  }
  return { users: users.length, deactivations }
}

async function syncGroupsWithMemberships(
  _c: Context<XidHonoEnv>,
  target: ScimTarget,
  token: string,
  memberships: readonly MembershipRow[],
): Promise<number> {
  const groups = groupedMemberships(memberships)
  for (const [role, groupMemberships] of groups.entries()) {
    await scimFetch(target, token, '/Groups', {
      method: 'POST',
      body: JSON.stringify(scimGroup(role, groupMemberships)),
    })
  }
  return groups.size
}

export async function syncScimTarget(
  c: Context<XidHonoEnv>,
  target: ScimTarget,
): Promise<SyncSummary> {
  const db = createTenantDb(c.env.DB, c.get('tenant'))
  const gate = parseAssignmentGate(target.userFilter as Record<string, unknown>)
  const token = secretValue(c.env, target.tokenSecretRef)
  const memberships = await membershipsForOrg(c, target.orgId)
  const filteredMemberships = await filterMembershipsByAssignmentGate(db, {
    orgId: target.orgId,
    memberships,
    gate,
  })
  const allowedUserIds = new Set(filteredMemberships.map((membership) => membership.userId))
  const baseFilter = and(ne(schema.users.status, 'deleted'), isNull(schema.users.deletedAt))
  let cursor: string | null = null
  let syncedUsers = 0
  let deactivations = 0
  while (true) {
    const after = cursor ? gt(schema.users.id, cursor) : undefined
    const users = await db.users.findMany(after ? and(baseFilter, after) : baseFilter, {
      orderBy: asc(schema.users.id),
      limit: USER_BATCH_SIZE,
    })
    if (users.length === 0) break
    const eligibleUsers =
      gate.mode === 'restricted' ? users.filter((user) => allowedUserIds.has(user.id)) : users
    const result = await syncUsers(c, target, token, eligibleUsers)
    syncedUsers += result.users
    deactivations += result.deactivations
    cursor = users[users.length - 1]?.id ?? null
    if (users.length < USER_BATCH_SIZE) break
  }
  const groupCount = await syncGroupsWithMemberships(c, target, token, filteredMemberships)
  await db.scimTargets.update({ lastSyncAt: new Date() }, eq(schema.scimTargets.id, target.id))
  return {
    targetId: target.id,
    provider: target.provider,
    users: syncedUsers,
    groups: groupCount,
    deactivations,
  }
}

outbound.post('/:targetId/sync', async (c) => {
  // 触发全量推送(含 deactivation 写下游)必须是 org admin/owner 或 org_manager,普通 member 只读不放行。
  requireSession(c)
  const target = await resolveTarget(c, requiredParam(c, 'targetId'))
  await requireOrgManager(c, target.orgId)
  return c.json(await syncScimTarget(c, target), 200)
})

export function registerOutboundScimRoutes(app: Hono<XidHonoEnv>): void {
  app.route('/scim/outbound', outbound)
}
