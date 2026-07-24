import { describe, expect, it } from 'vitest'
import { mergeClassNames } from './class-name'

describe('mergeClassNames', () => {
  it('keeps only string class names', () => {
    expect(mergeClassNames('base', undefined, false, null, 'active')).toBe('base active')
  })

  it('returns undefined when no string class name exists', () => {
    expect(mergeClassNames(undefined, false, null)).toBeUndefined()
  })
})
