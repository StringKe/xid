// SCIM 2.0 Users 端点(/scim/v2/organizations/{organization_id}/Users)
// 规格:docs/design/04-enterprise-sso.md 第 9 节(RFC7644)
// 租户隔离:所有查询经 @xid-kit/db 租户查询层,directory_id 额外过滤(P0)
// deprovisioning 序列:active=false 同步撤销 session+refresh,异步 webhook+审计(9.1.2)
// Bearer token:SHA-256 哈希存储,constant-time 比对,30min 宽限(9.2)

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, gt, inArray, isNull, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import {
  scimError,
  authBearer,
  readAllById,
  buildUserScimRepr,
  buildVersion,
  parsePatchOps,
  applyUserPatch,
  revokeAllUserSessions,
  emitWebhookAsync,
  parseScimFilter,
  evaluateScimFilter,
  getUserFilterValue,
  parseScimSort,
  scimUserOrderBy,
  SCIM_SCAN_BATCH_SIZE,
  SCIM_USER_SORT_ATTRS,
  checkScimPrecondition,
  parseScimPagination,
  parseScimProjection,
  projectScimResource,
  versionGuardFromRow,
} from './shared'

// organization_id 来自路径参数,须与 TenantContext 一致(双重验证,见 tenant-isolation rule)
const users = new Hono<XidHonoEnv>()

// POST/PUT body:只锚定 userName 必填;scimRaw 整体落库,looseObject 放行其余字段不丢数据。
// 失败映射 RFC7644 scimError invalidValue,不走 XidAPIError,故用 safeParse 自映射。
const scimUserWriteSchema = v.looseObject({
  userName: v.pipe(v.string(), v.minLength(1)),
})

// POST /scim/v2/organizations/{organization_id}/Users -- 创建用户
users.post('/', async (c) => {
  const tenantId = c.req.param('organization_id')
  const tenant = c.get('tenant')
  if (tenantId !== tenant.tenantId) return scimError(c, 403, 'organization mismatch')

  const directory = await authBearer(c, tenantId)
  if (!directory) return scimError(c, 401, 'Unauthorized', { addWwwAuth: true })
  const projectionResult = parseScimProjection(
    c.req.query('attributes'),
    c.req.query('excludedAttributes'),
  )
  if (!projectionResult.ok) {
    return scimError(c, 400, projectionResult.error.detail, projectionResult.error.scimType)
  }

  const rawBody = await c.req.json<Record<string, unknown>>()
  const parsed = v.safeParse(scimUserWriteSchema, rawBody)
  if (!parsed.success) return scimError(c, 400, 'userName is required', 'invalidValue')
  const body = parsed.output
  const userName = body['userName']

  const db = createTenantDb(c.env.DB, tenant)

  // 唯一性检查(同 directory 内 userName 唯一)
  const existing = await db.directoryUsers.findOne(
    and(
      eq(schema.directoryUsers.directoryId, directory.id),
      eq(schema.directoryUsers.userName, userName),
      ne(schema.directoryUsers.status, 'deleted'),
    ),
  )
  if (existing) return scimError(c, 409, 'userName already exists', 'uniqueness')

  const id = crypto.randomUUID()
  const externalId = typeof body['externalId'] === 'string' ? body['externalId'] : null
  const activeVal = body['active'] !== false

  const row = await db.directoryUsers.insert({
    id,
    tenantId,
    directoryId: directory.id,
    userName,
    externalId: externalId ?? undefined,
    active: activeVal,
    status: activeVal ? 'active' : 'deactivated',
    scimRaw: body,
  })

  // pending members 回填:如有该 userName 或 id 对应的 pending member,补建 group member
  // (按 directory.id 约束,避免同租户多 directory 交叉,见 resolvePendingMembers 注释)。
  await resolvePendingMembers({
    db,
    tenantId,
    directoryId: directory.id,
    directoryUserId: id,
    userName,
  })

  const repr = buildUserScimRepr(row, tenantId, c.req.url)
  return c.json(projectScimResource(repr, projectionResult.projection), 201, {
    'Content-Type': 'application/scim+json',
  })
})

// GET /scim/v2/organizations/{organization_id}/Users -- 列出用户(filter/startIndex/count)
users.get('/', async (c) => {
  const tenantId = c.req.param('organization_id')
  const tenant = c.get('tenant')
  if (tenantId !== tenant.tenantId) return scimError(c, 403, 'organization mismatch')

  const directory = await authBearer(c, tenantId)
  if (!directory) return scimError(c, 401, 'Unauthorized', { addWwwAuth: true })
  const projectionResult = parseScimProjection(
    c.req.query('attributes'),
    c.req.query('excludedAttributes'),
  )
  if (!projectionResult.ok) {
    return scimError(c, 400, projectionResult.error.detail, projectionResult.error.scimType)
  }

  const db = createTenantDb(c.env.DB, tenant)
  const filter = c.req.query('filter')
  const parsedPagination = parseScimPagination(c.req.query('startIndex'), c.req.query('count'))
  if (!parsedPagination.ok) {
    return scimError(c, 400, parsedPagination.detail, 'invalidValue')
  }
  const { startIndex, count } = parsedPagination
  const parsedFilter = parseScimFilter(filter)
  if (!parsedFilter.ok) return scimError(c, 400, parsedFilter.detail, 'invalidFilter')
  const parsedSort = parseScimSort(
    c.req.query('sortBy'),
    c.req.query('sortOrder'),
    SCIM_USER_SORT_ATTRS,
  )
  if (!parsedSort.ok) return scimError(c, 400, parsedSort.detail, 'invalidValue')

  const baseFilter = and(
    eq(schema.directoryUsers.directoryId, directory.id),
    ne(schema.directoryUsers.status, 'deleted'),
    isNull(schema.directoryUsers.deletedAt),
  )
  let rows: (typeof schema.directoryUsers.$inferSelect)[]
  let total: number
  const orderBy = scimUserOrderBy(parsedSort.sortBy, parsedSort.sortOrder)
  if (!parsedFilter.expr) {
    ;[total, rows] = await Promise.all([
      db.directoryUsers.count(baseFilter),
      db.directoryUsers.findMany(baseFilter, {
        orderBy,
        limit: count,
        offset: startIndex - 1,
      }),
    ])
  } else {
    rows = []
    total = 0
    let offset = 0
    while (true) {
      const page = await db.directoryUsers.findMany(baseFilter, {
        orderBy,
        limit: SCIM_SCAN_BATCH_SIZE,
        offset,
      })
      for (const row of page) {
        if (
          !evaluateScimFilter(parsedFilter.expr, row, (target, path) =>
            getUserFilterValue(target, path),
          )
        ) {
          continue
        }
        total += 1
        if (total >= startIndex && rows.length < count) rows.push(row)
      }
      if (page.length < SCIM_SCAN_BATCH_SIZE) break
      offset += page.length
    }
  }

  const paged = rows
  const baseUrl = new URL(c.req.url)

  return c.json(
    {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: total,
      startIndex,
      itemsPerPage: paged.length,
      Resources: paged.map((r) =>
        projectScimResource(
          buildUserScimRepr(r, tenantId, baseUrl.origin),
          projectionResult.projection,
        ),
      ),
    },
    200,
    { 'Content-Type': 'application/scim+json' },
  )
})

// GET /scim/v2/organizations/{organization_id}/Users/{id} -- 读单个用户
users.get('/:id', async (c) => {
  const tenantId = c.req.param('organization_id')
  const tenant = c.get('tenant')
  if (tenantId !== tenant.tenantId) return scimError(c, 403, 'organization mismatch')

  const directory = await authBearer(c, tenantId)
  if (!directory) return scimError(c, 401, 'Unauthorized', { addWwwAuth: true })
  const projectionResult = parseScimProjection(
    c.req.query('attributes'),
    c.req.query('excludedAttributes'),
  )
  if (!projectionResult.ok) {
    return scimError(c, 400, projectionResult.error.detail, projectionResult.error.scimType)
  }

  const id = c.req.param('id')
  const db = createTenantDb(c.env.DB, tenant)
  const row = await db.directoryUsers.findOne(
    and(
      eq(schema.directoryUsers.id, id),
      eq(schema.directoryUsers.directoryId, directory.id),
      ne(schema.directoryUsers.status, 'deleted'),
    ),
  )
  if (!row) return scimError(c, 404, 'User not found')

  const repr = buildUserScimRepr(row, tenantId, c.req.url)
  const version = (repr.meta as Record<string, unknown>)['version'] as string
  return c.json(projectScimResource(repr, projectionResult.projection), 200, {
    'Content-Type': 'application/scim+json',
    ETag: version,
  })
})

// PUT /scim/v2/organizations/{organization_id}/Users/{id} -- 全量替换
users.put('/:id', async (c) => {
  const tenantId = c.req.param('organization_id')
  const tenant = c.get('tenant')
  if (tenantId !== tenant.tenantId) return scimError(c, 403, 'organization mismatch')

  const directory = await authBearer(c, tenantId)
  if (!directory) return scimError(c, 401, 'Unauthorized', { addWwwAuth: true })
  const projectionResult = parseScimProjection(
    c.req.query('attributes'),
    c.req.query('excludedAttributes'),
  )
  if (!projectionResult.ok) {
    return scimError(c, 400, projectionResult.error.detail, projectionResult.error.scimType)
  }

  const id = c.req.param('id')
  const db = createTenantDb(c.env.DB, tenant)
  const existing = await db.directoryUsers.findOne(
    and(
      eq(schema.directoryUsers.id, id),
      eq(schema.directoryUsers.directoryId, directory.id),
      ne(schema.directoryUsers.status, 'deleted'),
    ),
  )
  if (!existing) return scimError(c, 404, 'User not found')

  const precondition = checkScimPrecondition(c, buildVersion(existing.updatedAt), {
    requireIfMatch: true,
  })
  if (precondition) return precondition

  const rawBody = await c.req.json<Record<string, unknown>>()
  const parsed = v.safeParse(scimUserWriteSchema, rawBody)
  if (!parsed.success) return scimError(c, 400, 'userName is required', 'invalidValue')
  const body = parsed.output
  const userName = body['userName']

  const wasActive = existing.active
  const newActive = body['active'] !== false

  const updated = await db.directoryUsers.update(
    {
      userName,
      externalId: typeof body['externalId'] === 'string' ? body['externalId'] : undefined,
      active: newActive,
      status: newActive ? 'active' : 'deactivated',
      scimRaw: body,
    },
    and(
      eq(schema.directoryUsers.id, id),
      eq(schema.directoryUsers.directoryId, directory.id),
      ne(schema.directoryUsers.status, 'deleted'),
      eq(schema.directoryUsers.updatedAt, versionGuardFromRow(existing.updatedAt)),
    ),
  )
  const row = updated[0]
  if (!row) return scimError(c, 412, 'Resource version mismatch')

  // deprovisioning(9.1.2):active 从 true -> false 时同步撤销 session
  if (wasActive && !newActive && existing.userId) {
    await revokeAllUserSessions(c.env, tenant, existing.userId)
    emitWebhookAsync(c, {
      tenantId,
      event: 'user.deactivated',
      payload: { userId: existing.userId, directoryId: directory.id, orgId: directory.orgId },
    })
  }

  const prefer = c.req.header('Prefer')
  if (prefer === 'return=minimal') return new Response(null, { status: 204 })

  const repr = buildUserScimRepr(row, tenantId, c.req.url)
  const version = (repr.meta as Record<string, unknown>)['version'] as string
  return c.json(projectScimResource(repr, projectionResult.projection), 200, {
    'Content-Type': 'application/scim+json',
    ETag: version,
  })
})

// PATCH /scim/v2/organizations/{organization_id}/Users/{id} -- 增量更新(RFC7644 3.5.2)
users.patch('/:id', async (c) => {
  const tenantId = c.req.param('organization_id')
  const tenant = c.get('tenant')
  if (tenantId !== tenant.tenantId) return scimError(c, 403, 'organization mismatch')

  const directory = await authBearer(c, tenantId)
  if (!directory) return scimError(c, 401, 'Unauthorized', { addWwwAuth: true })
  const projectionResult = parseScimProjection(
    c.req.query('attributes'),
    c.req.query('excludedAttributes'),
  )
  if (!projectionResult.ok) {
    return scimError(c, 400, projectionResult.error.detail, projectionResult.error.scimType)
  }

  const id = c.req.param('id')
  const db = createTenantDb(c.env.DB, tenant)
  const existing = await db.directoryUsers.findOne(
    and(
      eq(schema.directoryUsers.id, id),
      eq(schema.directoryUsers.directoryId, directory.id),
      ne(schema.directoryUsers.status, 'deleted'),
    ),
  )
  if (!existing) return scimError(c, 404, 'User not found')

  const precondition = checkScimPrecondition(c, buildVersion(existing.updatedAt), {
    requireIfMatch: true,
  })
  if (precondition) return precondition

  const body = await c.req.json<Record<string, unknown>>()
  const schemas = body['schemas']
  if (
    !Array.isArray(schemas) ||
    !schemas.includes('urn:ietf:params:scim:api:messages:2.0:PatchOp')
  ) {
    return scimError(c, 400, 'Missing PatchOp schema', 'invalidSyntax')
  }

  const ops = parsePatchOps(body['Operations'])
  if (ops === null) return scimError(c, 400, 'Invalid Operations', 'invalidSyntax')

  const wasActive = existing.active
  const staged: Record<string, unknown> = {
    ...(existing.scimRaw as Record<string, unknown>),
    active: existing.active,
  }

  const patchResult = applyUserPatch(staged, ops)
  if (!patchResult.ok) {
    return scimError(c, 400, patchResult.error.detail, patchResult.error.scimType)
  }

  const newActive = staged['active'] !== false

  const updated = await db.directoryUsers.update(
    {
      userName: typeof staged['userName'] === 'string' ? staged['userName'] : existing.userName,
      active: newActive,
      status: newActive ? 'active' : 'deactivated',
      scimRaw: staged,
    },
    and(
      eq(schema.directoryUsers.id, id),
      eq(schema.directoryUsers.directoryId, directory.id),
      ne(schema.directoryUsers.status, 'deleted'),
      eq(schema.directoryUsers.updatedAt, versionGuardFromRow(existing.updatedAt)),
    ),
  )
  const row = updated[0]
  if (!row) return scimError(c, 412, 'Resource version mismatch')

  // deprovisioning(9.1.2)
  if (wasActive && !newActive && existing.userId) {
    await revokeAllUserSessions(c.env, tenant, existing.userId)
    emitWebhookAsync(c, {
      tenantId,
      event: 'user.deactivated',
      payload: { userId: existing.userId, directoryId: directory.id, orgId: directory.orgId },
    })
  }

  const prefer = c.req.header('Prefer')
  if (prefer === 'return=minimal') return new Response(null, { status: 204 })

  const repr = buildUserScimRepr(row, tenantId, c.req.url)
  const version = (repr.meta as Record<string, unknown>)['version'] as string
  return c.json(projectScimResource(repr, projectionResult.projection), 200, {
    'Content-Type': 'application/scim+json',
    ETag: version,
  })
})

// DELETE /scim/v2/organizations/{organization_id}/Users/{id} -- deprovision + soft delete
users.delete('/:id', async (c) => {
  const tenantId = c.req.param('organization_id')
  const tenant = c.get('tenant')
  if (tenantId !== tenant.tenantId) return scimError(c, 403, 'organization mismatch')

  const directory = await authBearer(c, tenantId)
  if (!directory) return scimError(c, 401, 'Unauthorized', { addWwwAuth: true })

  const id = c.req.param('id')
  const db = createTenantDb(c.env.DB, tenant)
  const existing = await db.directoryUsers.findOne(
    and(
      eq(schema.directoryUsers.id, id),
      eq(schema.directoryUsers.directoryId, directory.id),
      ne(schema.directoryUsers.status, 'deleted'),
    ),
  )
  if (!existing) return scimError(c, 404, 'User not found')

  const precondition = checkScimPrecondition(c, buildVersion(existing.updatedAt))
  if (precondition) return precondition

  const deleteConditions = [
    eq(schema.directoryUsers.id, id),
    eq(schema.directoryUsers.directoryId, directory.id),
    ne(schema.directoryUsers.status, 'deleted'),
  ]
  if (c.req.header('If-Match')?.trim() && c.req.header('If-Match')?.trim() !== '*') {
    deleteConditions.push(
      eq(schema.directoryUsers.updatedAt, versionGuardFromRow(existing.updatedAt)),
    )
  }
  const sessionUserId =
    existing.userId && (existing.active || existing.status === 'deprovisioning')
      ? existing.userId
      : null
  const requiresSessionRevocation = sessionUserId !== null
  const transitioned = await db.directoryUsers.update(
    requiresSessionRevocation
      ? { active: false, status: 'deprovisioning', deletedAt: null }
      : { active: false, status: 'deleted', deletedAt: new Date() },
    and(...deleteConditions),
  )
  if (transitioned.length === 0) {
    if (c.req.header('If-Match')) return scimError(c, 412, 'Resource version mismatch')
    return new Response(null, { status: 204 })
  }

  if (requiresSessionRevocation) {
    await db.users.update(
      { status: 'deactivated' },
      and(eq(schema.users.id, sessionUserId), eq(schema.users.status, 'active')),
    )

    try {
      await revokeAllUserSessions(c.env, tenant, sessionUserId)
    } catch {
      return scimError(c, 503, 'Session revocation unavailable')
    }

    const finalized = await db.directoryUsers.update(
      { status: 'deleted', deletedAt: new Date() },
      and(
        eq(schema.directoryUsers.id, id),
        eq(schema.directoryUsers.directoryId, directory.id),
        eq(schema.directoryUsers.status, 'deprovisioning'),
      ),
    )
    if (finalized.length === 0) return scimError(c, 409, 'User deprovisioning state changed')
  }

  if (existing.userId) {
    emitWebhookAsync(c, {
      tenantId,
      event: 'user.deleted',
      payload: { userId: existing.userId, directoryId: directory.id, orgId: directory.orgId },
    })
  }

  return new Response(null, { status: 204 })
})

// 回填 pending members:用户创建后将 pending group 成员关系转为正式成员(OneLogin quirk)。
// pending 表无 directory_id 列,跨 directory 隔离靠 group 归属:pending.groupId 必须属于本 directory,
// 否则同租户多 directory 间 ref(userName)相同会交叉污染(见 tenant-isolation rule directory_id 过滤)。
type PendingMembersContext = {
  db: ReturnType<typeof createTenantDb>
  tenantId: string
  directoryId: string
  directoryUserId: string
  userName: string
}

async function resolvePendingMembers(context: PendingMembersContext): Promise<void> {
  // pending members 可能以 userName 或 directoryUserId 作 ref
  const refCandidates = [context.directoryUserId, context.userName]
  const pendingFilter = inArray(schema.directoryPendingMembers.ref, refCandidates)
  const pending = await readAllById((cursor, limit) =>
    context.db.directoryPendingMembers.findMany(
      cursor ? and(pendingFilter, gt(schema.directoryPendingMembers.id, cursor)) : pendingFilter,
      { orderBy: asc(schema.directoryPendingMembers.id), limit },
    ),
  )
  if (pending.length === 0) return

  const groupIds = [...new Set(pending.map((row) => row.groupId))]
  const dirGroupIds = new Set<string>()
  for (let start = 0; start < groupIds.length; start += SCIM_SCAN_BATCH_SIZE) {
    const groupBatch = groupIds.slice(start, start + SCIM_SCAN_BATCH_SIZE)
    const groupFilter = and(
      eq(schema.directoryGroups.directoryId, context.directoryId),
      inArray(schema.directoryGroups.id, groupBatch),
    )
    const dirGroups = await readAllById((cursor, limit) =>
      context.db.directoryGroups.findMany(
        cursor ? and(groupFilter, gt(schema.directoryGroups.id, cursor)) : groupFilter,
        { orderBy: asc(schema.directoryGroups.id), limit },
      ),
    )
    for (const group of dirGroups) dirGroupIds.add(group.id)
  }
  const validPending = pending.filter((row) => dirGroupIds.has(row.groupId))
  if (validPending.length === 0) return
  for (let start = 0; start < validPending.length; start += SCIM_SCAN_BATCH_SIZE) {
    const pendingBatch = validPending.slice(start, start + SCIM_SCAN_BATCH_SIZE)
    await context.db.directoryGroupMembers.insertManyIgnore(
      pendingBatch.map((row) => ({
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

export function registerScimUsersRoutes(app: Hono<XidHonoEnv>, basePath: string): void {
  app.route(`${basePath}/Users`, users)
}

export { resolvePendingMembers }
