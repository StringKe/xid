import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { randomString } from '../random'

const SYMBOLS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'.split('')

describe('randomString properties', () => {
  it('always respects requested length and alphabet', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 512 }),
        fc
          .uniqueArray(fc.constantFrom(...SYMBOLS), { minLength: 2, maxLength: SYMBOLS.length })
          .map((symbols) => symbols.join('')),
        (length, alphabet) => {
          const value = randomString(length, alphabet)
          expect(value).toHaveLength(length)
          for (const character of value) {
            expect(alphabet).toContain(character)
          }
        },
      ),
      { numRuns: 500 },
    )
  }, 15_000)
})
