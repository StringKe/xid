import { describe, expect, it } from 'vitest'
import { hasGeneratedDocsBase } from './content-config-contract'

describe('hasGeneratedDocsBase', () => {
  it.each(["base: 'generated/docs'", 'base: "generated/docs"', "base :\n  'generated/docs'"])(
    'accepts a generated docs base regardless of formatting: %s',
    (source) => {
      expect(hasGeneratedDocsBase(source)).toBe(true)
    },
  )

  it('rejects a broader content root', () => {
    expect(hasGeneratedDocsBase("base: 'generated'")).toBe(false)
  })
})
