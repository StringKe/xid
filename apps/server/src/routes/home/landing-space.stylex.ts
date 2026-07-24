// Landing 间距阶:供 stylex.create 引用(须 defineVars,不可从普通 .ts 导入)。

import * as stylex from '@stylexjs/stylex'

export const space = stylex.defineVars({
  tight: '0.375rem',
  snug: '0.625rem',
  base: '0.875rem',
  roomy: '1.25rem',
  loose: '1.75rem',
})
