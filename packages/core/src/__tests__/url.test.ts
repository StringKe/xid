import { describe, expect, it } from 'vitest'

import { trimTrailingSlashes } from '../url'

describe('trimTrailingSlashes', () => {
  it.each([
    ['', ''],
    ['https://api.xid.dev', 'https://api.xid.dev'],
    ['https://api.xid.dev/', 'https://api.xid.dev'],
    ['https://api.xid.dev////', 'https://api.xid.dev'],
    ['////', ''],
  ])('normalizes %s', (input, expected) => {
    expect(trimTrailingSlashes(input)).toBe(expected)
  })
})
