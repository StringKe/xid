import { describe, expect, it } from 'vitest'
import { normalizePhoneNumber } from '../phone'

describe('normalizePhoneNumber', () => {
  it('maps differently formatted spellings of one number to the same E.164 value', () => {
    const spellings = ['+15550000000', '+1 555 000 0000', '+1-555-000-0000', ' +1 (555) 000.0000 ']

    const normalized = spellings.map(normalizePhoneNumber)

    expect(new Set(normalized)).toEqual(new Set(['+15550000000']))
  })

  it('rejects numbers without a leading plus, with a zero country code, or outside the E.164 length', () => {
    const invalid = ['15550000000', '+05550000000', '+12345', '+1234567890123456', '+1 555 abc', '']

    expect(invalid.map(normalizePhoneNumber)).toEqual(invalid.map(() => null))
  })
})
