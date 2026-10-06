// 编译期常量:字号、行高、字重、间距、控件尺寸与断点。断点用 rem,放大字号时布局一起切换。

import * as stylex from '@stylexjs/stylex'

export const media = stylex.defineConsts({
  narrow: '@media (max-width: 47.99rem)',
  regular: '@media (min-width: 48rem)',
  sidebar: '@media (min-width: 64rem)',
  wide: '@media (min-width: 90rem)',
  coarse: '@media (pointer: coarse)',
  hover: '@media (hover: hover)',
  reducedMotion: '@media (prefers-reduced-motion: reduce)',
})

export const container = stylex.defineConsts({
  keyValueSideBySide: '@container (min-width: 32rem)',
  settingsSideBySide: '@container (min-width: 48rem)',
  tableComfortable: '@container (min-width: 40rem)',
})

export const text = stylex.defineConsts({
  xs: '0.75rem',
  sm: '0.8125rem',
  base: '0.875rem',
  md: '1rem',
  lg: '1.25rem',
  xl: '1.75rem',
  xxl: '2.5rem',
  xxxl: '3.5rem',
})

export const leading = stylex.defineConsts({
  xs: '1rem',
  sm: '1.125rem',
  base: '1.25rem',
  md: '1.5rem',
  lg: '1.625rem',
  xl: '2.125rem',
  xxl: '2.75rem',
  xxxl: '3.75rem',
  body: '1.55',
})

export const weight = stylex.defineConsts({
  regular: '400',
  medium: '500',
  display: '560',
})

export const space = stylex.defineConsts({
  s1: '0.25rem',
  s2: '0.5rem',
  s3: '0.75rem',
  s4: '1rem',
  s5: '1.25rem',
  s6: '1.5rem',
  s8: '2rem',
  s10: '2.5rem',
  s12: '3rem',
  s16: '4rem',
})

export const size = stylex.defineConsts({
  control: '2.25rem',
  touch: '2.75rem',
  rowCompact: '2rem',
  rowDefault: '2.5rem',
  rowComfortable: '3rem',
  formWidth: '25rem',
  proseWidth: '40rem',
  pageWidth: '70rem',
})
