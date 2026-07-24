// Landing-scoped StyleX vars。并入产品 --xid-* token 体系,跟随 light/dark 与品牌覆盖。
// 仅代码块保持深色高亮:code/codeRaised/onCode/onCodeDim/onCodeLine/onCodeLineStrong/
// onCodeOk/onCodeOut/mono 及 SYNTAX 保留字面深色值。
//
// defineVars 值必须是静态可分析的字面量或 tokens[...] 引用;StyleX 将 tokens[...] 编译
// 为 var(--xid-*),跟随 darkTheme / per-tenant 覆盖自动翻转。
// 对应的字面量副本在 landing-palette.ts (LX_RAW),仅用于无法取 var 的场景
// (color-mix 字符串组合、runtime 索引的 syntax 色)。

import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'

export const lx = stylex.defineVars({
  // 品牌强调色 -- 跟随产品 accent/primary token
  ink: tokens['--xid-accent'],
  inkStrong: tokens['--xid-primary'],
  // inkSoft 近似:accent 色相低饱和过渡,保留字面值以保持 landing 独有的柔和渐层
  inkSoft: 'color-mix(in oklch, var(--xid-accent) 55%, var(--xid-primary))',

  // 页面中性层次 -- 跟随产品 bg/surface/muted token
  page: tokens['--xid-bg'],
  raised: tokens['--xid-surface'],
  sunken: tokens['--xid-muted'],

  // 代码块深色底 -- 保留字面深色值,亮暗两态都用深色高亮色板
  code: 'oklch(0.27 0.027 280)',
  codeRaised: 'oklch(0.31 0.03 280)',

  // 正文色阶 -- 跟随产品 fg/muted-foreground token
  primary: tokens['--xid-fg'],
  secondary: tokens['--xid-muted-foreground'],
  muted: tokens['--xid-muted-foreground'],

  // 反色(用于深色代码块上的 ink 按钮文字) -- 跟随产品 primary-foreground
  onInk: tokens['--xid-primary-foreground'],

  // 代码块上的文字 -- 保留字面深色值
  onCode: 'oklch(0.9 0.012 280)',
  // 0.70:chrome 行(codeRaised 底)上 4.9:1,过 4.5 正文红线。
  onCodeDim: 'oklch(0.7 0.018 282)',

  // 分割线 -- 跟随产品 border/border-strong token
  hairline: tokens['--xid-border'],
  strong: tokens['--xid-border-strong'],

  // 代码块内分割线 -- 保留字面深色值;Strong 为 hover 提亮档(replay/copy 按钮描边)
  onCodeLine: 'oklch(0.38 0.03 280)',
  onCodeLineStrong: 'oklch(0.5 0.02 280)',

  // 代码块上的状态色 -- trace ok 行 / out 行,与 SYNTAX.string / SYNTAX.fn 同值
  onCodeOk: 'oklch(0.78 0.11 150)',
  onCodeOut: 'oklch(0.79 0.12 250)',

  // 字体族 -- 跟随产品 font token(品牌可覆盖);mono 保留字面值(代码块固定等宽字体)
  sans: tokens['--xid-font'],
  mono: 'ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace',
})
