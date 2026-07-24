// SCIM 共享工具:Bearer token 鉴权(hash+宽限期)、响应体构建、PATCH 解析、deprovisioning 辅助。
// 规格:docs/design/04-enterprise-sso.md 9.1/9.2/9.3/9.4
// 密码学:sha256Hex 来自 @xid-kit/crypto(Web Crypto,不自研,见 crypto-boundary rule)
// 租户隔离:authBearer 内路径携带 organization_id 已限定 directory 查找范围(P0)

import { sha256Hex } from '@xid-kit/crypto'
import { createTenantDb, schema } from '@xid-kit/db'
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { Context } from 'hono'
import { sessionDoRevokeAll } from '../lib/session'
import { readAllById } from '../lib/db-pagination'
import type { XidHonoEnv } from '../lib/types'
import type { TenantContext } from '@xid-kit/types'
import type { WebhookQueueMessage } from '@xid-kit/types'
export { readAllById }

// SCIM 错误体(RFC7644 3.12)
type ScimErrorBody = {
  schemas: string[]
  scimType?: string
  detail: string
  status: string
}

type ScimErrorOptions = {
  scimType?: string
  addWwwAuth?: boolean
}

export function scimError(
  c: Context<XidHonoEnv>,
  status: number,
  detail: string,
  scimTypeOrOptions?: string | ScimErrorOptions,
): Response {
  const scimType =
    typeof scimTypeOrOptions === 'string' ? scimTypeOrOptions : scimTypeOrOptions?.scimType
  const addWwwAuth =
    typeof scimTypeOrOptions === 'string' ? false : scimTypeOrOptions?.addWwwAuth === true
  const body: ScimErrorBody = {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
    detail,
    status: String(status),
  }
  if (scimType) body.scimType = scimType
  const headers: Record<string, string> = { 'Content-Type': 'application/scim+json' }
  if (addWwwAuth) headers['WWW-Authenticate'] = 'Bearer'
  return c.json(body, status as 200, headers)
}

export type ScimGroupPatchContext = {
  db: ReturnType<typeof createTenantDb>
  tenantId: string
  groupId: string
  directoryId: string
}

export async function findDirectoryUsersByIds(
  db: ReturnType<typeof createTenantDb>,
  directoryId: string,
  ids: readonly string[],
): Promise<(typeof schema.directoryUsers.$inferSelect)[]> {
  if (ids.length === 0) return []
  const rows: (typeof schema.directoryUsers.$inferSelect)[] = []
  for (let start = 0; start < ids.length; start += SCIM_SCAN_BATCH_SIZE) {
    const batch = ids.slice(start, start + SCIM_SCAN_BATCH_SIZE)
    const baseFilter = and(
      eq(schema.directoryUsers.directoryId, directoryId),
      inArray(schema.directoryUsers.id, batch),
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
  const usersById = new Map(users.map((user) => [user.id, user]))
  for (let start = 0; start < uniqueRefs.length; start += SCIM_SCAN_BATCH_SIZE) {
    const batchRefs = uniqueRefs.slice(start, start + SCIM_SCAN_BATCH_SIZE)
    const memberRows = batchRefs.flatMap((ref) => {
      const user = usersById.get(ref)
      return user
        ? [
            {
              id: crypto.randomUUID(),
              tenantId: context.tenantId,
              groupId: context.groupId,
              directoryUserId: user.id,
            },
          ]
        : []
    })
    const pendingRows = batchRefs.flatMap((ref) =>
      usersById.has(ref)
        ? []
        : [
            {
              id: crypto.randomUUID(),
              tenantId: context.tenantId,
              groupId: context.groupId,
              ref,
            },
          ],
    )
    if (memberRows.length > 0) {
      await context.db.directoryGroupMembers.insertManyIgnore(memberRows)
    }
    if (pendingRows.length > 0) {
      await context.db.directoryPendingMembers.insertManyIgnore(pendingRows)
    }
  }
}

type ScimEqFilterResult = { ok: true; value: string | null } | { ok: false }

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function parseScimEqFilter(
  filter: string | undefined,
  attribute: string,
): ScimEqFilterResult {
  if (!filter) return { ok: true, value: null }
  const pattern = new RegExp(`^${escapeRegexLiteral(attribute)}\\s+eq\\s+"([^"]*)"$`, 'i')
  const match = pattern.exec(filter.trim())
  if (!match) return { ok: false }
  return { ok: true, value: match[1] ?? '' }
}

// --- SCIM filter grammar (RFC 7644 §3.4.2): AND/OR/NOT + compare ops ---

export type ScimCompareOp = 'eq' | 'ne' | 'co' | 'sw' | 'ew' | 'gt' | 'ge' | 'lt' | 'le' | 'pr'

export type ScimFilterExpr =
  | { kind: 'compare'; path: string[]; op: ScimCompareOp; value?: string | boolean | number | null }
  | { kind: 'and'; left: ScimFilterExpr; right: ScimFilterExpr }
  | { kind: 'or'; left: ScimFilterExpr; right: ScimFilterExpr }
  | { kind: 'not'; expr: ScimFilterExpr }

export type ScimFilterResult =
  | { ok: true; expr: ScimFilterExpr | null }
  | { ok: false; detail: string }

export function parseScimFilter(filter: string | undefined): ScimFilterResult {
  if (!filter?.trim()) return { ok: true, expr: null }
  try {
    const expr = parseScimFilterOr(filter.trim())
    if (!expr) return { ok: false, detail: 'invalid filter expression' }
    return { ok: true, expr }
  } catch {
    return { ok: false, detail: 'invalid filter expression' }
  }
}

function parseScimFilterOr(input: string): ScimFilterExpr | null {
  const parts = splitScimFilterLogical(input, 'or')
  if (!parts || parts.length === 1) return parseScimFilterAnd(input)
  let expr = parseScimFilterAnd(parts[0]!)
  if (!expr) return null
  for (let i = 1; i < parts.length; i++) {
    const right = parseScimFilterAnd(parts[i]!)
    if (!right) return null
    expr = { kind: 'or', left: expr, right }
  }
  return expr
}

function parseScimFilterAnd(input: string): ScimFilterExpr | null {
  const parts = splitScimFilterLogical(input, 'and')
  if (!parts || parts.length === 1) return parseScimFilterUnary(input)
  let expr = parseScimFilterUnary(parts[0]!)
  if (!expr) return null
  for (let i = 1; i < parts.length; i++) {
    const right = parseScimFilterUnary(parts[i]!)
    if (!right) return null
    expr = { kind: 'and', left: expr, right }
  }
  return expr
}

function parseScimFilterUnary(input: string): ScimFilterExpr | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const notMatch = /^not\s+/i.exec(trimmed)
  if (notMatch) {
    const rest = trimmed.slice(notMatch[0].length).trim()
    if (rest.startsWith('(') && rest.endsWith(')')) {
      const inner = parseScimFilterOr(rest.slice(1, -1).trim())
      return inner ? { kind: 'not', expr: inner } : null
    }
    const inner = parseScimFilterOr(rest)
    return inner ? { kind: 'not', expr: inner } : null
  }
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    return parseScimFilterOr(trimmed.slice(1, -1).trim())
  }
  return parseScimFilterCompare(trimmed)
}

function parseScimFilterCompare(input: string): ScimFilterExpr | null {
  const prMatch = /^(.+?)\s+pr\s*$/i.exec(input)
  if (prMatch) {
    const path = parseScimFilterAttrPath(prMatch[1]!.trim())
    return path.length > 0 ? { kind: 'compare', path, op: 'pr' } : null
  }
  const compareMatch =
    /^(.+?)\s+(eq|ne|co|sw|ew|gt|ge|lt|le)\s+("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)\s*$/i.exec(
      input,
    )
  if (!compareMatch) return null
  const path = parseScimFilterAttrPath(compareMatch[1]!.trim())
  if (path.length === 0) return null
  const op = compareMatch[2]!.toLowerCase() as ScimCompareOp
  const value = parseScimFilterValue(compareMatch[3]!.trim())
  return { kind: 'compare', path, op, value }
}

function parseScimFilterAttrPath(raw: string): string[] {
  const enterprisePrefix = `${ENTERPRISE_USER_SCHEMA}:`
  if (raw.toLowerCase().startsWith(enterprisePrefix.toLowerCase())) {
    const rest = raw.slice(enterprisePrefix.length)
    return rest ? [ENTERPRISE_USER_SCHEMA, ...rest.split('.')] : [ENTERPRISE_USER_SCHEMA]
  }
  return raw.split('.')
}

function parseScimFilterValue(raw: string): string | boolean | number | null {
  const lower = raw.toLowerCase()
  if (lower === 'true') return true
  if (lower === 'false') return false
  if (lower === 'null') return null
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
  }
  const num = Number(raw)
  if (!Number.isNaN(num) && raw !== '') return num
  return raw
}

function splitScimFilterLogical(input: string, op: 'and' | 'or'): string[] | null {
  const parts: string[] = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (depth === 0) {
      const slice = input.slice(i)
      const re = new RegExp(`^${op}(\\s|$)`, 'i')
      const match = re.exec(slice)
      if (match) {
        const part = input.slice(start, i).trim()
        if (!part) return null
        parts.push(part)
        i += match[0].length
        start = i
        continue
      }
    }
    i++
  }
  if (parts.length === 0) return null
  const tail = input.slice(start).trim()
  if (!tail) return null
  parts.push(tail)
  return parts
}

function scimFilterStringEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  return a.toLowerCase() === b.toLowerCase()
}

function scimFilterCompareValues(
  actual: unknown,
  op: ScimCompareOp,
  expected?: string | boolean | number | null,
): boolean {
  if (op === 'pr') {
    return actual !== undefined && actual !== null && actual !== ''
  }
  if (actual === undefined || actual === null) return false
  const actualStr = String(actual)
  const expectedStr = expected === null || expected === undefined ? '' : String(expected)
  switch (op) {
    case 'eq':
      if (typeof actual === 'boolean' || typeof expected === 'boolean') {
        return Boolean(actual) === Boolean(expected)
      }
      if (typeof actual === 'number' || typeof expected === 'number') {
        return Number(actual) === Number(expected)
      }
      return scimFilterStringEqual(actualStr, expectedStr)
    case 'ne':
      return !scimFilterCompareValues(actual, 'eq', expected)
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
    default:
      return false
  }
}

export function evaluateScimFilter<T>(
  expr: ScimFilterExpr,
  row: T,
  getValue: (target: T, path: string[]) => unknown,
): boolean {
  switch (expr.kind) {
    case 'compare': {
      const actual = getValue(row, expr.path)
      if (expr.path[0] === 'members' && expr.path[1] === 'value') {
        const memberIds = actual
        if (!(memberIds instanceof Set)) return false
        if (expr.op === 'pr') return memberIds.size > 0
        if (expr.op === 'eq' && typeof expr.value === 'string') return memberIds.has(expr.value)
        if (expr.op === 'ne' && typeof expr.value === 'string') return !memberIds.has(expr.value)
        return false
      }
      return scimFilterCompareValues(actual, expr.op, expr.value)
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

export function getUserFilterValue(row: DirectoryUserRow, path: string[]): unknown {
  const [head, ...rest] = path
  if (!head) return undefined
  const lowerHead = head.toLowerCase()
  if (lowerHead === 'username') return row.userName
  if (lowerHead === 'externalid') return row.externalId ?? ''
  if (lowerHead === 'active') return row.active
  if (lowerHead === 'title') return row.scimRaw['title']
  if (lowerHead === 'emails' && rest[0]?.toLowerCase() === 'value') {
    const emails = row.scimRaw['emails'] as Array<{ value?: string }> | undefined
    return emails?.find((e) => e.value)?.value ?? emails?.[0]?.value ?? ''
  }
  if (lowerHead === 'meta') {
    if (rest[0]?.toLowerCase() === 'created') return (row.createdAt ?? new Date()).toISOString()
    if (rest[0]?.toLowerCase() === 'lastmodified') {
      return (row.updatedAt ?? new Date()).toISOString()
    }
  }
  if (head === ENTERPRISE_USER_SCHEMA) {
    const enterprise = row.scimRaw[ENTERPRISE_USER_SCHEMA] as Record<string, unknown> | undefined
    if (!enterprise || rest.length === 0) return enterprise
    const key = Object.keys(enterprise).find((k) => k.toLowerCase() === rest[0]!.toLowerCase())
    return key ? enterprise[key] : undefined
  }
  return undefined
}

export function getGroupFilterValue(
  row: DirectoryGroupRow,
  path: string[],
  memberIds: Set<string>,
): unknown {
  const [head, ...rest] = path
  if (!head) return undefined
  const lowerHead = head.toLowerCase()
  if (lowerHead === 'displayname') return row.displayName
  if (lowerHead === 'members' && rest[0]?.toLowerCase() === 'value') return memberIds
  if (lowerHead === 'meta') {
    if (rest[0]?.toLowerCase() === 'created') return (row.createdAt ?? new Date()).toISOString()
    if (rest[0]?.toLowerCase() === 'lastmodified') {
      return (row.updatedAt ?? new Date()).toISOString()
    }
  }
  return undefined
}

// --- SCIM sort (RFC 7644 §3.4.2.3) ---

export const SCIM_USER_SORT_ATTRS = new Set([
  'username',
  'externalid',
  'active',
  'meta.created',
  'meta.lastmodified',
])
export const SCIM_GROUP_SORT_ATTRS = new Set(['displayname', 'meta.created', 'meta.lastmodified'])
export const SCIM_SCAN_BATCH_SIZE = 100

export function scimUserOrderBy(
  sortBy: string | null,
  sortOrder: 'ascending' | 'descending',
): readonly SQL[] {
  if (sortBy === 'username') {
    return sortOrder === 'descending'
      ? [desc(schema.directoryUsers.userName), asc(schema.directoryUsers.id)]
      : [asc(schema.directoryUsers.userName), asc(schema.directoryUsers.id)]
  }
  if (sortBy === 'externalid') {
    return sortOrder === 'descending'
      ? [desc(schema.directoryUsers.externalId), asc(schema.directoryUsers.id)]
      : [asc(schema.directoryUsers.externalId), asc(schema.directoryUsers.id)]
  }
  if (sortBy === 'active') {
    return sortOrder === 'descending'
      ? [desc(schema.directoryUsers.active), asc(schema.directoryUsers.id)]
      : [asc(schema.directoryUsers.active), asc(schema.directoryUsers.id)]
  }
  if (sortBy === 'meta.created') {
    return sortOrder === 'descending'
      ? [desc(schema.directoryUsers.createdAt), asc(schema.directoryUsers.id)]
      : [asc(schema.directoryUsers.createdAt), asc(schema.directoryUsers.id)]
  }
  if (sortBy === 'meta.lastmodified') {
    return sortOrder === 'descending'
      ? [desc(schema.directoryUsers.updatedAt), asc(schema.directoryUsers.id)]
      : [asc(schema.directoryUsers.updatedAt), asc(schema.directoryUsers.id)]
  }
  return [asc(schema.directoryUsers.id)]
}

export function scimGroupOrderBy(
  sortBy: string | null,
  sortOrder: 'ascending' | 'descending',
): readonly SQL[] {
  if (sortBy === 'displayname') {
    return sortOrder === 'descending'
      ? [desc(schema.directoryGroups.displayName), asc(schema.directoryGroups.id)]
      : [asc(schema.directoryGroups.displayName), asc(schema.directoryGroups.id)]
  }
  if (sortBy === 'meta.created') {
    return sortOrder === 'descending'
      ? [desc(schema.directoryGroups.createdAt), asc(schema.directoryGroups.id)]
      : [asc(schema.directoryGroups.createdAt), asc(schema.directoryGroups.id)]
  }
  if (sortBy === 'meta.lastmodified') {
    return sortOrder === 'descending'
      ? [desc(schema.directoryGroups.updatedAt), asc(schema.directoryGroups.id)]
      : [asc(schema.directoryGroups.updatedAt), asc(schema.directoryGroups.id)]
  }
  return [asc(schema.directoryGroups.id)]
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
    if (sortOrder?.trim()) {
      return { ok: false, detail: 'sortOrder requires sortBy' }
    }
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

export function sortScimRows<T>(
  rows: T[],
  sortBy: string,
  sortOrder: 'ascending' | 'descending',
  getSortValue: (row: T, attr: string) => string | number | boolean,
): T[] {
  const sorted = [...rows]
  sorted.sort((a, b) => {
    const av = getSortValue(a, sortBy)
    const bv = getSortValue(b, sortBy)
    let cmp = 0
    if (typeof av === 'boolean' && typeof bv === 'boolean') {
      cmp = Number(av) - Number(bv)
    } else if (typeof av === 'number' && typeof bv === 'number') {
      cmp = av - bv
    } else {
      cmp = String(av).localeCompare(String(bv), undefined, { sensitivity: 'base' })
    }
    return sortOrder === 'descending' ? -cmp : cmp
  })
  return sorted
}

export function getUserSortValue(row: DirectoryUserRow, sortBy: string): string | number | boolean {
  if (sortBy === 'username') return row.userName
  if (sortBy === 'externalid') return row.externalId ?? ''
  if (sortBy === 'active') return row.active
  if (sortBy === 'meta.created') return (row.createdAt ?? new Date()).getTime()
  if (sortBy === 'meta.lastmodified') return (row.updatedAt ?? new Date()).getTime()
  return ''
}

export function getGroupSortValue(
  row: DirectoryGroupRow,
  sortBy: string,
): string | number | boolean {
  if (sortBy === 'displayname') return row.displayName
  if (sortBy === 'meta.created') return (row.createdAt ?? new Date()).getTime()
  if (sortBy === 'meta.lastmodified') return (row.updatedAt ?? new Date()).getTime()
  return ''
}

// --- SCIM ETag / If-Match (RFC 7644 §3.14) ---

export function buildVersion(updatedAt: Date | null | undefined): string {
  const ts = updatedAt?.getTime() ?? 0
  return `W/"${ts.toString(16)}"`
}

export function versionGuardFromRow(updatedAt: Date | null | undefined): Date {
  return updatedAt ?? new Date(0)
}

export function checkScimPrecondition(
  c: Context<XidHonoEnv>,
  currentVersion: string,
  options: { requireIfMatch?: boolean } = {},
): Response | null {
  const ifMatch = c.req.header('If-Match')
  if (!ifMatch) {
    if (options.requireIfMatch) {
      return scimError(c, 428, 'If-Match header required for versioned update')
    }
    return null
  }
  if (ifMatch.trim() === '*') return null
  const tags = ifMatch.split(',').map((tag) => tag.trim())
  if (!tags.includes(currentVersion)) {
    return scimError(c, 412, 'Resource version mismatch')
  }
  return null
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

export const SCIM_BULK_MAX_OPERATIONS = 100
export const SCIM_BULK_MAX_PAYLOAD_SIZE = 1_048_576

const CORE_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User'
const CORE_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group'
const ENTERPRISE_USER_SCHEMA = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'
const MINIMUM_RETURNED_ATTRIBUTES = new Set(['schemas', 'id'])

type ScimProjection =
  | { mode: 'attributes'; paths: string[][] }
  | { mode: 'excludedAttributes'; paths: string[][] }

type ScimProjectionResult =
  | { ok: true; projection: ScimProjection | null }
  | { ok: false; error: PatchError }

export function parseScimProjection(
  attributes: string | undefined,
  excludedAttributes: string | undefined,
): ScimProjectionResult {
  if (attributes && excludedAttributes) {
    return {
      ok: false,
      error: {
        scimType: 'invalidValue',
        detail: 'attributes and excludedAttributes are mutually exclusive',
      },
    }
  }

  if (attributes) {
    return { ok: true, projection: { mode: 'attributes', paths: parseProjectionPaths(attributes) } }
  }
  if (excludedAttributes) {
    return {
      ok: true,
      projection: { mode: 'excludedAttributes', paths: parseProjectionPaths(excludedAttributes) },
    }
  }
  return { ok: true, projection: null }
}

function parseProjectionPaths(raw: string): string[][] {
  return raw
    .split(',')
    .map((part) => normalizeProjectionPath(part.trim()))
    .filter((path): path is string[] => path !== null)
}

function normalizeProjectionPath(raw: string): string[] | null {
  if (!raw) return null
  const lower = raw.toLowerCase()
  const enterpriseLower = ENTERPRISE_USER_SCHEMA.toLowerCase()
  if (lower === enterpriseLower) return [ENTERPRISE_USER_SCHEMA]
  if (lower.startsWith(`${enterpriseLower}:`)) {
    return [ENTERPRISE_USER_SCHEMA, ...raw.slice(ENTERPRISE_USER_SCHEMA.length + 1).split('.')]
  }

  for (const schemaName of [CORE_USER_SCHEMA, CORE_GROUP_SCHEMA]) {
    const schemaLower = schemaName.toLowerCase()
    if (lower === schemaLower) return null
    if (lower.startsWith(`${schemaLower}:`)) {
      return raw.slice(schemaName.length + 1).split('.')
    }
  }

  return raw.split('.')
}

export function projectScimResource(
  resource: Record<string, unknown>,
  projection: ScimProjection | null,
): Record<string, unknown> {
  if (!projection) return resource

  if (projection.mode === 'attributes') {
    const projected: Record<string, unknown> = {}
    copyMinimumAttributes(resource, projected)
    for (const path of projection.paths) copyProjectionPath(resource, projected, path)
    return projected
  }

  const projected = cloneScimObject(resource)
  for (const path of projection.paths) removeProjectionPath(projected, path)
  copyMinimumAttributes(resource, projected)
  return projected
}

function copyMinimumAttributes(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
): void {
  for (const key of MINIMUM_RETURNED_ATTRIBUTES) {
    if (key in source) target[key] = cloneScimValue(source[key])
  }
}

function copyProjectionPath(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  path: string[],
): void {
  const [head, ...tail] = path
  if (!head) return
  const sourceKey = findObjectKey(source, head)
  if (!sourceKey) return
  const sourceValue = source[sourceKey]

  if (tail.length === 0) {
    target[sourceKey] = cloneScimValue(sourceValue)
    return
  }

  if (Array.isArray(sourceValue)) {
    target[sourceKey] = sourceValue.map((item) => {
      if (!isRecord(item)) return cloneScimValue(item)
      const projectedItem: Record<string, unknown> = {}
      copyProjectionPath(item, projectedItem, tail)
      return projectedItem
    })
    return
  }

  if (!isRecord(sourceValue)) return
  const existing = isRecord(target[sourceKey]) ? target[sourceKey] : {}
  target[sourceKey] = existing
  copyProjectionPath(sourceValue, existing, tail)
}

function removeProjectionPath(target: Record<string, unknown>, path: string[]): void {
  const [head, ...tail] = path
  if (!head) return
  const targetKey = findObjectKey(target, head)
  if (!targetKey || MINIMUM_RETURNED_ATTRIBUTES.has(targetKey)) return

  if (tail.length === 0) {
    delete target[targetKey]
    return
  }

  const targetValue = target[targetKey]
  if (Array.isArray(targetValue)) {
    for (const item of targetValue) {
      if (isRecord(item)) removeProjectionPath(item, tail)
    }
    return
  }
  if (isRecord(targetValue)) removeProjectionPath(targetValue, tail)
}

function findObjectKey(source: Record<string, unknown>, segment: string): string | null {
  const lowerSegment = segment.toLowerCase()
  return Object.keys(source).find((key) => key.toLowerCase() === lowerSegment) ?? null
}

function cloneScimObject(source: Record<string, unknown>): Record<string, unknown> {
  const cloned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) cloned[key] = cloneScimValue(value)
  return cloned
}

function cloneScimValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => cloneScimValue(item))
  if (isRecord(value)) return cloneScimObject(value)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// directory 行快照(authBearer 返回)
export type DirectoryRow = {
  id: string
  orgId: string
  tenantId: string
  scimTokenHash: string
  scimTokenHashPrev: string | null
  scimTokenPrevExpires: Date | null
}

// 9.2 Bearer token 鉴权:SHA-256 hash + 30min 宽限(constant-time 比对)
export async function authBearer(
  c: Context<XidHonoEnv>,
  tenantId: string,
): Promise<DirectoryRow | null> {
  const authHeader = c.req.header('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return null
  const token = authHeader.slice('Bearer '.length).trim()
  if (!token) return null

  const h = await sha256Hex(token)

  const tenant = c.get('tenant')
  const db = createTenantDb(c.env.DB, tenant)

  // token hash 有高选择性,直接命中索引;不再把组织下所有目录读入 Worker。
  const current = await db.directories.findOne(
    and(
      eq(schema.directories.tenantId, tenantId),
      eq(schema.directories.status, 'active'),
      eq(schema.directories.scimTokenHash, h),
    ),
  )
  if (current && constantTimeEq(h, current.scimTokenHash)) return current as DirectoryRow

  const previous = await db.directories.findOne(
    and(
      eq(schema.directories.tenantId, tenantId),
      eq(schema.directories.status, 'active'),
      eq(schema.directories.scimTokenHashPrev, h),
      gt(schema.directories.scimTokenPrevExpires, new Date()),
    ),
  )
  if (previous && constantTimeEq(h, previous.scimTokenHashPrev ?? '')) {
    return previous as DirectoryRow
  }
  return null
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// 9.3 User 响应体(符合 SCIM User schema)
export type DirectoryUserRow = {
  id: string
  tenantId: string
  directoryId: string
  userId: string | null
  externalId: string | null
  userName: string
  scimRaw: Record<string, unknown>
  active: boolean
  createdAt: Date | null
  updatedAt: Date | null
}

export function buildUserMeta(
  row: DirectoryUserRow,
  tenantId: string,
  baseUrl: string,
): Record<string, unknown> {
  const base = baseUrl.startsWith('http') ? new URL(baseUrl).origin : baseUrl
  return {
    resourceType: 'User',
    created: (row.createdAt ?? new Date()).toISOString(),
    lastModified: (row.updatedAt ?? new Date()).toISOString(),
    location: `${base}/scim/v2/organizations/${tenantId}/Users/${row.id}`,
    version: buildVersion(row.updatedAt),
  }
}

export function buildUserScimRepr(
  row: DirectoryUserRow,
  tenantId: string,
  baseUrl: string,
): Record<string, unknown> {
  const raw = row.scimRaw ?? {}
  const name = raw['name'] as Record<string, unknown> | undefined
  const emails = raw['emails'] as unknown[] | undefined
  const enterprise = raw['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'] as
    | Record<string, unknown>
    | undefined

  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: row.id,
    externalId: row.externalId ?? undefined,
    userName: row.userName,
    name: {
      givenName: name?.['givenName'] ?? undefined,
      familyName: name?.['familyName'] ?? undefined,
      formatted: name?.['formatted'] ?? undefined,
    },
    emails: emails ?? [],
    active: row.active,
    title: raw['title'] ?? undefined,
    'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': {
      department: enterprise?.['department'] ?? undefined,
    },
    meta: buildUserMeta(row, tenantId, baseUrl),
  }
}

// 9.4 Group 响应体
export type DirectoryGroupRow = {
  id: string
  tenantId: string
  directoryId: string
  displayName: string
  mappedRole: string | null
  createdAt: Date | null
  updatedAt: Date | null
}

export type DirectoryGroupMemberRow = {
  id: string
  tenantId: string
  groupId: string
  directoryUserId: string
}

export function buildGroupScimRepr(
  row: DirectoryGroupRow,
  memberRows: DirectoryGroupMemberRow[],
  tenantId: string,
  baseUrl: string,
): Record<string, unknown> {
  const base = baseUrl.startsWith('http') ? new URL(baseUrl).origin : baseUrl
  const location = `${base}/scim/v2/organizations/${tenantId}/Groups/${row.id}`
  const members = memberRows.map((m) => ({
    value: m.directoryUserId,
    $ref: `${base}/scim/v2/organizations/${tenantId}/Users/${m.directoryUserId}`,
    type: 'User',
  }))

  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
    id: row.id,
    displayName: row.displayName,
    members,
    meta: {
      resourceType: 'Group',
      created: (row.createdAt ?? new Date()).toISOString(),
      lastModified: (row.updatedAt ?? new Date()).toISOString(),
      location,
      version: buildVersion(row.updatedAt),
    },
  }
}

// PATCH op 类型
export type PatchOp = {
  op: 'add' | 'remove' | 'replace'
  path?: string
  value?: unknown
}

type PatchError = {
  scimType: string
  detail: string
}

type PatchResult = { ok: true } | { ok: false; error: PatchError }

// 解析 Operations 数组(null 代表格式非法)
export function parsePatchOps(operations: unknown): PatchOp[] | null {
  if (!Array.isArray(operations)) return null
  const result: PatchOp[] = []
  for (const item of operations) {
    if (!item || typeof item !== 'object') return null
    const raw = item as Record<string, unknown>
    const opRaw = raw['op']
    if (typeof opRaw !== 'string') return null
    const op = opRaw.toLowerCase()
    if (op !== 'add' && op !== 'remove' && op !== 'replace') return null
    result.push({
      op: op as PatchOp['op'],
      path: typeof raw['path'] === 'string' ? raw['path'] : undefined,
      value: raw['value'],
    })
  }
  return result
}

// User PATCH 应用(staged 副本,全成功才落库,见 9.1)
export function applyUserPatch(staged: Record<string, unknown>, ops: PatchOp[]): PatchResult {
  const readOnly = new Set(['id', 'meta'])

  for (const opItem of ops) {
    const { op, path, value } = opItem

    if (op === 'remove' && !path) {
      return { ok: false, error: { scimType: 'noTarget', detail: 'remove requires path' } }
    }

    if (!path) {
      // 无 path 的 replace:value 是属性 map,逐属性替换
      if (op === 'replace' && value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (readOnly.has(k)) {
            return { ok: false, error: { scimType: 'mutability', detail: `${k} is read-only` } }
          }
          staged[k] = v
        }
      } else if (op === 'add' && value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (readOnly.has(k)) {
            return { ok: false, error: { scimType: 'mutability', detail: `${k} is read-only` } }
          }
          staged[k] = v
        }
      }
      continue
    }

    // 有 path:简单属性(不支持 filter 表达式的复杂 path)
    if (readOnly.has(path)) {
      return { ok: false, error: { scimType: 'mutability', detail: `${path} is read-only` } }
    }

    if (op === 'add' || op === 'replace') {
      staged[path] = value
    } else if (op === 'remove') {
      if (!(path in staged)) continue // 幂等空删
      delete staged[path]
    }
  }
  return { ok: true }
}

export type GroupMemberPatch = {
  op: PatchOp['op']
  members: unknown[]
}

type GroupPatchResult =
  | { ok: true; memberPatches: GroupMemberPatch[] }
  | { ok: false; error: PatchError }

// Group PATCH 先只校验和规划成员变化。路由完成 group 版本 CAS 后才执行计划，
// 使 412 保持无副作用。
export function applyGroupPatch(staged: Record<string, unknown>, ops: PatchOp[]): GroupPatchResult {
  const readOnly = new Set(['id', 'meta'])
  const memberPatches: GroupMemberPatch[] = []

  for (const opItem of ops) {
    const { op, path, value } = opItem

    if (op === 'remove' && !path) {
      return { ok: false, error: { scimType: 'noTarget', detail: 'remove requires path' } }
    }

    if (!path) {
      if ((op === 'add' || op === 'replace') && value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (readOnly.has(k)) {
            return { ok: false, error: { scimType: 'mutability', detail: `${k} is read-only` } }
          }
          staged[k] = v
        }
      }
      continue
    }

    if (readOnly.has(path)) {
      return { ok: false, error: { scimType: 'mutability', detail: `${path} is read-only` } }
    }

    // members 多值属性特殊处理
    if (path === 'members') {
      const members = Array.isArray(value) ? value : value !== undefined ? [value] : []
      memberPatches.push({ op, members })
      continue
    }

    if (op === 'add' || op === 'replace') {
      staged[path] = value
    } else if (op === 'remove') {
      if (!(path in staged)) continue
      delete staged[path]
    }
  }
  return { ok: true, memberPatches }
}

// 仅在 group 版本 CAS 获胜后应用成员计划。
export async function applyGroupMemberPatches(
  context: ScimGroupPatchContext,
  memberPatches: readonly GroupMemberPatch[],
): Promise<void> {
  for (const patch of memberPatches) {
    if (patch.op === 'add') {
      await addMembersWithPending(context, patch.members)
      continue
    }
    if (patch.op === 'remove') {
      await removeMembersByRef(context.db, context.groupId, patch.members)
      continue
    }
    await context.db.directoryGroupMembers.hardDelete(
      eq(schema.directoryGroupMembers.groupId, context.groupId),
    )
    await addMembersWithPending(context, patch.members)
  }
}

// 添加成员,unknown member 写 pending(9.1.1)
async function addMembersWithPending(
  context: ScimGroupPatchContext,
  members: unknown[],
): Promise<void> {
  const refs = members.flatMap((member) => {
    if (!member || typeof member !== 'object') return []
    const ref = (member as Record<string, unknown>)['value']
    return typeof ref === 'string' && ref.length > 0 ? [ref] : []
  })
  await addDirectoryUsersToGroup(context, refs)
}

// remove members:通过 ref(value) 定位,幂等(找不到就跳过)
async function removeMembersByRef(
  db: ReturnType<typeof createTenantDb>,
  groupId: string,
  members: unknown[],
): Promise<void> {
  const refs = members.flatMap((member) => {
    if (!member || typeof member !== 'object') return []
    const ref = (member as Record<string, unknown>)['value']
    return typeof ref === 'string' && ref.length > 0 ? [ref] : []
  })
  if (refs.length === 0) return
  for (let start = 0; start < refs.length; start += SCIM_SCAN_BATCH_SIZE) {
    const batch = refs.slice(start, start + SCIM_SCAN_BATCH_SIZE)
    await db.directoryGroupMembers.hardDelete(
      and(
        eq(schema.directoryGroupMembers.groupId, groupId),
        inArray(schema.directoryGroupMembers.directoryUserId, batch),
      ),
    )
    await db.directoryPendingMembers.hardDelete(
      and(
        eq(schema.directoryPendingMembers.groupId, groupId),
        inArray(schema.directoryPendingMembers.ref, batch),
      ),
    )
  }
}

// 9.1.2 deprovisioning:同步撤销该用户全部 session(per-user SessionDO)
export async function revokeAllUserSessions(
  env: Env,
  tenant: TenantContext,
  userId: string,
): Promise<void> {
  // 1. SessionDO 清空 active session set(统一走 sessionDoStub,命中签发时的同一实例,见会话存储)
  await sessionDoRevokeAll(env, userId)
  // 2. 异步落 D1 sessions status=revoked(DO 已是真相源,D1 只需最终一致)
  try {
    const db = createTenantDb(env.DB, tenant)
    await db.sessions.update(
      { status: 'revoked' },
      and(eq(schema.sessions.userId, userId), eq(schema.sessions.tenantId, tenant.tenantId)),
    )
  } catch {
    // D1 落库失败不影响 DO 已完成的撤销
  }
}

// 异步投递 webhook(不阻塞 SCIM 响应,经 Queues,见 cloudflare-bindings rule)
export function emitWebhookAsync(c: Context<XidHonoEnv> | Env, msg: WebhookQueueMessage): void {
  const executionCtx = readExecutionContext(c)
  const env = 'env' in c ? c.env : c
  const task = env.WEBHOOK_QUEUE.send(msg)
  if (executionCtx !== undefined) {
    executionCtx.waitUntil(task)
    return
  }
  void task.catch((error: unknown) => console.error('webhook queue send failed', error))
}

function readExecutionContext(c: Context<XidHonoEnv> | Env) {
  if (!('executionCtx' in c)) return undefined
  try {
    return c.executionCtx
  } catch (error) {
    if (error instanceof Error && error.message === 'This context has no ExecutionContext') {
      return undefined
    }
    throw error
  }
}
