// SCIM 列表查询:排序(RFC 7644 3.4.2.3)、分页(3.4.2.4)与 keyset 扫描。

import { schema } from '@xid-kit/db'
import { and, asc, desc, eq, gt, isNotNull, isNull, lt, or } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'

export const SCIM_USER_SORT_ATTRS = new Set([
  'username',
  'externalid',
  'active',
  'meta.created',
  'meta.lastmodified',
])
export const SCIM_GROUP_SORT_ATTRS = new Set(['displayname', 'meta.created', 'meta.lastmodified'])
export const SCIM_SCAN_BATCH_SIZE = 100

type ScimSortColumn = { column: SQLiteColumn; field: string; nullable: boolean }

const SCIM_USER_SORT_COLUMNS: Readonly<Record<string, ScimSortColumn>> = {
  username: { column: schema.directoryUsers.userName, field: 'userName', nullable: false },
  externalid: { column: schema.directoryUsers.externalId, field: 'externalId', nullable: true },
  active: { column: schema.directoryUsers.active, field: 'active', nullable: false },
  'meta.created': { column: schema.directoryUsers.createdAt, field: 'createdAt', nullable: false },
  'meta.lastmodified': {
    column: schema.directoryUsers.updatedAt,
    field: 'updatedAt',
    nullable: false,
  },
}

const SCIM_GROUP_SORT_COLUMNS: Readonly<Record<string, ScimSortColumn>> = {
  displayname: {
    column: schema.directoryGroups.displayName,
    field: 'displayName',
    nullable: false,
  },
  'meta.created': { column: schema.directoryGroups.createdAt, field: 'createdAt', nullable: false },
  'meta.lastmodified': {
    column: schema.directoryGroups.updatedAt,
    field: 'updatedAt',
    nullable: false,
  },
}

export type ScimListOrder = {
  idColumn: SQLiteColumn
  sort: (ScimSortColumn & { descending: boolean }) | null
}

function scimListOrder(
  idColumn: SQLiteColumn,
  columns: Readonly<Record<string, ScimSortColumn>>,
  sort: { sortBy: string | null; sortOrder: 'ascending' | 'descending' },
): ScimListOrder {
  const column = sort.sortBy ? columns[sort.sortBy] : undefined
  if (!column) return { idColumn, sort: null }
  return { idColumn, sort: { ...column, descending: sort.sortOrder === 'descending' } }
}

export function scimUserListOrder(
  sortBy: string | null,
  sortOrder: 'ascending' | 'descending',
): ScimListOrder {
  return scimListOrder(schema.directoryUsers.id, SCIM_USER_SORT_COLUMNS, { sortBy, sortOrder })
}

export function scimGroupListOrder(
  sortBy: string | null,
  sortOrder: 'ascending' | 'descending',
): ScimListOrder {
  return scimListOrder(schema.directoryGroups.id, SCIM_GROUP_SORT_COLUMNS, { sortBy, sortOrder })
}

export function scimOrderBy(order: ScimListOrder): SQL[] {
  const tieBreak = asc(order.idColumn)
  if (!order.sort) return [tieBreak]
  const { column, descending } = order.sort
  return [descending ? desc(column) : asc(column), tieBreak]
}

// SQLite 排序:NULL 在 ASC 最前、DESC 最后
function scimKeysetAfter(order: ScimListOrder, last: { id: string }): SQL {
  const afterId = gt(order.idColumn, last.id)
  const sort = order.sort
  if (!sort) return afterId
  const value = (last as Record<string, unknown>)[sort.field]
  if (value === null || value === undefined) {
    return sort.descending
      ? and(isNull(sort.column), afterId)!
      : or(and(isNull(sort.column), afterId), isNotNull(sort.column))!
  }
  const beyond = sort.descending ? lt(sort.column, value) : gt(sort.column, value)
  const tie = and(eq(sort.column, value), afterId)
  const nullsAfter = sort.descending && sort.nullable ? isNull(sort.column) : undefined
  return or(beyond, tie, nullsAfter)!
}

// 按排序键做 keyset 分页扫描,每行只读一次,避免 OFFSET 重复跳读
export async function scanScimList<T extends { id: string }>(
  order: ScimListOrder,
  fetchPage: (after: SQL | undefined) => Promise<T[]>,
  visitPage: (page: T[]) => Promise<void> | void,
): Promise<void> {
  let after: SQL | undefined
  while (true) {
    const page = await fetchPage(after)
    if (page.length === 0) return
    await visitPage(page)
    if (page.length < SCIM_SCAN_BATCH_SIZE) return
    after = scimKeysetAfter(order, page[page.length - 1]!)
  }
}

export type ScimSortResult =
  | { ok: true; sortBy: string | null; sortOrder: 'ascending' | 'descending' }
  | { ok: false; detail: string }

export function parseScimSort(
  sortBy: string | undefined,
  sortOrder: string | undefined,
  allowed: Set<string>,
): ScimSortResult {
  if (!sortBy) {
    if (sortOrder?.trim()) return { ok: false, detail: 'sortOrder requires sortBy' }
    return { ok: true, sortBy: null, sortOrder: 'ascending' }
  }
  const normalized = sortBy.trim().toLowerCase()
  if (!allowed.has(normalized)) {
    return { ok: false, detail: `unsupported sortBy attribute: ${sortBy}` }
  }
  const order = (sortOrder ?? 'ascending').trim().toLowerCase()
  if (order !== 'ascending' && order !== 'descending') {
    return { ok: false, detail: `unsupported sortOrder: ${sortOrder}` }
  }
  return { ok: true, sortBy: normalized, sortOrder: order }
}

export type ScimPaginationResult =
  | { ok: true; startIndex: number; count: number }
  | { ok: false; detail: string }

export function parseScimPagination(
  startIndexRaw: string | undefined,
  countRaw: string | undefined,
): ScimPaginationResult {
  const startParsed = startIndexRaw === undefined ? 1 : Number(startIndexRaw)
  if (!Number.isInteger(startParsed) || startParsed < 1) {
    return { ok: false, detail: 'invalid startIndex' }
  }
  const countParsed = countRaw === undefined ? 100 : Number(countRaw)
  if (!Number.isInteger(countParsed) || countParsed < 1) {
    return { ok: false, detail: 'invalid count' }
  }
  return { ok: true, startIndex: startParsed, count: Math.min(100, countParsed) }
}
