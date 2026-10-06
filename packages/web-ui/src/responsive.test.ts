import { describe, expect, it } from 'vitest'
import { resolveResponsive, viewportMediaQuery } from './responsive'
import { responsiveHiddenClassName } from './components/ui/responsive-hidden'

describe('resolveResponsive', () => {
  it('uses the fallback everywhere when the prop is omitted', () => {
    expect(resolveResponsive(undefined, 'center')).toEqual({
      narrow: 'center',
      regular: 'center',
      sidebar: 'center',
      wide: 'center',
    })
  })

  it('applies a scalar to every viewport', () => {
    expect(resolveResponsive('sheet', 'center').wide).toBe('sheet')
  })

  it('inherits mobile-first from the nearest narrower viewport', () => {
    expect(resolveResponsive({ narrow: 'fullscreen', regular: 'center' }, 'sheet')).toEqual({
      narrow: 'fullscreen',
      regular: 'center',
      sidebar: 'center',
      wide: 'center',
    })
  })

  it('falls back for narrow when only wider viewports are given', () => {
    expect(resolveResponsive({ sidebar: 'side' }, 'sheet')).toEqual({
      narrow: 'sheet',
      regular: 'sheet',
      sidebar: 'side',
      wide: 'side',
    })
  })
})

describe('viewportMediaQuery', () => {
  it('builds rem queries that switch with the user font size', () => {
    expect(viewportMediaQuery('narrow')).toBe('(max-width: calc(48rem - 0.01rem))')
    expect(viewportMediaQuery('wide')).toBe('(min-width: 90rem)')
  })
})

describe('responsiveHiddenClassName', () => {
  it('hides only the viewports that are listed', () => {
    expect(responsiveHiddenClassName({ narrow: true })).toBe('xid-hidden-narrow')
    expect(responsiveHiddenClassName({ regular: true, wide: true })).toBe(
      'xid-hidden-regular xid-hidden-wide',
    )
  })

  it('hides everywhere for true and nowhere for false or undefined', () => {
    expect(responsiveHiddenClassName(true)).toBe(
      'xid-hidden-narrow xid-hidden-regular xid-hidden-sidebar xid-hidden-wide',
    )
    expect(responsiveHiddenClassName(false)).toBeUndefined()
    expect(responsiveHiddenClassName(undefined)).toBeUndefined()
  })
})
