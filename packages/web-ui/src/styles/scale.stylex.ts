// 字号、行高、字重、间距与控件尺寸。用 defineVars:开发服务器按模块收集 CSS,defineConsts 在那里解析不到。
// 断点与容器查询不能用变量,组件里直接写 '@media (max-width: 47.99rem)' 等字面键,档位见 responsive.ts。
// tokens.css 以 --xid-<组>-<键 kebab> 输出同一组值(text.hero -> --xid-text-hero),契约测试逐项比对。

import * as stylex from '@stylexjs/stylex'

export const text = stylex.defineVars({
  xs: '0.75rem',
  sm: '0.8125rem',
  base: '0.875rem',
  md: '1rem',
  lg: '1.25rem',
  xl: '1.75rem',
  xxl: '2.5rem',
  xxxl: '3.5rem',
  hero: 'clamp(2.5rem, 1.6rem + 2.6vw, 3.5rem)',
})

export const leading = stylex.defineVars({
  xs: '1rem',
  sm: '1.125rem',
  base: '1.25rem',
  md: '1.5rem',
  lg: '1.625rem',
  xl: '2.125rem',
  xxl: '2.75rem',
  xxxl: '3.75rem',
  hero: '1.05',
  body: '1.55',
})

export const weight = stylex.defineVars({
  regular: '400',
  medium: '500',
  display: '560',
})

export const space = stylex.defineVars({
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
  s24: '6rem',
  s32: '8rem',
})

export const size = stylex.defineVars({
  control: '2.25rem',
  touch: '2.75rem',
  rowCompact: '2rem',
  rowDefault: '2.5rem',
  rowComfortable: '3rem',
  formWidth: '25rem',
  proseWidth: '40rem',
  pageWidth: '70rem',
  docsWidth: '43.5rem',
  docsWidthWide: '52rem',
})
