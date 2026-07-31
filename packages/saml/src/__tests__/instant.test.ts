import { describe, expect, it } from 'vitest'

import { parseSamlInstant } from '../instant'

describe('parseSamlInstant', () => {
  it('accepts the SAML date-time profile with UTC, fractions, and offsets', () => {
    expect(parseSamlInstant('2026-07-29T09:00:00Z')).toBe(Date.parse('2026-07-29T09:00:00Z'))
    expect(parseSamlInstant('2026-07-29T09:00:00.123456Z')).toBe(
      Date.parse('2026-07-29T09:00:00.123Z'),
    )
    expect(parseSamlInstant('2026-07-29T13:00:00+04:00')).toBe(Date.parse('2026-07-29T09:00:00Z'))
  })

  it.each([
    null,
    '',
    '2026-07-29',
    '2026-07-29T09:00:00',
    '2026-02-30T09:00:00Z',
    '0000-01-01T00:00:00Z',
    '2026-07-29T24:00:00Z',
    '2026-07-29T09:00:00+14:01',
  ])('rejects an invalid SAML date-time: %s', (value) => {
    expect(parseSamlInstant(value)).toBeNull()
  })
})
