// SCIM 2.0 Groups 端点(/scim/v2/organizations/{organization_id}/Groups)
// 规格:docs/design/04-enterprise-sso.md 第 9 节(RFC7644)
// displayName 变更同步更新 mappedRole(04 章 5 决策)
// unknown member 幂等处理:PATCH add 指向未创建用户时写 pending_members(9.1.1)
// 租户隔离:所有查询经 @xid-kit/db 租户查询层(P0)

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, gt, inArray, isNull, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import {
  scimError,
  authBearer,
  buildGroupScimRepr,
  buildVersion,
  parsePatchOps,
  applyGroupPatch,
  applyGroupMemberPatches,
  emitWebhookAsync,
  parseScimFilter,
  evaluateScimFilter,
  getGroupFilterValue,
  parseScimSort,
  scimGroupOrderBy,
  SCIM_SCAN_BATCH_SIZE,
  addDirectoryUsersToGroup,
  readAllById,
  SCIM_GROUP_SORT_ATTRS,
  checkScimPrecondition,
  parseScimPagination,
  parseScimProjection,
  projectScimResource,
  versionGuardFromRow,
} from './shared'

const groups = new Hono<XidHonoEnv>()

type DirectoryGroupMemberRow = typeof schema.directoryGroupMembers.$inferSelect

// POST/PUT body:只锚定 displayName 必填;members 等字段由领域逻辑处理,looseObject 放行。
// 失败映射 RFC7644 scimError invalidValue,不走 XidAPIError,故用 safeParse 自映射。
const scimGroupWriteSchema = v.looseObject({
  displayName: v.pipe(v.string(), v.minLength(1)),
})

async function readGroupMembers(
  db: ReturnType<typeof createTenantDb>,
  tenantId: string,
  groupIds: readonly string[],
): Promise<DirectoryGroupMemberRow[]> {
  if (groupIds.length === 0) return []
  const baseFilter = and(
    eq(schema.directoryGroupMembers.tenantId, tenantId),
    inArray(schema.directoryGroupMembers.groupId, groupIds),
  )
  return readAllById((cursor, limit) =>
    db.directoryGroupMembers.findMany(
      cursor ? and(baseFilter, gt(schema.directoryGroupMembers.id, cursor)) : baseFilter,
      { orderBy: asc(schema.directoryGroupMembers.id), limit },
    ),
  )
}

function membersByGroup(rows: readonly DirectoryGroupMemberRow[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  for (const row of rows) {
    const members = result.get(row.groupId) ?? new Set<string>()
    members.add(row.directoryUserId)
    result.set(row.groupId, members)
  }
  return result
}

// POST /scim/v2/organizations/{organization_id}/Groups -- 创建组
groups.post('/', async (c) => {
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
  const parsed = v.safeParse(scimGroupWriteSchema, rawBody)
  if (!parsed.success) return scimError(c, 400, 'displayName is required', 'invalidValue')
  const body = parsed.output
  const displayName = body['displayName']

  const db = createTenantDb(c.env.DB, tenant)

  // 唯一性检查(同 directory 内 displayName 唯一)
  const existing = await db.directoryGroups.findOne(
    and(
      eq(schema.directoryGroups.directoryId, directory.id),
      eq(schema.directoryGroups.displayName, displayName),
      ne(schema.directoryGroups.status, 'deleted'),
    ),
  )
  if (existing) return scimError(c, 409, 'displayName already exists', 'uniqueness')

  const id = crypto.randomUUID()
  const row = await db.directoryGroups.insert({
    id,
    tenantId,
    directoryId: directory.id,
    displayName,
    status: 'active',
  })

  // 处理 members 字段(POST body 可能已含初始成员)
  const members = body['members']
  if (Array.isArray(members)) {
    await addGroupMembers({ db, tenantId, groupId: id, directoryId: directory.id }, members)
  }

  const memberRows = await readGroupMembers(db, tenantId, [id])

  const repr = buildGroupScimRepr(row, memberRows, tenantId, c.req.url)
  return c.json(projectScimResource(repr, projectionResult.projection), 201, {
    'Content-Type': 'application/scim+json',
  })
})

// GET /scim/v2/organizations/{organization_id}/Groups -- 列出组
groups.get('/', async (c) => {
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
    SCIM_GROUP_SORT_ATTRS,
  )
  if (!parsedSort.ok) return scimError(c, 400, parsedSort.detail, 'invalidValue')

  const baseFilter = and(
    eq(schema.directoryGroups.directoryId, directory.id),
    ne(schema.directoryGroups.status, 'deleted'),
    isNull(schema.directoryGroups.deletedAt),
  )
  let rows: (typeof schema.directoryGroups.$inferSelect)[]
  let total: number
  let allMemberRows: DirectoryGroupMemberRow[] = []
  const orderBy = scimGroupOrderBy(parsedSort.sortBy, parsedSort.sortOrder)
  if (!parsedFilter.expr) {
    ;[total, rows] = await Promise.all([
      db.directoryGroups.count(baseFilter),
      db.directoryGroups.findMany(baseFilter, {
        orderBy,
        limit: count,
        offset: startIndex - 1,
      }),
    ])
    allMemberRows = await readGroupMembers(
      db,
      tenantId,
      rows.map((row) => row.id),
    )
  } else {
    rows = []
    total = 0
    let offset = 0
    while (true) {
      const page = await db.directoryGroups.findMany(baseFilter, {
        orderBy,
        limit: SCIM_SCAN_BATCH_SIZE,
        offset,
      })
      if (page.length === 0) break
      const pageMemberRows = await readGroupMembers(
        db,
        tenantId,
        page.map((row) => row.id),
      )
      const pageMembersByGroup = membersByGroup(pageMemberRows)
      for (const row of page) {
        if (
          !evaluateScimFilter(parsedFilter.expr, row, (target, path) =>
            getGroupFilterValue(target, path, pageMembersByGroup.get(target.id) ?? new Set()),
          )
        ) {
          continue
        }
        total += 1
        if (total >= startIndex && rows.length < count) {
          rows.push(row)
          allMemberRows.push(...pageMemberRows.filter((member) => member.groupId === row.id))
        }
      }
      if (page.length < SCIM_SCAN_BATCH_SIZE) break
      offset += page.length
    }
  }

  const paged = rows
  const baseUrl = new URL(c.req.url)

  const resources = await Promise.all(
    paged.map(async (r) => {
      const memberRows = allMemberRows.filter((m) => m.groupId === r.id)
      return projectScimResource(
        buildGroupScimRepr(r, memberRows, tenantId, baseUrl.origin),
        projectionResult.projection,
      )
    }),
  )

  return c.json(
    {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: total,
      startIndex,
      itemsPerPage: paged.length,
      Resources: resources,
    },
    200,
    { 'Content-Type': 'application/scim+json' },
  )
})

// GET /scim/v2/organizations/{organization_id}/Groups/{id} -- 读单个组
groups.get('/:id', async (c) => {
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
  const row = await db.directoryGroups.findOne(
    and(
      eq(schema.directoryGroups.id, id),
      eq(schema.directoryGroups.directoryId, directory.id),
      ne(schema.directoryGroups.status, 'deleted'),
    ),
  )
  if (!row) return scimError(c, 404, 'Group not found')

  const memberRows = await readGroupMembers(db, tenantId, [id])

  const repr = buildGroupScimRepr(row, memberRows, tenantId, c.req.url)
  const groupVersion = (repr.meta as Record<string, unknown>)['version'] as string
  return c.json(projectScimResource(repr, projectionResult.projection), 200, {
    'Content-Type': 'application/scim+json',
    ETag: groupVersion,
  })
})

// PUT /scim/v2/organizations/{organization_id}/Groups/{id} -- 全量替换
groups.put('/:id', async (c) => {
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
  const existing = await db.directoryGroups.findOne(
    and(
      eq(schema.directoryGroups.id, id),
      eq(schema.directoryGroups.directoryId, directory.id),
      ne(schema.directoryGroups.status, 'deleted'),
    ),
  )
  if (!existing) return scimError(c, 404, 'Group not found')

  const precondition = checkScimPrecondition(c, buildVersion(existing.updatedAt), {
    requireIfMatch: true,
  })
  if (precondition) return precondition

  const rawBody = await c.req.json<Record<string, unknown>>()
  const parsed = v.safeParse(scimGroupWriteSchema, rawBody)
  if (!parsed.success) return scimError(c, 400, 'displayName is required', 'invalidValue')
  const body = parsed.output
  const displayName = body['displayName']

  // displayName 变更同步 mappedRole(04 章 5)
  const roleUpdates = existing.displayName !== displayName ? { mappedRole: null } : {}

  const updated = await db.directoryGroups.update(
    { displayName, ...roleUpdates },
    and(
      eq(schema.directoryGroups.id, id),
      eq(schema.directoryGroups.directoryId, directory.id),
      ne(schema.directoryGroups.status, 'deleted'),
      eq(schema.directoryGroups.updatedAt, versionGuardFromRow(existing.updatedAt)),
    ),
  )
  const row = updated[0]
  if (!row) return scimError(c, 412, 'Resource version mismatch')

  // 全量替换成员
  await db.directoryGroupMembers.hardDelete(eq(schema.directoryGroupMembers.groupId, id))
  const members = body['members']
  if (Array.isArray(members)) {
    await addGroupMembers({ db, tenantId, groupId: id, directoryId: directory.id }, members)
  }

  const memberRows = await readGroupMembers(db, tenantId, [id])

  const prefer = c.req.header('Prefer')
  if (prefer === 'return=minimal') return new Response(null, { status: 204 })

  const repr = buildGroupScimRepr(row, memberRows, tenantId, c.req.url)
  const version = (repr.meta as Record<string, unknown>)['version'] as string
  return c.json(projectScimResource(repr, projectionResult.projection), 200, {
    'Content-Type': 'application/scim+json',
    ETag: version,
  })
})

// PATCH /scim/v2/organizations/{organization_id}/Groups/{id} -- 增量更新(RFC7644 3.5.2)
// OneLogin quirk:PATCH add members 可能先于 User POST,幂等处理(9.1.1)
groups.patch('/:id', async (c) => {
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
  const existing = await db.directoryGroups.findOne(
    and(
      eq(schema.directoryGroups.id, id),
      eq(schema.directoryGroups.directoryId, directory.id),
      ne(schema.directoryGroups.status, 'deleted'),
    ),
  )
  if (!existing) return scimError(c, 404, 'Group not found')

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

  const staged = { displayName: existing.displayName } as Record<string, unknown>

  const patchResult = applyGroupPatch(staged, ops)
  if (!patchResult.ok) {
    return scimError(c, 400, patchResult.error.detail, patchResult.error.scimType)
  }

  // displayName 变更同步 mappedRole
  const newDisplayName =
    typeof staged['displayName'] === 'string' ? staged['displayName'] : existing.displayName
  const roleUpdates = existing.displayName !== newDisplayName ? { mappedRole: null } : {}

  const updated = await db.directoryGroups.update(
    { displayName: newDisplayName, ...roleUpdates },
    and(
      eq(schema.directoryGroups.id, id),
      eq(schema.directoryGroups.directoryId, directory.id),
      ne(schema.directoryGroups.status, 'deleted'),
      eq(schema.directoryGroups.updatedAt, versionGuardFromRow(existing.updatedAt)),
    ),
  )
  const row = updated[0]
  if (!row) return scimError(c, 412, 'Resource version mismatch')

  await applyGroupMemberPatches(
    { db, tenantId, groupId: id, directoryId: directory.id },
    patchResult.memberPatches,
  )

  const memberRows = await readGroupMembers(db, tenantId, [id])

  emitWebhookAsync(c, {
    tenantId,
    event: 'organization.updated',
    payload: { groupId: id, directoryId: directory.id },
  })

  const prefer = c.req.header('Prefer')
  if (prefer === 'return=minimal') return new Response(null, { status: 204 })

  const repr = buildGroupScimRepr(row, memberRows, tenantId, c.req.url)
  const version = (repr.meta as Record<string, unknown>)['version'] as string
  return c.json(projectScimResource(repr, projectionResult.projection), 200, {
    'Content-Type': 'application/scim+json',
    ETag: version,
  })
})

// DELETE /scim/v2/organizations/{organization_id}/Groups/{id} -- 删除组
groups.delete('/:id', async (c) => {
  const tenantId = c.req.param('organization_id')
  const tenant = c.get('tenant')
  if (tenantId !== tenant.tenantId) return scimError(c, 403, 'organization mismatch')

  const directory = await authBearer(c, tenantId)
  if (!directory) return scimError(c, 401, 'Unauthorized', { addWwwAuth: true })

  const id = c.req.param('id')
  const db = createTenantDb(c.env.DB, tenant)
  const existing = await db.directoryGroups.findOne(
    and(
      eq(schema.directoryGroups.id, id),
      eq(schema.directoryGroups.directoryId, directory.id),
      ne(schema.directoryGroups.status, 'deleted'),
    ),
  )
  if (!existing) return scimError(c, 404, 'Group not found')

  const precondition = checkScimPrecondition(c, buildVersion(existing.updatedAt))
  if (precondition) return precondition

  const deleteConditions = [
    eq(schema.directoryGroups.id, id),
    eq(schema.directoryGroups.directoryId, directory.id),
    ne(schema.directoryGroups.status, 'deleted'),
  ]
  if (c.req.header('If-Match')?.trim() && c.req.header('If-Match')?.trim() !== '*') {
    deleteConditions.push(
      eq(schema.directoryGroups.updatedAt, versionGuardFromRow(existing.updatedAt)),
    )
  }
  const deleted = await db.directoryGroups.update(
    { status: 'deleted', deletedAt: new Date() },
    and(...deleteConditions),
  )
  if (deleted.length === 0) {
    if (c.req.header('If-Match')) return scimError(c, 412, 'Resource version mismatch')
    return new Response(null, { status: 204 })
  }

  await db.directoryGroupMembers.hardDelete(eq(schema.directoryGroupMembers.groupId, id))

  return new Response(null, { status: 204 })
})

// 添加 group members,幂等处理 unknown member(9.1.1)
type GroupMembersContext = {
  db: ReturnType<typeof createTenantDb>
  tenantId: string
  groupId: string
  directoryId: string
}

async function addGroupMembers(context: GroupMembersContext, members: unknown[]): Promise<void> {
  const refs = members.flatMap((member) => {
    if (!member || typeof member !== 'object') return []
    const ref = (member as Record<string, unknown>)['value']
    return typeof ref === 'string' && ref.length > 0 ? [ref] : []
  })
  await addDirectoryUsersToGroup(
    {
      db: context.db,
      tenantId: context.tenantId,
      groupId: context.groupId,
      directoryId: context.directoryId,
    },
    refs,
  )
}

export function registerScimGroupsRoutes(app: Hono<XidHonoEnv>, basePath: string): void {
  app.route(`${basePath}/Groups`, groups)
}

export { addGroupMembers }
