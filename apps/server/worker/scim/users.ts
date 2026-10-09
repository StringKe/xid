// SCIM 2.0 Users 端点(/scim/v2/organizations/{organization_id}/Users),RFC 7644。
// 规格:docs/design/04-enterprise-sso.md 第 9 节;User 绑定、停用与恢复见 user-lifecycle.ts。
// 租户隔离:所有查询经 @xid-kit/db 租户查询层,directory_id 额外过滤(P0)。

import { schema } from '@xid-kit/db'
import { and, eq, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import { applyUserPatch, readScimPatchOps } from './patch'
import { resolvePendingMembers } from './pending-members'
import { projectScimResource } from './projection'
import { buildUserScimRepr, buildVersion, scimResourceHeaders, versionGuardFromRow } from './repr'
import { openScimRequest } from './route-context'
import type { ScimRequestContext } from './route-context'
import { readAttribute } from './scim-json'
import { checkScimPrecondition, emitWebhookAsync, readScimJson, scimError } from './shared'
import { normalizeScimActive, stripScimWriteOnlyAttributes } from './user-attributes'
import { createDirectoryUser, deactivateLinkedAccount, updateDirectoryUser } from './user-lifecycle'
import { listScimUsers } from './user-list'
import { suspendDirectoryMembership } from './user-provisioning'

const users = new Hono<XidHonoEnv>()

// POST/PUT body 只锚定 userName 必填,其余属性放行后经 stripScimWriteOnlyAttributes 落库。
// 失败映射 RFC 7644 scimError invalidValue,不走 XidAPIError,故用 safeParse 自映射。
const scimUserWriteSchema = v.looseObject({
  userName: v.pipe(v.string(), v.minLength(1)),
})

type DirectoryUserRecord = typeof schema.directoryUsers.$inferSelect

async function findLiveUser(
  ctx: ScimRequestContext,
  id: string,
): Promise<DirectoryUserRecord | undefined> {
  return ctx.db.directoryUsers.findOne(
    and(
      eq(schema.directoryUsers.id, id),
      eq(schema.directoryUsers.directoryId, ctx.directory.id),
      ne(schema.directoryUsers.status, 'deleted'),
    ),
  )
}

function userResponse(
  c: Context<XidHonoEnv>,
  ctx: ScimRequestContext,
  row: DirectoryUserRecord,
  status: 200 | 201,
): Response {
  const repr = buildUserScimRepr(row, ctx.tenantId, c.req.url)
  const headers = scimResourceHeaders(repr)
  if (status === 200) delete headers['Location']
  return c.json(projectScimResource(repr, ctx.projection), status, headers)
}

users.post('/', async (c) => {
  const opened = await openScimRequest(c)
  if (!opened.ok) return opened.error
  const ctx = opened.value

  const rawBody = await readScimJson(c)
  if (!rawBody.ok) return rawBody.error
  const parsed = v.safeParse(scimUserWriteSchema, rawBody.value)
  if (!parsed.success) return scimError(c, 400, 'userName is required', 'invalidValue')
  const body = parsed.output
  const active = normalizeScimActive(body['active'])
  if (active === null) return scimError(c, 400, 'active must be a boolean', 'invalidValue')

  const created = await createDirectoryUser(
    { c, tenant: ctx.tenant, directory: ctx.directory },
    {
      userName: body.userName,
      externalId: typeof body['externalId'] === 'string' ? body['externalId'] : null,
      active,
      scimRaw: stripScimWriteOnlyAttributes(body),
    },
  )
  if (!created.ok) return created.error

  await resolvePendingMembers({
    db: ctx.db,
    tenantId: ctx.tenantId,
    directoryId: ctx.directory.id,
    directoryUserId: created.value.id,
    userName: body.userName,
  })
  return userResponse(c, ctx, created.value, 201)
})

users.get('/', async (c) => {
  const opened = await openScimRequest(c)
  if (!opened.ok) return opened.error
  return listScimUsers(c, opened.value)
})

users.get('/:id', async (c) => {
  const opened = await openScimRequest(c)
  if (!opened.ok) return opened.error
  const row = await findLiveUser(opened.value, c.req.param('id'))
  if (!row) return scimError(c, 404, 'User not found')
  return userResponse(c, opened.value, row, 200)
})

users.put('/:id', async (c) => {
  const opened = await openScimRequest(c)
  if (!opened.ok) return opened.error
  const ctx = opened.value
  const existing = await findLiveUser(ctx, c.req.param('id'))
  if (!existing) return scimError(c, 404, 'User not found')
  const precondition = checkScimPrecondition(c, buildVersion(existing.updatedAt))
  if (precondition) return precondition

  const rawBody = await readScimJson(c)
  if (!rawBody.ok) return rawBody.error
  const parsed = v.safeParse(scimUserWriteSchema, rawBody.value)
  if (!parsed.success) return scimError(c, 400, 'userName is required', 'invalidValue')
  const body = parsed.output
  const active = normalizeScimActive(body['active'])
  if (active === null) return scimError(c, 400, 'active must be a boolean', 'invalidValue')

  const updated = await updateDirectoryUser(
    { c, tenant: ctx.tenant, directory: ctx.directory },
    existing,
    {
      userName: body.userName,
      externalId: typeof body['externalId'] === 'string' ? body['externalId'] : undefined,
      active,
      scimRaw: stripScimWriteOnlyAttributes(body),
    },
  )
  if (!updated.ok) return updated.error
  if (c.req.header('Prefer') === 'return=minimal') return new Response(null, { status: 204 })
  return userResponse(c, ctx, updated.value, 200)
})

// RFC 7644 3.5.2:staged 预置当前 active / userName / externalId,操作后缺失即视为被移除。
users.patch('/:id', async (c) => {
  const opened = await openScimRequest(c)
  if (!opened.ok) return opened.error
  const ctx = opened.value
  const existing = await findLiveUser(ctx, c.req.param('id'))
  if (!existing) return scimError(c, 404, 'User not found')
  const precondition = checkScimPrecondition(c, buildVersion(existing.updatedAt))
  if (precondition) return precondition

  const patchOps = await readScimPatchOps(c)
  if (!patchOps.ok) return patchOps.error

  const staged: Record<string, unknown> = {
    ...existing.scimRaw,
    userName: existing.userName,
    active: existing.active,
  }
  if (existing.externalId !== null) staged['externalId'] = existing.externalId
  const patchResult = applyUserPatch(staged, patchOps.value, existing.id)
  if (!patchResult.ok) {
    return scimError(c, 400, patchResult.error.detail, patchResult.error.scimType)
  }
  const active = normalizeScimActive(readAttribute(staged, 'active'))
  if (active === null) return scimError(c, 400, 'active must be a boolean', 'invalidValue')
  const userName = readAttribute(staged, 'userName')
  if (typeof userName !== 'string' || userName.length === 0) {
    return scimError(c, 400, 'userName is required', 'invalidValue')
  }
  const externalId = readAttribute(staged, 'externalId')

  const updated = await updateDirectoryUser(
    { c, tenant: ctx.tenant, directory: ctx.directory },
    existing,
    {
      userName,
      externalId: typeof externalId === 'string' ? externalId : null,
      active,
      scimRaw: stripScimWriteOnlyAttributes(staged),
    },
  )
  if (!updated.ok) return updated.error
  if (c.req.header('Prefer') === 'return=minimal') return new Response(null, { status: 204 })
  return userResponse(c, ctx, updated.value, 200)
})

// deprovision + soft delete
users.delete('/:id', async (c) => {
  const opened = await openScimRequest(c)
  if (!opened.ok) return opened.error
  const ctx = opened.value
  const id = c.req.param('id')
  const existing = await findLiveUser(ctx, id)
  if (!existing) return scimError(c, 404, 'User not found')
  const precondition = checkScimPrecondition(c, buildVersion(existing.updatedAt))
  if (precondition) return precondition

  const ifMatch = c.req.header('If-Match')?.trim()
  const deleteConditions = [
    eq(schema.directoryUsers.id, id),
    eq(schema.directoryUsers.directoryId, ctx.directory.id),
    ne(schema.directoryUsers.status, 'deleted'),
  ]
  if (ifMatch && ifMatch !== '*') {
    deleteConditions.push(
      eq(schema.directoryUsers.updatedAt, versionGuardFromRow(existing.updatedAt)),
    )
  }
  const sessionUserId =
    existing.userId && (existing.active || existing.status === 'deprovisioning')
      ? existing.userId
      : null
  const transitioned = await ctx.db.directoryUsers.update(
    sessionUserId !== null
      ? { active: false, status: 'deprovisioning', deletedAt: null }
      : { active: false, status: 'deleted', deletedAt: new Date() },
    and(...deleteConditions),
  )
  if (transitioned.length === 0) {
    if (c.req.header('If-Match')) return scimError(c, 412, 'Resource version mismatch')
    return new Response(null, { status: 204 })
  }

  if (sessionUserId !== null) {
    const scope = { c, tenant: ctx.tenant, directory: ctx.directory }
    const failure = await deactivateLinkedAccount(scope, {
      userId: sessionUserId,
      reason: 'deleted',
    })
    if (failure) return failure
    const finalized = await ctx.db.directoryUsers.update(
      { status: 'deleted', deletedAt: new Date() },
      and(
        eq(schema.directoryUsers.id, id),
        eq(schema.directoryUsers.directoryId, ctx.directory.id),
        eq(schema.directoryUsers.status, 'deprovisioning'),
      ),
    )
    if (finalized.length === 0) return scimError(c, 409, 'User deprovisioning state changed')
  } else if (existing.userId) {
    await suspendDirectoryMembership(
      { db: ctx.db, tenantId: ctx.tenant.tenantId, orgId: ctx.directory.orgId },
      existing.userId,
    )
  }

  if (existing.userId) {
    emitWebhookAsync(c, {
      tenantId: ctx.tenantId,
      event: 'user.deleted',
      payload: {
        userId: existing.userId,
        directoryId: ctx.directory.id,
        orgId: ctx.directory.orgId,
      },
    })
  }
  return new Response(null, { status: 204 })
})

export function registerScimUsersRoutes(app: Hono<XidHonoEnv>, basePath: string): void {
  app.route(`${basePath}/Users`, users)
}
