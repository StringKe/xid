import { describe, expect, it } from 'vitest'

import { trimLeadingSlashes, trimTrailingSlashes } from './url'

describe('URL slash normalization', () => {
  it('removes every trailing slash', () => {
    expect(trimTrailingSlashes('https://xid.dev////')).toBe('https://xid.dev')
  })

  it('removes every leading slash', () => {
    expect(trimLeadingSlashes('////Users')).toBe('Users')
  })
})
