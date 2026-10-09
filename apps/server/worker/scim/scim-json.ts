// SCIM 资源 JSON 的通用操作:属性名不区分大小写(RFC 7643 2.1)。

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function findObjectKey(source: Record<string, unknown>, segment: string): string | null {
  const lowerSegment = segment.toLowerCase()
  return Object.keys(source).find((key) => key.toLowerCase() === lowerSegment) ?? null
}

export function readAttribute(source: Record<string, unknown>, name: string): unknown {
  const key = findObjectKey(source, name)
  return key === null ? undefined : source[key]
}

export function cloneScimObject(source: Record<string, unknown>): Record<string, unknown> {
  const cloned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) cloned[key] = cloneScimValue(value)
  return cloned
}

export function cloneScimValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => cloneScimValue(item))
  if (isRecord(value)) return cloneScimObject(value)
  return value
}

export function parseScimJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}
