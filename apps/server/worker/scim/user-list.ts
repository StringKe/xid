// GET /Users 列表:filter、排序、分页(RFC 7644 3.4.2)。可下推的 eq 条件走 SQL,其余 keyset 扫描后在 JS 求值。

import { schema } from '@xid-kit/db'
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import type { XidHonoEnv } from '../lib/types'
import {
  evaluateScimFilter,
  getUserFilterValue,
  pushDownScimFilter,
  SCIM_USER_FILTER_COLUMNS,
} from './filter-eval'
import { parseScimFilter } from './filter-parser'
import {
  parseScimPagination,
  parseScimSort,
  scanScimList,
  SCIM_SCAN_BATCH_SIZE,
  SCIM_USER_SORT_ATTRS,
  scimOrderBy,
  scimUserListOrder,
} from './list-query'
import { projectScimResource } from './projection'
import { buildUserScimRepr } from './repr'
import type { ScimRequestContext } from './route-context'
import { SCIM_JSON_HEADERS, scimError } from './shared'
import { LIVE_DIRECTORY_USER } from './uniqueness'

type DirectoryUserRecord = typeof schema.directoryUsers.$inferSelect

export async function listScimUsers(
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
    SCIM_USER_SORT_ATTRS,
  )
  if (!parsedSort.ok) return scimError(c, 400, parsedSort.detail, 'invalidValue')

  const baseFilter = and(
    eq(schema.directoryUsers.directoryId, ctx.directory.id),
    LIVE_DIRECTORY_USER,
  )
  const order = scimUserListOrder(parsedSort.sortBy, parsedSort.sortOrder)
  const orderBy = scimOrderBy(order)
  const filterExpr = parsedFilter.expr
  const pushdown = filterExpr
    ? pushDownScimFilter(filterExpr, SCIM_USER_FILTER_COLUMNS)
    : { where: undefined, complete: true }
  const where = and(baseFilter, pushdown.where)
  let rows: DirectoryUserRecord[]
  let total: number
  if (!filterExpr || pushdown.complete) {
    ;[total, rows] = await Promise.all([
      ctx.db.directoryUsers.count(where),
      ctx.db.directoryUsers.findMany(where, { orderBy, limit: count, offset: startIndex - 1 }),
    ])
  } else {
    const matched: DirectoryUserRecord[] = []
    let matchedTotal = 0
    await scanScimList(
      order,
      (after) =>
        ctx.db.directoryUsers.findMany(and(where, after), { orderBy, limit: SCIM_SCAN_BATCH_SIZE }),
      (page) => {
        for (const row of page) {
          if (!evaluateScimFilter(filterExpr, row, getUserFilterValue)) continue
          matchedTotal += 1
          if (matchedTotal >= startIndex && matched.length < count) matched.push(row)
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
        projectScimResource(buildUserScimRepr(row, ctx.tenantId, origin), ctx.projection),
      ),
    },
    200,
    SCIM_JSON_HEADERS,
  )
}
