// SCIM 2.0 Groups 端点(/scim/v2/organizations/{organization_id}/Groups),RFC 7644。
// 规格:docs/design/04-enterprise-sso.md 第 9 节;未知成员写 pending(9.1.1)。
// 租户隔离:所有查询经 @xid-kit/db 租户查询层(P0)。

import { schema } from '@xid-kit/db'
import { and, eq, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import { createPersistedId } from '../lib/persisted-id'
import type { XidHonoEnv } from '../lib/types'
import { listScimGroups, readGroupMembers } from './group-list'
import {
  addDirectoryUsersToGroup,
  applyGroupMemberPatches,
  memberRefs,
  removeAllGroupMembers,
} from './group-members'
import { applyGroupPatch } from './group-patch'
import { readScimPatchOps } from './patch-paths'
import { projectScimResource } from './projection'
import { buildGroupScimRepr, buildVersion, scimResourceHeaders, versionGuardFromRow } from './repr'
import { openScimRequest } from './route-context'
import type { ScimRequestContext } from './route-context'
import { checkScimPrecondition, isUniqueConstraintError, readScimJson, scimError } from './shared'
import { directoryGroupNameTaken } from './uniqueness'

const groups = new Hono<XidHonoEnv>()

type DirectoryGroupRecord = typeof schema.directoryGroups.$inferSelect

// POST/PUT body 只锚定 displayName 必填;members 由成员逻辑处理。
const scimGroupWriteSchema = v.looseObject({
  displayName: v.pipe(v.string(), v.minLength(1)),
})

async function findLiveGroup(
  ctx: ScimRequestContext,
  id: string,
): Promise<DirectoryGroupRecord | undefined> {
  return ctx.db.directoryGroups.findOne(
    and(
      eq(schema.directoryGroups.id, id),
      eq(schema.directoryGroups.directoryId, ctx.directory.id),
      ne(schema.directoryGroups.status, 'deleted'),
    ),
  )
}

async function groupResponse(
  c: Context<XidHonoEnv>,
  ctx: ScimRequestContext,
  row: DirectoryGroupRecord,
  status: 200 | 201,
): Promise<Response> {
  const memberRows = await readGroupMembers(ctx.db, [row.id])
  const repr = buildGroupScimRepr(row, memberRows, ctx.tenantId, c.req.url)
  const headers = scimResourceHeaders(repr)
  if (status === 200) delete headers['Location']
  return c.json(projectScimResource(repr, ctx.projection), status, headers)
}

function nameTaken(c: Context<XidHonoEnv>): Response {
  return scimError(c, 409, 'displayName already exists', 'uniqueness')
}

// 并发写入越过预检时由部分唯一索引兜底,只把唯一冲突映射为 409。
async function writeGroup<T>(
  c: Context<XidHonoEnv>,
  write: () => Promise<T>,
): Promise<T | Response> {
  try {
    return await write()
  } catch (error) {
    if (isUniqueConstraintError(error)) return nameTaken(c)
    throw error
  }
}

function memberContext(ctx: ScimRequestContext, groupId: string) {
  return { db: ctx.db, tenantId: ctx.tenantId, groupId, directoryId: ctx.directory.id }
}

async function updateGroupName(
  ctx: ScimRequestContext,
  existing: DirectoryGroupRecord,
  displayName: string,
): Promise<DirectoryGroupRecord[]> {
  return ctx.db.directoryGroups.update(
    { displayName },
    and(
      eq(schema.directoryGroups.id, existing.id),
      eq(schema.directoryGroups.directoryId, ctx.directory.id),
      ne(schema.directoryGroups.status, 'deleted'),
      eq(schema.directoryGroups.updatedAt, versionGuardFromRow(existing.updatedAt)),
    ),
  )
}

async function renameConflicts(
  ctx: ScimRequestContext,
  existing: DirectoryGroupRecord,
  displayName: string,
): Promise<boolean> {
  if (displayName.toLowerCase() === existing.displayName.toLowerCase()) return false
  return directoryGroupNameTaken(
    ctx.db,
    { directoryId: ctx.directory.id, excludeId: existing.id },
    displayName,
  )
}

groups.post('/', async (c) => {
  const opened = await openScimRequest(c)
  if (!opened.ok) return opened.error
  const ctx = opened.value
  const rawBody = await readScimJson(c)
  if (!rawBody.ok) return rawBody.error
  const parsed = v.safeParse(scimGroupWriteSchema, rawBody.value)
  if (!parsed.success) return scimError(c, 400, 'displayName is required', 'invalidValue')
  const displayName = parsed.output.displayName

  if (await directoryGroupNameTaken(ctx.db, { directoryId: ctx.directory.id }, displayName)) {
    return nameTaken(c)
  }
  const id = createPersistedId('directoryGroup')
  const row = await writeGroup(c, () =>
    ctx.db.directoryGroups.insert({
      id,
      tenantId: ctx.tenantId,
      directoryId: ctx.directory.id,
      displayName,
      status: 'active',
    }),
  )
  if (row instanceof Response) return row
  await addDirectoryUsersToGroup(memberContext(ctx, id), memberRefs(parsed.output['members']))
  return groupResponse(c, ctx, row, 201)
})

groups.get('/', async (c) => {
  const opened = await openScimRequest(c)
  if (!opened.ok) return opened.error
  return listScimGroups(c, opened.value)
})

groups.get('/:id', async (c) => {
  const opened = await openScimRequest(c)
  if (!opened.ok) return opened.error
  const row = await findLiveGroup(opened.value, c.req.param('id'))
  if (!row) return scimError(c, 404, 'Group not found')
  return groupResponse(c, opened.value, row, 200)
})

groups.put('/:id', async (c) => {
  const opened = await openScimRequest(c)
  if (!opened.ok) return opened.error
  const ctx = opened.value
  const existing = await findLiveGroup(ctx, c.req.param('id'))
  if (!existing) return scimError(c, 404, 'Group not found')
  const precondition = checkScimPrecondition(c, buildVersion(existing.updatedAt))
  if (precondition) return precondition

  const rawBody = await readScimJson(c)
  if (!rawBody.ok) return rawBody.error
  const parsed = v.safeParse(scimGroupWriteSchema, rawBody.value)
  if (!parsed.success) return scimError(c, 400, 'displayName is required', 'invalidValue')
  const displayName = parsed.output.displayName
  if (await renameConflicts(ctx, existing, displayName)) return nameTaken(c)

  const updated = await writeGroup(c, () => updateGroupName(ctx, existing, displayName))
  if (updated instanceof Response) return updated
  const row = updated[0]
  if (!row) return scimError(c, 412, 'Resource version mismatch')

  const members = memberContext(ctx, existing.id)
  await removeAllGroupMembers(members)
  await addDirectoryUsersToGroup(members, memberRefs(parsed.output['members']))
  if (c.req.header('Prefer') === 'return=minimal') return new Response(null, { status: 204 })
  return groupResponse(c, ctx, row, 200)
})

groups.patch('/:id', async (c) => {
  const opened = await openScimRequest(c)
  if (!opened.ok) return opened.error
  const ctx = opened.value
  const existing = await findLiveGroup(ctx, c.req.param('id'))
  if (!existing) return scimError(c, 404, 'Group not found')
  const precondition = checkScimPrecondition(c, buildVersion(existing.updatedAt))
  if (precondition) return precondition

  const patchOps = await readScimPatchOps(c)
  if (!patchOps.ok) return patchOps.error
  const patchResult = applyGroupPatch(patchOps.value, existing.id)
  if (!patchResult.ok) {
    return scimError(c, 400, patchResult.error.detail, patchResult.error.scimType)
  }
  const displayName = patchResult.plan.displayName ?? existing.displayName
  if (await renameConflicts(ctx, existing, displayName)) return nameTaken(c)

  const updated = await writeGroup(c, () => updateGroupName(ctx, existing, displayName))
  if (updated instanceof Response) return updated
  const row = updated[0]
  if (!row) return scimError(c, 412, 'Resource version mismatch')

  await applyGroupMemberPatches(memberContext(ctx, existing.id), patchResult.plan.memberPatches)
  if (c.req.header('Prefer') === 'return=minimal') return new Response(null, { status: 204 })
  return groupResponse(c, ctx, row, 200)
})

groups.delete('/:id', async (c) => {
  const opened = await openScimRequest(c)
  if (!opened.ok) return opened.error
  const ctx = opened.value
  const existing = await findLiveGroup(ctx, c.req.param('id'))
  if (!existing) return scimError(c, 404, 'Group not found')
  const precondition = checkScimPrecondition(c, buildVersion(existing.updatedAt))
  if (precondition) return precondition

  const ifMatch = c.req.header('If-Match')?.trim()
  const deleteConditions = [
    eq(schema.directoryGroups.id, existing.id),
    eq(schema.directoryGroups.directoryId, ctx.directory.id),
    ne(schema.directoryGroups.status, 'deleted'),
  ]
  if (ifMatch && ifMatch !== '*') {
    deleteConditions.push(
      eq(schema.directoryGroups.updatedAt, versionGuardFromRow(existing.updatedAt)),
    )
  }
  const deleted = await ctx.db.directoryGroups.update(
    { status: 'deleted', deletedAt: new Date() },
    and(...deleteConditions),
  )
  if (deleted.length === 0) {
    if (c.req.header('If-Match')) return scimError(c, 412, 'Resource version mismatch')
    return new Response(null, { status: 204 })
  }
  await removeAllGroupMembers(memberContext(ctx, existing.id))
  return new Response(null, { status: 204 })
})

export function registerScimGroupsRoutes(app: Hono<XidHonoEnv>, basePath: string): void {
  app.route(`${basePath}/Groups`, groups)
}
