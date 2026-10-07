// Console 外壳的共享样式:侧栏 248px(≥64rem 常驻)、56px 顶栏、导航项 28px、分组标签 24px。
// 窄于 64rem 时侧栏收进抽屉;<48rem 顶栏改为「作用域 + 当前分区 + 搜索 + Menu」。

import * as stylex from '@stylexjs/stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'

export const shell = stylex.create({
  root: {
    minHeight: '100dvh',
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr)',
      '@media (min-width: 64rem)': '15.5rem minmax(0, 1fr)',
    },
    backgroundColor: tokens['--xid-surface'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
  },
  aside: {
    display: { default: 'none', '@media (min-width: 64rem)': 'block' },
    minWidth: 0,
    backgroundColor: tokens['--xid-sidebar'],
    borderInlineEndWidth: '1px',
    borderInlineEndStyle: 'solid',
    borderInlineEndColor: tokens['--xid-border'],
  },
  asidePin: {
    position: 'sticky',
    top: 0,
    height: '100dvh',
    display: 'flex',
    flexDirection: 'column',
  },
  workspace: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  main: {
    flexGrow: 1,
    minWidth: 0,
  },
  band: {
    paddingBlock: '0.75rem',
    paddingInline: {
      default: '1rem',
      '@media (min-width: 48rem)': '1.5rem',
      '@media (min-width: 64rem)': '2.5rem',
    },
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  bandRow: {
    display: 'flex',
    flexDirection: { default: 'column', '@media (min-width: 48rem)': 'row' },
    alignItems: { default: 'stretch', '@media (min-width: 48rem)': 'center' },
    gap: '0.75rem',
  },
  bandMessage: {
    flexGrow: 1,
    minWidth: 0,
  },
})

export const nav = stylex.create({
  scopeRow: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    minHeight: '3.5rem',
    paddingInline: '0.75rem',
  },
  region: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
    paddingTop: '0.25rem',
    paddingBottom: '1rem',
    paddingInline: '0.75rem',
  },
  groups: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  group: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
  },
  groupLabel: {
    display: 'flex',
    alignItems: 'center',
    minHeight: '1.5rem',
    margin: 0,
    paddingInline: '0.5rem',
    fontSize: text.xs,
    lineHeight: leading.xs,
    fontWeight: weight.medium,
    letterSpacing: tokens['--xid-tracking-small'],
    color: tokens['--xid-faint-foreground'],
  },
  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
  },
  item: {
    position: 'relative',
  },
  link: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.5rem',
    minHeight: { default: '1.75rem', '@media (pointer: coarse)': '2.75rem' },
    paddingInline: '0.5rem',
    borderRadius: tokens['--xid-radius-sm'],
    color: { default: tokens['--xid-muted-foreground'], ':hover': tokens['--xid-fg'] },
    textDecoration: 'none',
    fontSize: { default: text.base, '@media (max-width: 47.99rem)': text.md },
    lineHeight: leading.sm,
    outlineColor: tokens['--xid-accent'],
    outlineOffset: '-2px',
    transitionProperty: 'color',
    transitionDuration: '120ms',
  },
  linkActive: {
    color: tokens['--xid-fg'],
    fontWeight: weight.medium,
  },
  linkText: {
    position: 'relative',
    minWidth: 0,
    overflowWrap: 'anywhere',
  },
  count: {
    position: 'relative',
    flexShrink: 0,
    fontSize: text.xs,
    fontVariantNumeric: 'tabular-nums',
    color: tokens['--xid-faint-foreground'],
  },
  countActive: {
    color: tokens['--xid-muted-foreground'],
  },
  indicator: {
    position: 'absolute',
    inset: 0,
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: tokens['--xid-surface'],
    boxShadow: `0 0 0 1px ${tokens['--xid-border']}`,
    pointerEvents: 'none',
  },
})
