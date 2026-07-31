export type ParsedConditionExpression =
  | { ok: true; value: Record<string, unknown> | null }
  | { ok: false; reason: 'invalid_json' | 'object_required' }

export function parseConditionExpression(input: string): ParsedConditionExpression {
  const trimmed = input.trim()
  if (!trimmed) return { ok: true, value: null }

  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return { ok: false, reason: 'invalid_json' }
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'object_required' }
  }
  return { ok: true, value: value as Record<string, unknown> }
}

export function formatConditionExpression(value: Record<string, unknown> | null): string {
  return value === null ? '' : JSON.stringify(value, null, 2)
}
