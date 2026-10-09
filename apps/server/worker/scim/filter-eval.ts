// SCIM filter 求值与 SQL 下推。filter 语法见 filter-parser.ts。

import { schema } from '@xid-kit/db'
import { and, eq, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import { ENTERPRISE_USER_SCHEMA } from './filter-parser'
import type { ScimCompareOp, ScimFilterExpr, ScimFilterValue } from './filter-parser'
import type { DirectoryGroupRow, DirectoryUserRow } from './repr'
import { findObjectKey, isRecord } from './scim-json'

// RFC 7643 caseExact=true 的属性:id、externalId、members.value
const SCIM_CASE_EXACT_ATTRS = new Set(['id', 'externalid', 'value'])

function compareScalar(
  actual: unknown,
  op: ScimCompareOp,
  expected: ScimFilterValue | undefined,
  caseExact: boolean,
): boolean {
  if (op === 'pr') return actual !== undefined && actual !== null && actual !== ''
  if (actual === undefined || actual === null) return op === 'ne' ? expected !== null : false
  if (op === 'ne') return !compareScalar(actual, 'eq', expected, caseExact)
  const actualStr = String(actual)
  const expectedStr = expected === null || expected === undefined ? '' : String(expected)
  switch (op) {
    case 'eq':
      if (typeof actual === 'boolean' || typeof expected === 'boolean') {
        return actual === expected
      }
      if (typeof actual === 'number' || typeof expected === 'number') {
        return Number(actual) === Number(expected)
      }
      return caseExact
        ? actualStr === expectedStr
        : actualStr.toLowerCase() === expectedStr.toLowerCase()
    case 'co':
      return actualStr.toLowerCase().includes(expectedStr.toLowerCase())
    case 'sw':
      return actualStr.toLowerCase().startsWith(expectedStr.toLowerCase())
    case 'ew':
      return actualStr.toLowerCase().endsWith(expectedStr.toLowerCase())
    case 'gt':
      return actualStr.localeCompare(expectedStr) > 0
    case 'ge':
      return actualStr.localeCompare(expectedStr) >= 0
    case 'lt':
      return actualStr.localeCompare(expectedStr) < 0
    case 'le':
      return actualStr.localeCompare(expectedStr) <= 0
  }
}

// 多值属性:任一值满足即匹配(RFC 7644 3.4.2.2)
function compareValues(
  actual: unknown,
  expr: Extract<ScimFilterExpr, { kind: 'compare' }>,
): boolean {
  const last = expr.path[expr.path.length - 1] ?? ''
  const caseExact = SCIM_CASE_EXACT_ATTRS.has(last.toLowerCase())
  if (Array.isArray(actual)) {
    if (expr.op === 'pr') return actual.length > 0
    return actual.some((item) => compareScalar(item, expr.op, expr.value, caseExact))
  }
  return compareScalar(actual, expr.op, expr.value, caseExact)
}

// 多值复杂属性元素按子属性名(不区分大小写)取值
export function readElementValue(element: unknown, path: string[]): unknown {
  let current: unknown = element
  for (const segment of path) {
    if (!isRecord(current)) return undefined
    const key = findObjectKey(current, segment)
    current = key === null ? undefined : current[key]
  }
  return current
}

export function evaluateScimFilter<T>(
  expr: ScimFilterExpr,
  row: T,
  getValue: (target: T, path: string[]) => unknown,
): boolean {
  switch (expr.kind) {
    case 'compare':
      return compareValues(getValue(row, expr.path), expr)
    case 'valuePath': {
      const elements = getValue(row, expr.path)
      if (!Array.isArray(elements)) return false
      return elements.some((element) => evaluateScimFilter(expr.filter, element, readElementValue))
    }
    case 'and':
      return (
        evaluateScimFilter(expr.left, row, getValue) &&
        evaluateScimFilter(expr.right, row, getValue)
      )
    case 'or':
      return (
        evaluateScimFilter(expr.left, row, getValue) ||
        evaluateScimFilter(expr.right, row, getValue)
      )
    case 'not':
      return !evaluateScimFilter(expr.expr, row, getValue)
  }
}

function emailsOf(row: DirectoryUserRow): unknown[] {
  const emails = row.scimRaw['emails']
  return Array.isArray(emails) ? emails : []
}

export function getUserFilterValue(row: DirectoryUserRow, path: string[]): unknown {
  const [head, ...rest] = path
  if (!head) return undefined
  const lowerHead = head.toLowerCase()
  if (lowerHead === 'id' && rest.length === 0) return row.id
  if (lowerHead === 'username') return row.userName
  if (lowerHead === 'externalid') return row.externalId ?? ''
  if (lowerHead === 'active') return row.active
  if (lowerHead === 'emails') {
    return rest.length === 0
      ? emailsOf(row)
      : emailsOf(row).map((email) => readElementValue(email, rest))
  }
  if (lowerHead === 'meta') {
    if (rest[0]?.toLowerCase() === 'created') return (row.createdAt ?? new Date()).toISOString()
    if (rest[0]?.toLowerCase() === 'lastmodified') {
      return (row.updatedAt ?? new Date()).toISOString()
    }
    return undefined
  }
  if (head === ENTERPRISE_USER_SCHEMA)
    return readElementValue(row.scimRaw[ENTERPRISE_USER_SCHEMA], rest)
  return readElementValue(row.scimRaw, path)
}

export function getGroupFilterValue(
  row: DirectoryGroupRow,
  path: string[],
  memberIds: ReadonlySet<string>,
): unknown {
  const [head, ...rest] = path
  if (!head) return undefined
  const lowerHead = head.toLowerCase()
  if (lowerHead === 'id' && rest.length === 0) return row.id
  if (lowerHead === 'displayname') return row.displayName
  if (lowerHead === 'members') {
    const members = [...memberIds].map((value) => ({ value, type: 'User' }))
    return rest.length === 0 ? members : members.map((member) => readElementValue(member, rest))
  }
  if (lowerHead === 'meta') {
    if (rest[0]?.toLowerCase() === 'created') return (row.createdAt ?? new Date()).toISOString()
    if (rest[0]?.toLowerCase() === 'lastmodified') {
      return (row.updatedAt ?? new Date()).toISOString()
    }
  }
  return undefined
}

// --- 可等价翻译的 eq 条件下推为 SQL,命中索引 ---

type ScimFilterColumn = {
  column: SQLiteColumn
  match: 'exact' | 'caseInsensitive' | 'boolean'
}

export const SCIM_USER_FILTER_COLUMNS: Readonly<Record<string, ScimFilterColumn>> = {
  id: { column: schema.directoryUsers.id, match: 'exact' },
  username: { column: schema.directoryUsers.userName, match: 'caseInsensitive' },
  externalid: { column: schema.directoryUsers.externalId, match: 'exact' },
  active: { column: schema.directoryUsers.active, match: 'boolean' },
}

export const SCIM_GROUP_FILTER_COLUMNS: Readonly<Record<string, ScimFilterColumn>> = {
  id: { column: schema.directoryGroups.id, match: 'exact' },
  displayname: { column: schema.directoryGroups.displayName, match: 'caseInsensitive' },
}

export type ScimFilterPushdown = { where: SQL | undefined; complete: boolean }

// SQLite lower() 只折叠 ASCII,非 ASCII 值留给 JS 求值以保持与 toLowerCase 一致
const SCIM_PUSHDOWN_ASCII = /^[\x20-\x7e]*$/

function scimCompareToSql(
  expr: Extract<ScimFilterExpr, { kind: 'compare' }>,
  columns: Readonly<Record<string, ScimFilterColumn>>,
): SQL | undefined {
  if (expr.op !== 'eq' || expr.path.length !== 1) return undefined
  const target = columns[expr.path[0]!.toLowerCase()]
  if (!target) return undefined
  const value = expr.value
  if (target.match === 'boolean') {
    return typeof value === 'boolean' ? eq(target.column, value) : undefined
  }
  if (typeof value !== 'string' || value === '') return undefined
  if (target.match === 'exact') return eq(target.column, value)
  if (!SCIM_PUSHDOWN_ASCII.test(value)) return undefined
  return sql`lower(${target.column}) = ${value.toLowerCase()}`
}

export function pushDownScimFilter(
  expr: ScimFilterExpr,
  columns: Readonly<Record<string, ScimFilterColumn>>,
): ScimFilterPushdown {
  switch (expr.kind) {
    case 'compare': {
      const where = scimCompareToSql(expr, columns)
      return { where, complete: where !== undefined }
    }
    case 'and': {
      const left = pushDownScimFilter(expr.left, columns)
      const right = pushDownScimFilter(expr.right, columns)
      return { where: and(left.where, right.where), complete: left.complete && right.complete }
    }
    case 'or': {
      const left = pushDownScimFilter(expr.left, columns)
      const right = pushDownScimFilter(expr.right, columns)
      if (!left.complete || !right.complete) return { where: undefined, complete: false }
      return { where: or(left.where, right.where), complete: true }
    }
    case 'valuePath':
    case 'not':
      return { where: undefined, complete: false }
  }
}
