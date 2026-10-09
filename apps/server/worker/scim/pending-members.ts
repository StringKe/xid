// 用户创建后把 pending group 成员关系转为正式成员(9.1.1 OneLogin 投递顺序)。
// pending 表无 directory_id 列,跨 directory 隔离靠 group 归属:pending.groupId 必须属于本 directory,
// 否则同租户多 directory 间 ref(userName)相同会交叉污染。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import { readAllById } from '../lib/db-pagination'
import { SCIM_SCAN_BATCH_SIZE } from './list-query'

export type PendingMembersContext = {
  db: ReturnType<typeof createTenantDb>
  tenantId: string
  directoryId: string
  directoryUserId: string
  userName: string
}

async function directoryGroupIds(
  context: PendingMembersContext,
  groupIds: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>()
  for (let start = 0; start < groupIds.length; start += SCIM_SCAN_BATCH_SIZE) {
    const groupFilter = and(
      eq(schema.directoryGroups.directoryId, context.directoryId),
      inArray(schema.directoryGroups.id, groupIds.slice(start, start + SCIM_SCAN_BATCH_SIZE)),
    )
    const rows = await readAllById((cursor, limit) =>
      context.db.directoryGroups.findMany(
        cursor ? and(groupFilter, gt(schema.directoryGroups.id, cursor)) : groupFilter,
        { orderBy: asc(schema.directoryGroups.id), limit },
      ),
    )
    for (const group of rows) found.add(group.id)
  }
  return found
}

export async function resolvePendingMembers(context: PendingMembersContext): Promise<void> {
  const refCandidates = [context.directoryUserId, context.userName]
  const pendingFilter = inArray(schema.directoryPendingMembers.ref, refCandidates)
  const pending = await readAllById((cursor, limit) =>
    context.db.directoryPendingMembers.findMany(
      cursor ? and(pendingFilter, gt(schema.directoryPendingMembers.id, cursor)) : pendingFilter,
      { orderBy: asc(schema.directoryPendingMembers.id), limit },
    ),
  )
  if (pending.length === 0) return

  const dirGroupIds = await directoryGroupIds(context, [
    ...new Set(pending.map((row) => row.groupId)),
  ])
  const validPending = pending.filter((row) => dirGroupIds.has(row.groupId))
  if (validPending.length === 0) return
  for (let start = 0; start < validPending.length; start += SCIM_SCAN_BATCH_SIZE) {
    await context.db.directoryGroupMembers.insertManyIgnore(
      validPending.slice(start, start + SCIM_SCAN_BATCH_SIZE).map((row) => ({
        id: crypto.randomUUID(),
        tenantId: context.tenantId,
        groupId: row.groupId,
        directoryUserId: context.directoryUserId,
      })),
    )
  }
  const validGroupIds = [...dirGroupIds]
  for (let start = 0; start < validGroupIds.length; start += SCIM_SCAN_BATCH_SIZE) {
    await context.db.directoryPendingMembers.hardDelete(
      and(
        inArray(
          schema.directoryPendingMembers.groupId,
          validGroupIds.slice(start, start + SCIM_SCAN_BATCH_SIZE),
        ),
        inArray(schema.directoryPendingMembers.ref, refCandidates),
      ),
    )
  }
}
