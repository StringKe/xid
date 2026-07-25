import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { trimTrailingSlashes } from '../url'

describe('trimTrailingSlashes properties', () => {
  it('removes only the trailing slash suffix', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 4096 }).filter((value) => !value.endsWith('/')),
        fc.integer({ min: 0, max: 256 }),
        (prefix, slashCount) => {
          const input = `${prefix}${'/'.repeat(slashCount)}`
          const result = trimTrailingSlashes(input)

          expect(result).toBe(prefix)
          expect(result.endsWith('/')).toBe(false)
        },
      ),
      { numRuns: 500 },
    )
  })
})
