import { describe, expect, it } from 'vitest'
import { formatConditionExpression, parseConditionExpression } from './condition-expression'

describe('condition expression editor boundary', () => {
  it('maps an empty editor to an unconditional null expression', () => {
    expect(parseConditionExpression('  ')).toEqual({ ok: true, value: null })
  })

  it('accepts a JSON object without duplicating server ABAC validation', () => {
    expect(parseConditionExpression('{"op":"eq","var":"org.id","value":"org_1"}')).toEqual({
      ok: true,
      value: { op: 'eq', var: 'org.id', value: 'org_1' },
    })
  })

  it('rejects malformed JSON and non-object JSON values', () => {
    expect(parseConditionExpression('{')).toEqual({ ok: false, reason: 'invalid_json' })
    expect(parseConditionExpression('[]')).toEqual({ ok: false, reason: 'object_required' })
    expect(parseConditionExpression('"allow"')).toEqual({
      ok: false,
      reason: 'object_required',
    })
  })

  it('formats stored objects and leaves null blank', () => {
    expect(formatConditionExpression(null)).toBe('')
    expect(formatConditionExpression({ op: 'eq' })).toBe('{\n  "op": "eq"\n}')
  })
})
