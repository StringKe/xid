// Group 成员写入:未知成员写 pending(9.1.1 OneLogin 投递顺序),删除幂等。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import { readAllById } from '../lib/db-pagination'
import { evaluateScimFilter, readElementValue } from './filter-eval'
import type { ScimFilterExpr } from './filter-parser'
import { SCIM_SCAN_BATCH_SIZE } from './list-query'
import { isRecord } from './scim-json'

type TenantDb = ReturnType<typeof createTenantDb>

export type ScimGroupPatchContext = {
  db: TenantDb
  tenantId: string
  groupId: string
  directoryId: string
}

export type GroupMemberPatch =
  | { kind: 'add'; refs: string[] }
  | { kind: 'remove'; refs: string[] }
  | { kind: 'removeWhere'; filter: ScimFilterExpr }
  | { kind: 'removeAll' }

export function memberRefs(value: unknown): string[] {
  const members = Array.isArray(value) ? value : value === undefined ? [] : [value]
  return members.flatMap((member) => {
    const ref = isRecord(member) ? readElementValue(member, ['value']) : undefined
    return typeof ref === 'string' && ref.length > 0 ? [ref] : []
  })
}

export async function findDirectoryUsersByIds(
  db: TenantDb,
  directoryId: string,
  ids: readonly string[],
): Promise<(typeof schema.directoryUsers.$inferSelect)[]> {
  const rows: (typeof schema.directoryUsers.$inferSelect)[] = []
  for (let start = 0; start < ids.length; start += SCIM_SCAN_BATCH_SIZE) {
    const baseFilter = and(
      eq(schema.directoryUsers.directoryId, directoryId),
      inArray(schema.directoryUsers.id, ids.slice(start, start + SCIM_SCAN_BATCH_SIZE)),
    )
    rows.push(
      ...(await readAllById((cursor, limit) =>
        db.directoryUsers.findMany(
          cursor ? and(baseFilter, gt(schema.directoryUsers.id, cursor)) : baseFilter,
          { orderBy: asc(schema.directoryUsers.id), limit },
        ),
      )),
    )
  }
  return rows
}

export async function addDirectoryUsersToGroup(
  context: ScimGroupPatchContext,
  refs: readonly string[],
): Promise<void> {
  const uniqueRefs = [...new Set(refs)]
  if (uniqueRefs.length === 0) return
  const users = await findDirectoryUsersByIds(context.db, context.directoryId, uniqueRefs)
  const known = new Set(users.map((user) => user.id))
  for (let start = 0; start < uniqueRefs.length; start += SCIM_SCAN_BATCH_SIZE) {
    const batch = uniqueRefs.slice(start, start + SCIM_SCAN_BATCH_SIZE)
    const memberRows = batch
      .filter((ref) => known.has(ref))
      .map((ref) => ({
        id: crypto.randomUUID(),
        tenantId: context.tenantId,
        groupId: context.groupId,
        directoryUserId: ref,
      }))
    const pendingRows = batch
      .filter((ref) => !known.has(ref))
      .map((ref) => ({
        id: crypto.randomUUID(),
        tenantId: context.tenantId,
        groupId: context.groupId,
        ref,
      }))
    if (memberRows.length > 0) await context.db.directoryGroupMembers.insertManyIgnore(memberRows)
    if (pendingRows.length > 0) {
      await context.db.directoryPendingMembers.insertManyIgnore(pendingRows)
    }
  }
}

async function removeMembersByRef(context: ScimGroupPatchContext, refs: readonly string[]) {
  for (let start = 0; start < refs.length; start += SCIM_SCAN_BATCH_SIZE) {
    const batch = refs.slice(start, start + SCIM_SCAN_BATCH_SIZE)
    await context.db.directoryGroupMembers.hardDelete(
      and(
        eq(schema.directoryGroupMembers.groupId, context.groupId),
        inArray(schema.directoryGroupMembers.directoryUserId, batch),
      ),
    )
    await context.db.directoryPendingMembers.hardDelete(
      and(
        eq(schema.directoryPendingMembers.groupId, context.groupId),
        inArray(schema.directoryPendingMembers.ref, batch),
      ),
    )
  }
}

export async function removeAllGroupMembers(context: ScimGroupPatchContext): Promise<void> {
  await context.db.directoryGroupMembers.hardDelete(
    eq(schema.directoryGroupMembers.groupId, context.groupId),
  )
  await context.db.directoryPendingMembers.hardDelete(
    eq(schema.directoryPendingMembers.groupId, context.groupId),
  )
}

async function currentMemberRefs(context: ScimGroupPatchContext): Promise<string[]> {
  const memberFilter = eq(schema.directoryGroupMembers.groupId, context.groupId)
  const members = await readAllById((cursor, limit) =>
    context.db.directoryGroupMembers.findMany(
      cursor ? and(memberFilter, gt(schema.directoryGroupMembers.id, cursor)) : memberFilter,
      { orderBy: asc(schema.directoryGroupMembers.id), limit },
    ),
  )
  const pendingFilter = eq(schema.directoryPendingMembers.groupId, context.groupId)
  const pending = await readAllById((cursor, limit) =>
    context.db.directoryPendingMembers.findMany(
      cursor ? and(pendingFilter, gt(schema.directoryPendingMembers.id, cursor)) : pendingFilter,
      { orderBy: asc(schema.directoryPendingMembers.id), limit },
    ),
  )
  return [...members.map((row) => row.directoryUserId), ...pending.map((row) => row.ref)]
}

// 仅在 group 版本 CAS 获胜后执行,使 412 保持无副作用。
export async function applyGroupMemberPatches(
  context: ScimGroupPatchContext,
  patches: readonly GroupMemberPatch[],
): Promise<void> {
  for (const patch of patches) {
    switch (patch.kind) {
      case 'add':
        await addDirectoryUsersToGroup(context, patch.refs)
        break
      case 'remove':
        await removeMembersByRef(context, patch.refs)
        break
      case 'removeAll':
        await removeAllGroupMembers(context)
        break
      case 'removeWhere': {
        const refs = (await currentMemberRefs(context)).filter((value) =>
          evaluateScimFilter(patch.filter, { value, type: 'User' }, readElementValue),
        )
        await removeMembersByRef(context, refs)
        break
      }
    }
  }
}
