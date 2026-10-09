// 出站 SCIM 同步:单用户增量同步,以及按成员游标分批、可断点续传的全量对账。
// 下游调用见 outbound-client.ts;组按成员角色固定映射为 role:<role>。

import { createTenantDb, schema } from '@xid-kit/db'
import type { OrganizationMembershipRole, TenantContext } from '@xid-kit/types'
import { and, eq } from 'drizzle-orm'
import { scimFetch, upsertResource } from './outbound-client'
import { findMapping, targetMappings } from './outbound-mapping'
import type { ScimTarget, ScimTargetResource, SyncRuntime } from './outbound-mapping'
import {
  activeOrgMemberships,
  deactivateDownstreamUser,
  gatedMemberships,
  liveUsers,
  markDeprovisioned,
  syncUsers,
  USER_ID_QUERY_BATCH_SIZE,
} from './outbound-users'
import type { MembershipRow } from './outbound-users'
import { requireScimTargetToken } from './target-credentials'

// 全量对账每条队列消息处理的成员数;失败重试只重做当前这一批。
export const FULL_SYNC_CHUNK_SIZE = USER_ID_QUERY_BATCH_SIZE

const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group'

export type SyncSummary = {
  targetId: string
  provider: string
  users: number
  groups: number
  deactivations: number
  // 还有未处理的成员时返回,调用方以此游标入队下一批。
  nextCursor?: string
}

type SyncTargetInput = { env: Env; tenant: TenantContext; target: ScimTarget }

async function openRuntime(input: SyncTargetInput): Promise<SyncRuntime> {
  return {
    ...input,
    db: createTenantDb(input.env.DB, input.tenant),
    token: await requireScimTargetToken(input.env, input.target),
  }
}

function roleGroup(
  role: string,
  memberships: readonly MembershipRow[],
  downstreamUserIds: ReadonlyMap<string, string>,
): Record<string, unknown> {
  return {
    schemas: [GROUP_SCHEMA],
    externalId: `role:${role}`,
    displayName: role,
    members: memberships.flatMap((membership) => {
      const downstreamId = downstreamUserIds.get(membership.userId)
      return downstreamId ? [{ value: downstreamId, display: membership.userId }] : []
    }),
  }
}

async function clearDownstreamGroup(
  runtime: SyncRuntime,
  mapping: ScimTargetResource,
): Promise<void> {
  const role = mapping.localResourceId.replace(/^role:/, '')
  await scimFetch({
    environment: runtime.env.ENVIRONMENT,
    target: runtime.target,
    token: runtime.token,
    path: `/Groups/${encodeURIComponent(mapping.downstreamId)}`,
    init: { method: 'PUT', body: JSON.stringify(roleGroup(role, [], new Map())) },
    acceptedStatuses: [404],
  })
}

type ReconcileResult = { groups: number; deactivations: number }

// 组成员只从本地映射表取下游 id,不对每个用户发请求;includeUsers 时同时停用已不在范围内的用户映射。
async function reconcileGroups(
  runtime: SyncRuntime,
  options: { syncedUserIds: ReadonlyMap<string, string>; includeUsers: boolean },
): Promise<ReconcileResult> {
  const memberships = await gatedMemberships(runtime, await activeOrgMemberships(runtime))
  const userIds = [...new Set(memberships.map((membership) => membership.userId))]
  const currentUsers = new Set((await liveUsers(runtime, userIds)).map((user) => user.id))
  const mappings = await targetMappings(runtime.db, runtime.target)
  const downstreamUserIds = new Map<string, string>()
  for (const mapping of mappings) {
    if (mapping.resourceType === 'User' && currentUsers.has(mapping.localResourceId)) {
      downstreamUserIds.set(mapping.localResourceId, mapping.downstreamId)
    }
  }
  for (const [userId, downstreamId] of options.syncedUserIds) {
    downstreamUserIds.set(userId, downstreamId)
  }

  const byRole = new Map<OrganizationMembershipRole, MembershipRow[]>()
  for (const membership of memberships) {
    if (!currentUsers.has(membership.userId)) continue
    const role: OrganizationMembershipRole = membership.role || 'member'
    byRole.set(role, [...(byRole.get(role) ?? []), membership])
  }
  const currentGroupIds = new Set<string>()
  for (const [role, roleMemberships] of byRole) {
    const localResourceId = `role:${role}`
    currentGroupIds.add(localResourceId)
    await upsertResource(runtime, {
      resourceType: 'Group',
      localResourceId,
      externalId: localResourceId,
      body: roleGroup(role, roleMemberships, downstreamUserIds),
      status: 'active',
    })
  }

  let deactivations = 0
  for (const mapping of mappings) {
    if (mapping.status !== 'active') continue
    if (mapping.resourceType === 'User') {
      if (!options.includeUsers || currentUsers.has(mapping.localResourceId)) continue
      await deactivateDownstreamUser(runtime, mapping)
      deactivations += 1
    } else {
      if (currentGroupIds.has(mapping.localResourceId)) continue
      await clearDownstreamGroup(runtime, mapping)
    }
    await markDeprovisioned(runtime, mapping)
  }
  return { groups: currentGroupIds.size, deactivations }
}

// 全量对账的一批:按成员 id 游标推进;最后一批再做组与过期映射的对账。
export async function executeScimTargetSync(
  input: SyncTargetInput & { cursor?: string },
): Promise<SyncSummary> {
  const runtime = await openRuntime(input)
  const page = await activeOrgMemberships(runtime, {
    after: input.cursor,
    limit: FULL_SYNC_CHUNK_SIZE,
  })
  const allowed = await gatedMemberships(runtime, page)
  const users = await liveUsers(runtime, [
    ...new Set(allowed.map((membership) => membership.userId)),
  ])
  const syncedUserIds = new Map<string, string>()
  const userDeactivations = await syncUsers(runtime, users, syncedUserIds)
  const summary = {
    targetId: input.target.id,
    provider: input.target.provider,
    users: users.length,
  }
  const last = page[page.length - 1]
  if (page.length === FULL_SYNC_CHUNK_SIZE && last) {
    return { ...summary, groups: 0, deactivations: userDeactivations, nextCursor: last.id }
  }
  const reconciled = await reconcileGroups(runtime, { syncedUserIds, includeUsers: true })
  await runtime.db.scimTargets.update(
    { lastSyncAt: new Date() },
    eq(schema.scimTargets.id, input.target.id),
  )
  return {
    ...summary,
    groups: reconciled.groups,
    deactivations: userDeactivations + reconciled.deactivations,
  }
}

// 单个用户的账号状态或成员关系变化:只推送该用户,再按本地映射刷新角色组。
export async function executeScimUserSync(
  input: SyncTargetInput & { userId: string },
): Promise<SyncSummary> {
  const runtime = await openRuntime(input)
  const membership = await runtime.db
    .forOrg(input.target.orgId)
    .memberships.findOne(
      and(eq(schema.memberships.userId, input.userId), eq(schema.memberships.status, 'active')),
    )
  const allowed = membership ? await gatedMemberships(runtime, [membership]) : []
  const [user] = allowed.length > 0 ? await liveUsers(runtime, [input.userId]) : []
  const syncedUserIds = new Map<string, string>()
  let deactivations = 0
  if (user) {
    deactivations += await syncUsers(runtime, [user], syncedUserIds)
  } else {
    const mapping = await findMapping(runtime.db, input.target, 'User', input.userId)
    if (mapping?.status === 'active') {
      await deactivateDownstreamUser(runtime, mapping)
      await markDeprovisioned(runtime, mapping)
      deactivations += 1
    }
  }
  const reconciled = await reconcileGroups(runtime, { syncedUserIds, includeUsers: false })
  return {
    targetId: input.target.id,
    provider: input.target.provider,
    users: user ? 1 : 0,
    groups: reconciled.groups,
    deactivations: deactivations + reconciled.deactivations,
  }
}
