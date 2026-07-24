// StyleX 主题 tokens:defineVars 生成命名 CSS 变量(--xid-*),组件经 stylex.create 引用。
// 三层主题策略:
//   1. defineVars 默认值 = light 基线(蓝紫 ink 身份,非 SaaS 亮紫)。
//   2. darkTheme = createTheme 覆盖,挂到 data-theme=dark 容器实现 light/dark 切换。
//   3. per-tenant/org 运行时品牌:从 KV 拉任意颜色,对同名 CSS 变量做 inline override(见 lib/theme.tsx)。
// 变量名用 --xid-* 显式键,保证生成的 CSS 自定义属性名稳定,运行时 inline override 可命中。
//
// 体系分组:
//   - 核心色(primary/bg/fg/muted/accent/border/surface/sidebar):品牌可运行时覆盖。
//   - 语义对(danger/warning/success/info 各 fg + bg):状态色,不进品牌覆盖,组件直引。
//   - 尺度(radius 阶 / shadow 阶 / 字体):结构 token,随 light/dark 翻转,不进品牌覆盖。
// 中性层次刻意拉开:bg(页面下沉) < sidebar < muted,surface 浮于 bg 之上,给卡片/面板真实景深。

import * as stylex from '@stylexjs/stylex'

export const tokens = stylex.defineVars({
  // 核心色(品牌可覆盖)
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

  // 语义对:danger / warning / success / info(各 base + foreground + 浅底 bg)
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

  // 圆角阶
  '--xid-radius-sm': '0.3125rem',
  '--xid-radius': '0.5rem',
  '--xid-radius-lg': '0.875rem',
  '--xid-radius-full': '999px',

  // 阴影阶(OKLCH,light:fg 色相低 alpha 投影;dark 在 createTheme 覆盖)
  '--xid-shadow-sm':
    '0 1px 2px oklch(0.27 0.022 280 / 0.05), 0 1px 1px oklch(0.27 0.022 280 / 0.04)',
  '--xid-shadow-md':
    '0 2px 4px oklch(0.27 0.022 280 / 0.05), 0 6px 16px oklch(0.27 0.022 280 / 0.08)',
  '--xid-shadow-lg':
    '0 4px 8px oklch(0.27 0.022 280 / 0.06), 0 16px 40px oklch(0.27 0.022 280 / 0.12)',

  // 字体族(Inter Variable 经 @fontsource-variable/inter 在 main.tsx 注入)
  '--xid-font':
    '"Inter Variable", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  '--xid-font-mono':
    'ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace',
})

export const darkTheme = stylex.createTheme(tokens, {
  // 核心色
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

  // 语义对(dark:base 提亮,bg 用低亮高色暗底)
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

  // 阴影阶(dark:纯黑投影更深,景深靠暗影)
  '--xid-shadow-sm': '0 1px 2px oklch(0 0 0 / 0.3), 0 1px 1px oklch(0 0 0 / 0.2)',
  '--xid-shadow-md': '0 2px 4px oklch(0 0 0 / 0.3), 0 6px 16px oklch(0 0 0 / 0.4)',
  '--xid-shadow-lg': '0 4px 8px oklch(0 0 0 / 0.35), 0 16px 40px oklch(0 0 0 / 0.5)',
})
