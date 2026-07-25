// theme 测试:brandToCssVars 纯函数把 brand + scheme 展开为 CSS 变量(light/dark 切换、自定义品牌覆盖)。

import { describe, expect, it } from 'vitest'
import { DEFAULT_BRAND, brandToCssVars } from '../theme'
import type { BrandConfig } from '../theme'

describe('brandToCssVars', () => {
  it('light scheme 用 light palette', () => {
    const vars = brandToCssVars(DEFAULT_BRAND, 'light')

    expect(vars['--xid-primary']).toBe(DEFAULT_BRAND.light.primary)
    expect(vars['--xid-bg']).toBe(DEFAULT_BRAND.light.background)
  })

  it('dark scheme 用 dark palette', () => {
    const vars = brandToCssVars(DEFAULT_BRAND, 'dark')

    expect(vars['--xid-primary']).toBe(DEFAULT_BRAND.dark.primary)
    expect(vars['--xid-bg']).toBe(DEFAULT_BRAND.dark.background)
  })

  it('radius / font 来自 brand 顶层尺度,不随 scheme 变', () => {
    const vars = brandToCssVars(DEFAULT_BRAND, 'dark')

    expect(vars['--xid-radius']).toBe(DEFAULT_BRAND.radius)
    expect(vars['--xid-font']).toBe(DEFAULT_BRAND.fontFamily)
  })

  it('自定义品牌覆盖默认色(per-tenant/org 白标)', () => {
    const custom: BrandConfig = {
      ...DEFAULT_BRAND,
      light: { ...DEFAULT_BRAND.light, primary: '#ff0000' },
      radius: '1rem',
    }

    const vars = brandToCssVars(custom, 'light')

    expect(vars['--xid-primary']).toBe('#ff0000')
    expect(vars['--xid-radius']).toBe('1rem')
  })
})
