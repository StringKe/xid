// SCIM PATCH(RFC 7644 3.5.2):在 staged 副本上应用操作,全部成功后才由路由落库。
// path 与 value map 的键都经 attrPath 解析,属性名不区分大小写。

import { evaluateScimFilter, readElementValue } from './filter-eval'
import type { ScimAttrPath, ScimFilterExpr, ScimPatchPath } from './filter-parser'
import { flattenValueMap, parsePatchPath, reservedAttribute } from './patch-paths'
import type { PatchError, PatchOp, ValueMapEntry } from './patch-paths'
import { cloneScimValue, findObjectKey, isRecord } from './scim-json'

type PatchResult = { ok: true } | { ok: false; error: PatchError }

const OK: PatchResult = { ok: true }

function fail(scimType: string, detail: string): { ok: false; error: PatchError } {
  return { ok: false, error: { scimType, detail } }
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
