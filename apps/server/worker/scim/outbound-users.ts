// 出站 SCIM 的用户侧:同步范围内的成员与账号、用户资源体、下游停用。

import { schema } from '@xid-kit/db'
import { and, asc, eq, gt, inArray, isNull, ne } from 'drizzle-orm'
import { readAllById } from '../lib/db-pagination'
import { filterMembershipsByAssignmentGate, parseAssignmentGate } from '../sso/assignment-gate'
import { scimFetch, upsertResource } from './outbound-client'
import { persistMapping } from './outbound-mapping'
import type { ScimTargetResource, SyncRuntime } from './outbound-mapping'

type UserRow = typeof schema.users.$inferSelect
type UserEmailRow = typeof schema.userEmails.$inferSelect
export type MembershipRow = typeof schema.memberships.$inferSelect

// D1 单条查询最多 100 个绑定参数,tenant_id 与 deleted 状态各占一个。
export const USER_ID_QUERY_BATCH_SIZE = 98

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User'
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'

const liveUserFilter = and(ne(schema.users.status, 'deleted'), isNull(schema.users.deletedAt))

export async function liveUsers(
  runtime: SyncRuntime,
  userIds: readonly string[],
): Promise<UserRow[]> {
  const rows: UserRow[] = []
  for (let start = 0; start < userIds.length; start += USER_ID_QUERY_BATCH_SIZE) {
    rows.push(
      ...(await runtime.db.users.findMany(
        and(
          liveUserFilter,
          inArray(schema.users.id, userIds.slice(start, start + USER_ID_QUERY_BATCH_SIZE)),
        ),
        { orderBy: asc(schema.users.id) },
      )),
    )
  }
  return rows
}

async function primaryEmails(
  runtime: SyncRuntime,
  users: readonly UserRow[],
): Promise<Map<string, UserEmailRow>> {
  if (users.length === 0) return new Map()
  const filter = inArray(
    schema.userEmails.userId,
    users.map((user) => user.id),
  )
  const rows = await readAllById((cursor, limit) =>
    runtime.db.userEmails.findMany(
      cursor ? and(filter, gt(schema.userEmails.id, cursor)) : filter,
      { orderBy: asc(schema.userEmails.id), limit },
    ),
  )
  const out = new Map<string, UserEmailRow>()
  for (const user of users) {
    const candidates = rows.filter((row) => row.userId === user.id)
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

// 返回下游已停用的用户数;downstreamUserIds 收集本次写入的下游 id。
export async function syncUsers(
  runtime: SyncRuntime,
  users: readonly UserRow[],
  downstreamUserIds: Map<string, string>,
): Promise<number> {
  const emails = await primaryEmails(runtime, users)
  let deactivations = 0
  for (const user of users) {
    const body = scimUser(user, emails.get(user.id))
    const active = body['active'] === true
    const downstreamId = await upsertResource(runtime, {
      resourceType: 'User',
      localResourceId: user.id,
      externalId: user.id,
      body,
      status: active ? 'active' : 'deprovisioned',
    })
    downstreamUserIds.set(user.id, downstreamId)
    if (!active) deactivations += 1
  }
  return deactivations
}

export async function deactivateDownstreamUser(
  runtime: SyncRuntime,
  mapping: ScimTargetResource,
): Promise<void> {
  await scimFetch({
    environment: runtime.env.ENVIRONMENT,
    target: runtime.target,
    token: runtime.token,
    path: `/Users/${encodeURIComponent(mapping.downstreamId)}`,
    init: {
      method: 'PATCH',
      body: JSON.stringify({
        schemas: [PATCH_SCHEMA],
        Operations: [{ op: 'replace', path: 'active', value: false }],
      }),
    },
    // 远端已删是期望的解配状态,本地持久化 404,避免重试毒化。
    acceptedStatuses: [404],
  })
}

export async function markDeprovisioned(
  runtime: SyncRuntime,
  mapping: ScimTargetResource,
): Promise<void> {
  await persistMapping({
    db: runtime.db,
    target: runtime.target,
    resourceType: mapping.resourceType,
    localResourceId: mapping.localResourceId,
    externalId: mapping.externalId,
    downstreamId: mapping.downstreamId,
    status: 'deprovisioned',
    existing: mapping,
  })
}

// limit 给出时只读一页(全量对账的一批),否则读全部。
export async function activeOrgMemberships(
  runtime: SyncRuntime,
  page?: { after?: string; limit: number },
): Promise<MembershipRow[]> {
  const base = and(
    eq(schema.memberships.orgId, runtime.target.orgId),
    eq(schema.memberships.status, 'active'),
  )
  const read = (cursor: string | null | undefined, limit: number) =>
    runtime.db.memberships.findMany(cursor ? and(base, gt(schema.memberships.id, cursor)) : base, {
      orderBy: asc(schema.memberships.id),
      limit,
    })
  if (page) return read(page.after, page.limit)
  return readAllById(read)
}

export async function gatedMemberships(
  runtime: SyncRuntime,
  memberships: readonly MembershipRow[],
): Promise<MembershipRow[]> {
  return filterMembershipsByAssignmentGate(runtime.db, {
    orgId: runtime.target.orgId,
    memberships,
    gate: parseAssignmentGate(runtime.target.userFilter as Record<string, unknown>),
  })
}
