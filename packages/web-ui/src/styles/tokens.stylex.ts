// 显式 --xid-* 键保证 CSS 变量名稳定,运行时品牌 inline override 与 :lang() 覆盖可命中。
// 品牌只覆盖 accent 家族与圆角;其余色值固定,深色值逐项过 WCAG(文字 4.5:1,控件 3:1)。

import * as stylex from '@stylexjs/stylex'

const SANS =
  '"Geist Variable", "PingFang SC", "Hiragino Sans", "Noto Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", "Apple SD Gothic Neo", "Malgun Gothic", system-ui, -apple-system, "Segoe UI", sans-serif'
const MONO = '"Geist Mono Variable", ui-monospace, "SF Mono", Menlo, Consolas, monospace'

export const tokens = stylex.defineVars({
  '--xid-primary': '#161616',
  '--xid-primary-foreground': '#ffffff',
  '--xid-bg': '#ffffff',
  '--xid-surface': '#ffffff',
  '--xid-sidebar': '#f6f6f6',
  '--xid-muted': '#eeeeee',
  '--xid-fg': '#161616',
  '--xid-muted-foreground': '#5c5c5c',
  '--xid-faint-foreground': '#6b6b6b',
  '--xid-border': '#e6e6e6',
  '--xid-border-strong': '#8c8c8c',

  '--xid-accent': '#2e5fa3',
  '--xid-accent-strong': '#244c84',
  '--xid-accent-wash': '#eaf0f8',
  '--xid-accent-foreground': '#ffffff',

  '--xid-danger': '#b42318',
  '--xid-danger-foreground': '#ffffff',
  '--xid-danger-bg': '#fdeeec',
  '--xid-warning': '#9a5b00',
  '--xid-warning-foreground': '#ffffff',
  '--xid-warning-bg': '#fdf3e3',
  '--xid-success': '#1e7a46',
  '--xid-success-foreground': '#ffffff',
  '--xid-success-bg': '#eaf6ef',
  '--xid-info': '#2e5fa3',
  '--xid-info-foreground': '#ffffff',
  '--xid-info-bg': '#eaf0f8',

  '--xid-code': '#141414',
  '--xid-code-foreground': '#e6e6e6',
  '--xid-scrim': 'rgb(0 0 0 / 0.4)',

  '--xid-radius-sm': '0.25rem',
  '--xid-radius': '0.375rem',
  '--xid-radius-lg': '0.625rem',
  '--xid-radius-full': '999px',

  '--xid-shadow-sm': '0 1px 2px rgb(0 0 0 / 0.06)',
  '--xid-shadow-md': '0 8px 24px rgb(0 0 0 / 0.08)',
  '--xid-shadow-lg': '0 16px 40px rgb(0 0 0 / 0.16)',

  '--xid-font': SANS,
  '--xid-font-mono': MONO,

  '--xid-tracking-display': '-0.025em',
  '--xid-tracking-heading': '-0.015em',
  '--xid-tracking-title': '-0.01em',
  '--xid-tracking-small': '0.01em',
})

export const darkTheme = stylex.createTheme(tokens, {
  '--xid-primary': '#ededed',
  '--xid-primary-foreground': '#141414',
  '--xid-bg': '#181818',
  '--xid-surface': '#181818',
  '--xid-sidebar': '#111111',
  '--xid-muted': '#262626',
  '--xid-fg': '#ededed',
  '--xid-muted-foreground': '#a8a8a8',
  '--xid-faint-foreground': '#8c8c8c',
  '--xid-border': '#2a2a2a',
  '--xid-border-strong': '#6e6e6e',

  '--xid-accent': '#7fa6de',
  '--xid-accent-strong': '#a3c0e8',
  '--xid-accent-wash': '#18202b',
  '--xid-accent-foreground': '#0d1726',

  '--xid-danger': '#f07a6e',
  '--xid-danger-foreground': '#141414',
  '--xid-danger-bg': '#311a18',
  '--xid-warning': '#e2a64f',
  '--xid-warning-foreground': '#141414',
  '--xid-warning-bg': '#2e2210',
  '--xid-success': '#5fc48a',
  '--xid-success-foreground': '#141414',
  '--xid-success-bg': '#15281d',
  '--xid-info': '#7fa6de',
  '--xid-info-foreground': '#0d1726',
  '--xid-info-bg': '#18202b',

  '--xid-code': '#0c0c0c',
  '--xid-code-foreground': '#e6e6e6',
  '--xid-scrim': 'rgb(0 0 0 / 0.6)',

  '--xid-shadow-sm': '0 1px 2px rgb(0 0 0 / 0.4)',
  '--xid-shadow-md': '0 8px 24px rgb(0 0 0 / 0.45)',
  '--xid-shadow-lg': '0 16px 40px rgb(0 0 0 / 0.55)',
})
