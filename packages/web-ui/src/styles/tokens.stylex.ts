// 显式 --xid-* 键保证 CSS 变量名稳定,运行时品牌 inline override 可命中。
// 核心色可品牌覆盖;语义色/尺度不进品牌覆盖。层次:bg < sidebar < muted,surface 浮于 bg 上。

import * as stylex from '@stylexjs/stylex'

export const tokens = stylex.defineVars({
  '--xid-primary': 'oklch(0.43 0.2 278)',
  '--xid-primary-foreground': 'oklch(0.985 0.004 280)',
  '--xid-bg': 'oklch(0.985 0.004 282)',
  '--xid-fg': 'oklch(0.27 0.022 280)',
  '--xid-muted': 'oklch(0.955 0.007 282)',
  '--xid-muted-foreground': 'oklch(0.44 0.018 281)',
  '--xid-accent': 'oklch(0.52 0.19 277)',
  '--xid-border': 'oklch(0.9 0.008 282)',
  '--xid-border-strong': 'oklch(0.83 0.012 282)',
  '--xid-surface': 'oklch(0.998 0.002 280)',
  '--xid-sidebar': 'oklch(0.975 0.005 282)',

  '--xid-danger': 'oklch(0.55 0.2 25)',
  '--xid-danger-foreground': 'oklch(0.985 0.004 280)',
  '--xid-danger-bg': 'oklch(0.955 0.035 25)',
  '--xid-warning': 'oklch(0.72 0.14 75)',
  '--xid-warning-foreground': 'oklch(0.27 0.04 75)',
  '--xid-warning-bg': 'oklch(0.955 0.05 85)',
  '--xid-success': 'oklch(0.52 0.14 145)',
  '--xid-success-foreground': 'oklch(0.985 0.004 280)',
  '--xid-success-bg': 'oklch(0.955 0.04 145)',
  '--xid-info': 'oklch(0.52 0.16 250)',
  '--xid-info-foreground': 'oklch(0.985 0.004 280)',
  '--xid-info-bg': 'oklch(0.955 0.04 250)',

  '--xid-radius-sm': '0.3125rem',
  '--xid-radius': '0.5rem',
  '--xid-radius-lg': '0.875rem',
  '--xid-radius-full': '999px',

  '--xid-shadow-sm':
    '0 1px 2px oklch(0.27 0.022 280 / 0.05), 0 1px 1px oklch(0.27 0.022 280 / 0.04)',
  '--xid-shadow-md':
    '0 2px 4px oklch(0.27 0.022 280 / 0.05), 0 6px 16px oklch(0.27 0.022 280 / 0.08)',
  '--xid-shadow-lg':
    '0 4px 8px oklch(0.27 0.022 280 / 0.06), 0 16px 40px oklch(0.27 0.022 280 / 0.12)',

  '--xid-font':
    '"Inter Variable", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  '--xid-font-mono':
    'ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace',
})

export const darkTheme = stylex.createTheme(tokens, {
  '--xid-primary': 'oklch(0.62 0.14 278)',
  '--xid-primary-foreground': 'oklch(0.16 0.02 280)',
  '--xid-bg': 'oklch(0.18 0.022 280)',
  '--xid-fg': 'oklch(0.93 0.01 280)',
  '--xid-muted': 'oklch(0.26 0.027 280)',
  '--xid-muted-foreground': 'oklch(0.7 0.018 282)',
  '--xid-accent': 'oklch(0.72 0.12 278)',
  '--xid-border': 'oklch(0.32 0.028 280)',
  '--xid-border-strong': 'oklch(0.42 0.03 280)',
  '--xid-surface': 'oklch(0.225 0.024 280)',
  '--xid-sidebar': 'oklch(0.2 0.023 280)',

  '--xid-danger': 'oklch(0.68 0.17 25)',
  '--xid-danger-foreground': 'oklch(0.16 0.02 280)',
  '--xid-danger-bg': 'oklch(0.32 0.07 25)',
  '--xid-warning': 'oklch(0.78 0.12 85)',
  '--xid-warning-foreground': 'oklch(0.2 0.03 85)',
  '--xid-warning-bg': 'oklch(0.34 0.06 85)',
  '--xid-success': 'oklch(0.72 0.12 145)',
  '--xid-success-foreground': 'oklch(0.16 0.02 280)',
  '--xid-success-bg': 'oklch(0.3 0.06 145)',
  '--xid-info': 'oklch(0.7 0.12 250)',
  '--xid-info-foreground': 'oklch(0.16 0.02 280)',
  '--xid-info-bg': 'oklch(0.3 0.07 250)',

  '--xid-shadow-sm': '0 1px 2px oklch(0 0 0 / 0.3), 0 1px 1px oklch(0 0 0 / 0.2)',
  '--xid-shadow-md': '0 2px 4px oklch(0 0 0 / 0.3), 0 6px 16px oklch(0 0 0 / 0.4)',
  '--xid-shadow-lg': '0 4px 8px oklch(0 0 0 / 0.35), 0 16px 40px oklch(0 0 0 / 0.5)',
})
