// attributes / excludedAttributes 投影(RFC 7644 3.9)。

import { CORE_GROUP_SCHEMA, CORE_USER_SCHEMA, ENTERPRISE_USER_SCHEMA } from './filter-parser'
import { cloneScimObject, cloneScimValue, findObjectKey, isRecord } from './scim-json'

const MINIMUM_RETURNED_ATTRIBUTES = new Set(['schemas', 'id'])

export type ScimProjection =
  | { mode: 'attributes'; paths: string[][] }
  | { mode: 'excludedAttributes'; paths: string[][] }

type ScimProjectionResult =
  | { ok: true; projection: ScimProjection | null }
  | { ok: false; error: { scimType: string; detail: string } }

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
