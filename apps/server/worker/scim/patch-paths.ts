// SCIM PATCH 请求体(RFC 7644 3.5.2):Operations 校验、path 解析与 value map 展开。
// User 与 Group 的应用逻辑分别见 patch.ts 与 group-patch.ts。

import type { Result } from '@xid-kit/types'
import type { Context } from 'hono'
import * as v from 'valibot'
import type { XidHonoEnv } from '../lib/types'
import {
  CORE_GROUP_SCHEMA,
  CORE_USER_SCHEMA,
  parseScimAttrPath,
  parseScimPatchPath,
} from './filter-parser'
import type { ScimAttrPath, ScimPatchPath } from './filter-parser'
import { isRecord } from './scim-json'
import { readScimJson, scimError } from './shared'

export type PatchOp = {
  op: 'add' | 'remove' | 'replace'
  path?: string
  value?: unknown
}

export type PatchError = { scimType: string; detail: string }

const SCIM_PATCH_OP_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'
const CORE_SCHEMAS_LOWER = [CORE_USER_SCHEMA, CORE_GROUP_SCHEMA].map((s) => s.toLowerCase())

const scimPatchBodySchema = v.looseObject({
  schemas: v.array(v.string()),
  Operations: v.array(v.unknown()),
})

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
  return { ok: false, error: { scimType: 'mutability', detail: 'id is read-only' } }
}

export type ValueMapEntry = { attrPath: ScimAttrPath; value: unknown }

function safeAttrPath(raw: string): Result<ScimAttrPath, PatchError> {
  try {
    return { ok: true, value: parseScimAttrPath(raw) }
  } catch {
    return { ok: false, error: { scimType: 'invalidPath', detail: `invalid attribute: ${raw}` } }
  }
}

// 键本身就是 schema URN(如 enterprise 扩展)时返回规范写法,否则 null。
function schemaOnlyUrn(key: string): string | null {
  if (!key.toLowerCase().startsWith('urn:')) return null
  const parsed = safeAttrPath(`${key}:x`)
  const schemaName = parsed.ok ? parsed.value.schema : undefined
  return schemaName?.toLowerCase() === key.toLowerCase() ? schemaName : null
}

// value map 展开:核心 schema URN 下的对象并入根,扩展 schema URN 下的对象按子键展开。
export function flattenValueMap(
  value: Record<string, unknown>,
): Result<ValueMapEntry[], PatchError> {
  const entries: ValueMapEntry[] = []
  for (const [key, item] of Object.entries(value)) {
    if (CORE_SCHEMAS_LOWER.includes(key.toLowerCase()) && isRecord(item)) {
      const nested = flattenValueMap(item)
      if (!nested.ok) return nested
      entries.push(...nested.value)
      continue
    }
    const schemaName = isRecord(item) ? schemaOnlyUrn(key) : null
    if (schemaName && isRecord(item)) {
      for (const [subKey, subValue] of Object.entries(item)) {
        const parsed = safeAttrPath(subKey)
        if (!parsed.ok) return parsed
        entries.push({ attrPath: { ...parsed.value, schema: schemaName }, value: subValue })
      }
      continue
    }
    const parsed = safeAttrPath(key)
    if (!parsed.ok) return parsed
    entries.push({ attrPath: parsed.value, value: item })
  }
  return { ok: true, value: entries }
}

export function parsePatchPath(raw: string): Result<ScimPatchPath, PatchError> {
  const parsed = parseScimPatchPath(raw)
  if (!parsed.ok) return { ok: false, error: { scimType: 'invalidPath', detail: parsed.detail } }
  return { ok: true, value: parsed.path }
}
