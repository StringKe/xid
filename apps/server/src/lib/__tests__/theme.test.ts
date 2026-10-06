import { describe, expect, it } from 'vitest'
import { DEFAULT_BRAND, brandToCssVars } from '../theme'
import type { BrandConfig } from '../theme'

describe('brandToCssVars', () => {
  it('默认品牌不产生 inline 覆盖,交给 tokens 与 darkTheme', () => {
    expect(brandToCssVars(DEFAULT_BRAND, 'light')).toEqual({})
    expect(brandToCssVars(DEFAULT_BRAND, 'dark')).toEqual({})
  })

  it('租户强调色只覆盖 accent 家族与圆角', () => {
    const custom: BrandConfig = { ...DEFAULT_BRAND, accent: '#0b6bcb', radius: '1rem' }

    const vars = brandToCssVars(custom, 'light')

    expect(Object.keys(vars).sort()).toEqual([
      '--xid-accent',
      '--xid-accent-foreground',
      '--xid-accent-strong',
      '--xid-accent-wash',
      '--xid-info',
      '--xid-info-bg',
      '--xid-info-foreground',
      '--xid-radius',
    ])
    expect(vars['--xid-radius']).toBe('1rem')
    expect(vars['--xid-primary']).toBeUndefined()
  })

  it('非法颜色不覆盖 accent', () => {
    const vars = brandToCssVars({ ...DEFAULT_BRAND, accent: 'not-a-color' }, 'dark')

    expect(vars['--xid-accent']).toBeUndefined()
  })
})
