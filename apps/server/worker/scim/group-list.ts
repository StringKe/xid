// GET /Groups 列表:filter(含 members[value eq "x"])、排序、分页(RFC 7644 3.4.2)。

import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import { readAllById } from '../lib/db-pagination'
import type { XidHonoEnv } from '../lib/types'
import {
  evaluateScimFilter,
  getGroupFilterValue,
  pushDownScimFilter,
  SCIM_GROUP_FILTER_COLUMNS,
} from './filter-eval'
import { parseScimFilter } from './filter-parser'
import {
  parseScimPagination,
  parseScimSort,
  scanScimList,
  SCIM_GROUP_SORT_ATTRS,
  SCIM_SCAN_BATCH_SIZE,
  scimGroupListOrder,
  scimOrderBy,
} from './list-query'
import { projectScimResource } from './projection'
import { buildGroupScimRepr } from './repr'
import type { ScimRequestContext } from './route-context'
import { SCIM_JSON_HEADERS, scimError } from './shared'
import { LIVE_DIRECTORY_GROUP } from './uniqueness'

type DirectoryGroupRecord = typeof schema.directoryGroups.$inferSelect
type DirectoryGroupMemberRow = typeof schema.directoryGroupMembers.$inferSelect

export async function readGroupMembers(
  db: ReturnType<typeof createTenantDb>,
  groupIds: readonly string[],
): Promise<DirectoryGroupMemberRow[]> {
  const rows: DirectoryGroupMemberRow[] = []
  for (let start = 0; start < groupIds.length; start += SCIM_SCAN_BATCH_SIZE) {
    const baseFilter = inArray(
      schema.directoryGroupMembers.groupId,
      groupIds.slice(start, start + SCIM_SCAN_BATCH_SIZE),
    )
    rows.push(
      ...(await readAllById((cursor, limit) =>
        db.directoryGroupMembers.findMany(
          cursor ? and(baseFilter, gt(schema.directoryGroupMembers.id, cursor)) : baseFilter,
          { orderBy: asc(schema.directoryGroupMembers.id), limit },
        ),
      )),
    )
  }
  return rows
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

export async function listScimGroups(
  c: Context<XidHonoEnv>,
  ctx: ScimRequestContext,
): Promise<Response> {
  const pagination = parseScimPagination(c.req.query('startIndex'), c.req.query('count'))
  if (!pagination.ok) return scimError(c, 400, pagination.detail, 'invalidValue')
  const { startIndex, count } = pagination
  const parsedFilter = parseScimFilter(c.req.query('filter'))
  if (!parsedFilter.ok) return scimError(c, 400, parsedFilter.detail, 'invalidFilter')
  const parsedSort = parseScimSort(
    c.req.query('sortBy'),
    c.req.query('sortOrder'),
    SCIM_GROUP_SORT_ATTRS,
  )
  if (!parsedSort.ok) return scimError(c, 400, parsedSort.detail, 'invalidValue')

  const baseFilter = and(
    eq(schema.directoryGroups.directoryId, ctx.directory.id),
    LIVE_DIRECTORY_GROUP,
  )
  const order = scimGroupListOrder(parsedSort.sortBy, parsedSort.sortOrder)
  const orderBy = scimOrderBy(order)
  const filterExpr = parsedFilter.expr
  const pushdown = filterExpr
    ? pushDownScimFilter(filterExpr, SCIM_GROUP_FILTER_COLUMNS)
    : { where: undefined, complete: true }
  const where = and(baseFilter, pushdown.where)
  let rows: DirectoryGroupRecord[]
  let total: number
  let memberRows: DirectoryGroupMemberRow[] = []
  if (!filterExpr || pushdown.complete) {
    ;[total, rows] = await Promise.all([
      ctx.db.directoryGroups.count(where),
      ctx.db.directoryGroups.findMany(where, { orderBy, limit: count, offset: startIndex - 1 }),
    ])
    memberRows = await readGroupMembers(
      ctx.db,
      rows.map((row) => row.id),
    )
  } else {
    const matched: DirectoryGroupRecord[] = []
    let matchedTotal = 0
    await scanScimList(
      order,
      (after) =>
        ctx.db.directoryGroups.findMany(and(where, after), {
          orderBy,
          limit: SCIM_SCAN_BATCH_SIZE,
        }),
      async (page) => {
        const pageMembers = await readGroupMembers(
          ctx.db,
          page.map((row) => row.id),
        )
        const pageMembersByGroup = membersByGroup(pageMembers)
        for (const row of page) {
          const memberIds = pageMembersByGroup.get(row.id) ?? new Set<string>()
          const matches = evaluateScimFilter(filterExpr, row, (target, path) =>
            getGroupFilterValue(target, path, memberIds),
          )
          if (!matches) continue
          matchedTotal += 1
          if (matchedTotal >= startIndex && matched.length < count) {
            matched.push(row)
            memberRows.push(...pageMembers.filter((member) => member.groupId === row.id))
          }
        }
      },
    )
    rows = matched
    total = matchedTotal
  }

  const origin = new URL(c.req.url).origin
  return c.json(
    {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: total,
      startIndex,
      itemsPerPage: rows.length,
      Resources: rows.map((row) =>
        projectScimResource(
          buildGroupScimRepr(
            row,
            memberRows.filter((member) => member.groupId === row.id),
            ctx.tenantId,
            origin,
          ),
          ctx.projection,
        ),
      ),
    },
    200,
    SCIM_JSON_HEADERS,
  )
}
