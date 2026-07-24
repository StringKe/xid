// 字面量落地色板 (OKLCH),用于无法取 var 的场景:
//   - color-mix 字符串组合(SiteChrome 的下划线 resting tint)
//   - runtime 索引的 syntax token 色(CodeBlock 的 KIND_COLOR 对象)
//
// 与 landing-theme.stylex.ts 的语义对应关系:
//   ink / page  -- 对应产品 --xid-accent / --xid-bg,此处保留字面值是因为
//                  color-mix() 的字符串参数无法接受 CSS var(),必须用字面 OKLCH。
//   onCode      -- 代码块专用,字面深色值。
//
// SYNTAX 高亮色板保持字面值:代码块亮暗两态都用深色底,不随 dark mode 翻转。
// 若产品 token 值变更,请同步更新此处对应字面值。

const SYNTAX = {
  keyword: 'oklch(0.72 0.12 300)',
  string: 'oklch(0.78 0.11 150)',
  fn: 'oklch(0.79 0.12 250)',
  // comment/punctuation 提亮到 4.5:1 以上(code 底):注释是可读正文不是装饰。
  comment: 'oklch(0.68 0.02 282)',
  punctuation: 'oklch(0.7 0.018 282)',
  property: 'oklch(0.82 0.09 80)',
} as const

export const LX_RAW = {
  // light 下产品 --xid-accent 字面值,用于 color-mix 字符串(var() 在此不可用)
  ink: 'oklch(0.52 0.19 277)',
  // light 下产品 --xid-bg 字面值,用于 color-mix 字符串(var() 在此不可用)
  page: 'oklch(0.985 0.004 280)',
  // 代码块固定深色底上的文字色
  onCode: 'oklch(0.9 0.012 280)',
  syntax: SYNTAX,
} as const
