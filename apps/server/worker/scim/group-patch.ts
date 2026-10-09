// Group PATCH 规划:只校验并生成 displayName 与成员计划,路由在版本 CAS 成功后才执行成员计划。

import type { ScimAttrPath, ScimFilterExpr } from './filter-parser'
import { memberRefs } from './group-members'
import type { GroupMemberPatch } from './group-members'
import { flattenValueMap, parsePatchPath, reservedAttribute } from './patch-paths'
import type { PatchError, PatchOp } from './patch-paths'

type GroupPatchPlan = { displayName?: string; memberPatches: GroupMemberPatch[] }

type GroupPatchResult = { ok: true; plan: GroupPatchPlan } | { ok: false; error: PatchError }

type GroupEntry = { attrPath: ScimAttrPath; value: unknown; filter?: ScimFilterExpr }

function fail(scimType: string, detail: string): { ok: false; error: PatchError } {
  return { ok: false, error: { scimType, detail } }
}

// `members[value eq "a" or value eq "b"]` 中的成员 id,供 add 使用。
function equalityRefs(expr: ScimFilterExpr): string[] {
  if (expr.kind === 'or') return [...equalityRefs(expr.left), ...equalityRefs(expr.right)]
  if (
    expr.kind === 'compare' &&
    expr.op === 'eq' &&
    expr.path.length === 1 &&
    expr.path[0]!.toLowerCase() === 'value' &&
    typeof expr.value === 'string'
  ) {
    return [expr.value]
  }
  return []
}

function planMembers(op: PatchOp['op'], entry: GroupEntry): GroupMemberPatch[] | PatchError {
  const refs = memberRefs(entry.value)
  if (!entry.filter) {
    if (op === 'add') return [{ kind: 'add', refs }]
    if (op === 'replace') return [{ kind: 'removeAll' }, { kind: 'add', refs }]
    return refs.length > 0 ? [{ kind: 'remove', refs }] : [{ kind: 'removeAll' }]
  }
  if (op === 'remove') return [{ kind: 'removeWhere', filter: entry.filter }]
  if (op === 'replace')
    return [
      { kind: 'removeWhere', filter: entry.filter },
      { kind: 'add', refs },
    ]
  const addRefs = refs.length > 0 ? refs : equalityRefs(entry.filter)
  if (addRefs.length === 0) return { scimType: 'noTarget', detail: 'no member to add' }
  return [{ kind: 'add', refs: addRefs }]
}

function applyEntry(
  plan: GroupPatchPlan,
  op: PatchOp['op'],
  entry: GroupEntry,
  groupId: string,
): PatchError | null {
  const decision = reservedAttribute(entry.attrPath, entry.value, groupId)
  if (decision === 'skip') return null
  if (decision !== 'apply') return decision.error
  if (entry.attrPath.schema) return null
  const name = entry.attrPath.attr.toLowerCase()
  if (name === 'displayname') {
    if (op === 'remove') return { scimType: 'invalidValue', detail: 'displayName is required' }
    if (typeof entry.value !== 'string' || entry.value.length === 0) {
      return { scimType: 'invalidValue', detail: 'displayName must be a non-empty string' }
    }
    plan.displayName = entry.value
    return null
  }
  if (name !== 'members') return null
  const patches = planMembers(op, entry)
  if (!Array.isArray(patches)) return patches
  plan.memberPatches.push(...patches)
  return null
}

function opEntries(op: PatchOp): GroupEntry[] | PatchError {
  if (op.path === undefined) {
    if (op.op === 'remove') return { scimType: 'noTarget', detail: 'remove requires path' }
    if (op.value === null || typeof op.value !== 'object' || Array.isArray(op.value)) {
      return { scimType: 'invalidValue', detail: 'value must be an object when path is omitted' }
    }
    const entries = flattenValueMap(op.value as Record<string, unknown>)
    return entries.ok ? entries.value : entries.error
  }
  const path = parsePatchPath(op.path)
  if (!path.ok) return path.error
  return [{ attrPath: path.value.attrPath, value: op.value, filter: path.value.filter }]
}

export function applyGroupPatch(ops: PatchOp[], groupId: string): GroupPatchResult {
  const plan: GroupPatchPlan = { memberPatches: [] }
  for (const op of ops) {
    const entries = opEntries(op)
    if (!Array.isArray(entries)) return fail(entries.scimType, entries.detail)
    for (const entry of entries) {
      const error = applyEntry(plan, op.op, entry, groupId)
      if (error) return { ok: false, error }
    }
  }
  return { ok: true, plan }
}
