// SCIM PATCH(RFC 7644 3.5.2):在 staged 副本上应用操作,全部成功后才由路由落库。
// path 与 value map 的键都经 attrPath 解析,属性名不区分大小写。

import type { Result } from '@xid-kit/types'
import type { Context } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import { evaluateScimFilter, readElementValue } from './filter-eval'
import {
  CORE_GROUP_SCHEMA,
  CORE_USER_SCHEMA,
  parseScimAttrPath,
  parseScimPatchPath,
} from './filter-parser'
import type { ScimAttrPath, ScimFilterExpr, ScimPatchPath } from './filter-parser'
import { cloneScimValue, findObjectKey, isRecord } from './scim-json'
import { readScimJson, scimError } from './shared'

export type PatchOp = {
  op: 'add' | 'remove' | 'replace'
  path?: string
  value?: unknown
}

export type PatchError = { scimType: string; detail: string }

type PatchResult = { ok: true } | { ok: false; error: PatchError }

const OK: PatchResult = { ok: true }
const SCIM_PATCH_OP_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'
const CORE_SCHEMAS_LOWER = [CORE_USER_SCHEMA, CORE_GROUP_SCHEMA].map((s) => s.toLowerCase())

const scimPatchBodySchema = v.looseObject({
  schemas: v.array(v.string()),
  Operations: v.array(v.unknown()),
})

function fail(scimType: string, detail: string): { ok: false; error: PatchError } {
  return { ok: false, error: { scimType, detail } }
}

export function parsePatchOps(operations: unknown): PatchOp[] | null {
  if (!Array.isArray(operations)) return null
  const result: PatchOp[] = []
  for (const item of operations) {
    if (!isRecord(item)) return null
    const opRaw = item['op']
    if (typeof opRaw !== 'string') return null
    const op = opRaw.toLowerCase()
    if (op !== 'add' && op !== 'remove' && op !== 'replace') return null
    result.push({
      op,
      path: typeof item['path'] === 'string' ? item['path'] : undefined,
      value: item['value'],
    })
  }
  return result
}

export async function readScimPatchOps(
  c: Context<XidHonoEnv>,
): Promise<Result<PatchOp[], Response>> {
  const body = await readScimJson(c)
  if (!body.ok) return body
  const parsed = v.safeParse(scimPatchBodySchema, body.value)
  if (!parsed.success || !parsed.output.schemas.includes(SCIM_PATCH_OP_SCHEMA)) {
    return { ok: false, error: scimError(c, 400, 'Missing PatchOp schema', 'invalidSyntax') }
  }
  const ops = parsePatchOps(parsed.output.Operations)
  if (ops === null) {
    return { ok: false, error: scimError(c, 400, 'Invalid Operations', 'invalidSyntax') }
  }
  return { ok: true, value: ops }
}

// id 等于当前资源时忽略(Okta 改组名请求体带 id),meta / schemas 一律忽略。
type ReservedDecision = 'apply' | 'skip' | { ok: false; error: PatchError }

export function reservedAttribute(
  attrPath: ScimAttrPath,
  value: unknown,
  resourceId: string,
): ReservedDecision {
  if (attrPath.schema) return 'apply'
  const name = attrPath.attr.toLowerCase()
  if (name === 'meta' || name === 'schemas') return 'skip'
  if (name !== 'id') return 'apply'
  if (attrPath.sub === undefined && value === resourceId) return 'skip'
  return fail('mutability', 'id is read-only')
}

export type ValueMapEntry = { attrPath: ScimAttrPath; value: unknown }

function isCoreSchemaKey(key: string): boolean {
  return CORE_SCHEMAS_LOWER.includes(key.toLowerCase())
}

// value map 展开:核心 schema URN 下的对象并入根,扩展 schema URN 下的对象按子键展开。
export function flattenValueMap(
  value: Record<string, unknown>,
): Result<ValueMapEntry[], PatchError> {
  const entries: ValueMapEntry[] = []
  for (const [key, item] of Object.entries(value)) {
    if (isCoreSchemaKey(key) && isRecord(item)) {
      const nested = flattenValueMap(item)
      if (!nested.ok) return nested
      entries.push(...nested.value)
      continue
    }
    if (key.toLowerCase().startsWith('urn:') && isRecord(item) && isSchemaOnlyUrn(key)) {
      for (const [subKey, subValue] of Object.entries(item)) {
        const parsed = safeAttrPath(subKey)
        if (!parsed.ok) return parsed
        entries.push({
          attrPath: { ...parsed.value, schema: canonicalSchema(key) },
          value: subValue,
        })
      }
      continue
    }
    const parsed = safeAttrPath(key)
    if (!parsed.ok) return parsed
    entries.push({ attrPath: parsed.value, value: item })
  }
  return { ok: true, value: entries }
}

function isSchemaOnlyUrn(key: string): boolean {
  const parsed = safeAttrPath(`${key}:x`)
  return parsed.ok && parsed.value.schema?.toLowerCase() === key.toLowerCase()
}

function canonicalSchema(key: string): string {
  const parsed = safeAttrPath(`${key}:x`)
  return parsed.ok && parsed.value.schema ? parsed.value.schema : key
}

function safeAttrPath(raw: string): Result<ScimAttrPath, PatchError> {
  try {
    return { ok: true, value: parseScimAttrPath(raw) }
  } catch {
    return { ok: false, error: { scimType: 'invalidPath', detail: `invalid attribute: ${raw}` } }
  }
}

export function parsePatchPath(raw: string): Result<ScimPatchPath, PatchError> {
  const parsed = parseScimPatchPath(raw)
  if (!parsed.ok) return { ok: false, error: { scimType: 'invalidPath', detail: parsed.detail } }
  return { ok: true, value: parsed.path }
}

// --- User:通用 JSON 资源上的 add / replace / remove ---

function container(
  staged: Record<string, unknown>,
  attrPath: ScimAttrPath,
  create: boolean,
): Record<string, unknown> | null {
  if (!attrPath.schema) return staged
  const key = findObjectKey(staged, attrPath.schema)
  const existing = key === null ? undefined : staged[key]
  if (isRecord(existing)) return existing
  if (!create) return null
  const created: Record<string, unknown> = {}
  staged[key ?? attrPath.schema] = created
  return created
}

function setKey(target: Record<string, unknown>, name: string, value: unknown): void {
  target[findObjectKey(target, name) ?? name] = cloneScimValue(value)
}

function mergeRecord(target: Record<string, unknown>, value: Record<string, unknown>): void {
  for (const [key, item] of Object.entries(value)) setKey(target, key, item)
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function writeAttribute(
  staged: Record<string, unknown>,
  attrPath: ScimAttrPath,
  value: unknown,
  mode: 'add' | 'replace',
): void {
  const target = container(staged, attrPath, true)!
  const key = findObjectKey(target, attrPath.attr) ?? attrPath.attr
  const existing = target[key]
  if (attrPath.sub !== undefined) {
    const sub = attrPath.sub
    if (Array.isArray(existing)) {
      for (const element of existing) if (isRecord(element)) setKey(element, sub, value)
    } else if (isRecord(existing)) {
      setKey(existing, sub, value)
    } else {
      target[key] = { [sub]: cloneScimValue(value) }
    }
    return
  }
  if (mode === 'add' && Array.isArray(existing) && Array.isArray(value)) {
    for (const item of value) {
      if (!existing.some((current) => sameJson(current, item))) existing.push(cloneScimValue(item))
    }
    return
  }
  if (isRecord(existing) && isRecord(value)) {
    mergeRecord(existing, value)
    return
  }
  target[key] = cloneScimValue(value)
}

function removeAttribute(
  staged: Record<string, unknown>,
  attrPath: ScimAttrPath,
  value: unknown,
): void {
  const target = container(staged, attrPath, false)
  if (!target) return
  const key = findObjectKey(target, attrPath.attr)
  if (key === null) return
  const existing = target[key]
  if (attrPath.sub !== undefined) {
    const elements = Array.isArray(existing) ? existing : [existing]
    for (const element of elements) {
      if (!isRecord(element)) continue
      const subKey = findObjectKey(element, attrPath.sub)
      if (subKey !== null) delete element[subKey]
    }
    return
  }
  if (Array.isArray(existing) && Array.isArray(value) && value.length > 0) {
    const removed = value.map((item) => readElementValue(item, ['value']))
    target[key] = existing.filter(
      (element) => !removed.includes(readElementValue(element, ['value'])),
    )
    return
  }
  delete target[key]
}

// valuePath filter 中 `attr eq "x"` 的合取,用于 add 未命中时新建元素。
function equalityAttributes(expr: ScimFilterExpr): Record<string, unknown> | null {
  if (
    expr.kind === 'compare' &&
    expr.op === 'eq' &&
    expr.path.length === 1 &&
    expr.value !== null
  ) {
    return { [expr.path[0]!]: expr.value }
  }
  if (expr.kind !== 'and') return null
  const left = equalityAttributes(expr.left)
  const right = equalityAttributes(expr.right)
  return left && right ? { ...left, ...right } : null
}

function applyFilteredOp(
  staged: Record<string, unknown>,
  path: ScimPatchPath & { filter: ScimFilterExpr },
  op: PatchOp,
): PatchResult {
  const target = container(staged, path.attrPath, op.op !== 'remove')
  if (!target) return OK
  const key = findObjectKey(target, path.attrPath.attr) ?? path.attrPath.attr
  const elements: unknown[] = Array.isArray(target[key]) ? (target[key] as unknown[]) : []
  const matches = elements.filter((element) =>
    evaluateScimFilter(path.filter, element, readElementValue),
  )
  if (op.op === 'remove') {
    if (path.sub === undefined) {
      target[key] = elements.filter((element) => !matches.includes(element))
      return OK
    }
    for (const element of matches) {
      const subKey = isRecord(element) ? findObjectKey(element, path.sub) : null
      if (isRecord(element) && subKey !== null) delete element[subKey]
    }
    return OK
  }
  if (matches.length === 0) {
    if (op.op === 'replace') return fail('noTarget', 'value filter matched no records')
    const seed = equalityAttributes(path.filter)
    if (!seed) return fail('noTarget', 'value filter matched no records')
    elements.push(seed)
    matches.push(seed)
    target[key] = elements
  }
  for (const element of matches) {
    if (!isRecord(element)) continue
    if (path.sub !== undefined) setKey(element, path.sub, op.value)
    else if (isRecord(op.value) && op.op === 'add') mergeRecord(element, op.value)
    else if (isRecord(op.value)) {
      for (const existingKey of Object.keys(element)) delete element[existingKey]
      mergeRecord(element, op.value)
    } else return fail('invalidValue', 'value must be an object')
  }
  return OK
}

function applyUserEntry(
  staged: Record<string, unknown>,
  entry: ValueMapEntry,
  context: { op: PatchOp['op']; resourceId: string },
): PatchResult {
  const decision = reservedAttribute(entry.attrPath, entry.value, context.resourceId)
  if (decision === 'skip') return OK
  if (decision !== 'apply') return decision
  if (context.op === 'remove') removeAttribute(staged, entry.attrPath, entry.value)
  else writeAttribute(staged, entry.attrPath, entry.value, context.op)
  return OK
}

export function applyUserPatch(
  staged: Record<string, unknown>,
  ops: PatchOp[],
  resourceId: string,
): PatchResult {
  for (const op of ops) {
    const result = applyUserOp(staged, op, resourceId)
    if (!result.ok) return result
  }
  return OK
}

function applyUserOp(
  staged: Record<string, unknown>,
  op: PatchOp,
  resourceId: string,
): PatchResult {
  if (op.path === undefined) {
    if (op.op === 'remove') return fail('noTarget', 'remove requires path')
    if (!isRecord(op.value))
      return fail('invalidValue', 'value must be an object when path is omitted')
    const entries = flattenValueMap(op.value)
    if (!entries.ok) return { ok: false, error: entries.error }
    for (const entry of entries.value) {
      const result = applyUserEntry(staged, entry, { op: op.op, resourceId })
      if (!result.ok) return result
    }
    return OK
  }
  const path = parsePatchPath(op.path)
  if (!path.ok) return { ok: false, error: path.error }
  if (path.value.filter) {
    const decision = reservedAttribute(path.value.attrPath, undefined, resourceId)
    if (decision === 'skip') return OK
    if (decision !== 'apply') return decision
    return applyFilteredOp(staged, { ...path.value, filter: path.value.filter }, op)
  }
  return applyUserEntry(
    staged,
    { attrPath: path.value.attrPath, value: op.value },
    { op: op.op, resourceId },
  )
}
