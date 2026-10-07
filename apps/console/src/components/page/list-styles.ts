// 列表页共用:筛选栏(检索 + 筛选按钮 + 主按钮在右)、可删除筛选条件行、计数、行尾菜单、分页。

import * as stylex from '@stylexjs/stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'

export const list = stylex.create({
  bar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.5rem',
  },
  barEnd: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.5rem',
    marginInlineStart: { default: 0, '@media (min-width: 48rem)': 'auto' },
  },
  search: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    flex: { default: '1 1 100%', '@media (min-width: 48rem)': '0 1 20rem' },
    minWidth: 0,
  },
  searchIcon: {
    position: 'absolute',
    insetInlineStart: '0.75rem',
    display: 'inline-flex',
    color: tokens['--xid-muted-foreground'],
    pointerEvents: 'none',
  },
  searchInput: {
    width: '100%',
    height: { default: '2.75rem', '@media (min-width: 48rem)': '2.25rem' },
    paddingInlineStart: '2.25rem',
    paddingInlineEnd: '0.75rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border-strong'],
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-surface'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: 'max(16px, 0.875rem)',
    outlineColor: tokens['--xid-accent'],
    boxSizing: 'border-box',
  },
  filterButton: {
    gap: '0.5rem',
    height: { default: '2.75rem', '@media (min-width: 48rem)': '2.25rem' },
    paddingInline: '0.75rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border-strong'],
    borderRadius: tokens['--xid-radius'],
    backgroundColor: { default: tokens['--xid-surface'], ':hover': tokens['--xid-muted'] },
    color: tokens['--xid-fg'],
    fontSize: text.base,
    whiteSpace: 'nowrap',
  },
  filterValue: {
    fontWeight: weight.medium,
  },
  summaryRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.5rem 0.75rem',
    minHeight: '1.75rem',
  },
  summary: {
    fontSize: text.sm,
    fontWeight: weight.medium,
    fontVariantNumeric: 'tabular-nums',
    color: tokens['--xid-fg'],
  },
  chips: {
    display: 'flex',
    flexWrap: { default: 'nowrap', '@media (min-width: 48rem)': 'wrap' },
    gap: '0.5rem',
    overflowX: { default: 'auto', '@media (min-width: 48rem)': 'visible' },
    maxWidth: '100%',
  },
  textButton: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: tokens['--xid-accent'],
    fontFamily: tokens['--xid-font'],
    fontSize: text.sm,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  footer: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
  },
  footnote: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: tokens['--xid-muted-foreground'],
  },
  pager: {
    display: 'flex',
    gap: '0.5rem',
    flex: { default: '1 1 100%', '@media (min-width: 48rem)': '0 0 auto' },
  },
  pagerButton: {
    flex: { default: '1 1 0', '@media (min-width: 48rem)': '0 0 auto' },
  },
  rowMenu: {
    display: 'inline-flex',
    justifyContent: 'flex-end',
  },
  iconButton: {
    justifyContent: 'center',
    width: { default: '2.75rem', '@media (pointer: fine)': '2rem' },
    height: { default: '2.75rem', '@media (pointer: fine)': '2rem' },
    borderRadius: tokens['--xid-radius'],
    color: tokens['--xid-muted-foreground'],
    backgroundColor: { default: 'transparent', ':hover': tokens['--xid-muted'] },
  },
  muted: {
    color: tokens['--xid-muted-foreground'],
  },
  numeric: {
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  cellStack: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  cellSub: {
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: tokens['--xid-muted-foreground'],
  },
  breakable: {
    overflowWrap: 'anywhere',
  },
  mono: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.xs,
    color: tokens['--xid-muted-foreground'],
    overflowWrap: 'anywhere',
  },
  hideNarrow: {
    display: { default: 'none', '@media (min-width: 48rem)': 'inline-flex' },
  },
  onlyNarrow: {
    display: { default: 'inline-flex', '@media (min-width: 48rem)': 'none' },
  },
  hideBelowSidebar: {
    display: { default: 'none', '@media (min-width: 64rem)': 'inline-flex' },
  },
  onlyBelowSidebar: {
    display: { default: 'inline-flex', '@media (min-width: 64rem)': 'none' },
  },
})
