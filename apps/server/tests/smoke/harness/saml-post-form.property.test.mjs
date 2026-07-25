import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { escapeHtmlAttribute } from './saml-post-form.mjs'

describe('escapeHtmlAttribute properties', () => {
  it('removes every raw attribute-breaking character', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 4096 }), (value) => {
        const escaped = escapeHtmlAttribute(value)

        expect(escaped).not.toMatch(/[<>"']/u)
      }),
      { numRuns: 500 },
    )
  })
})
