import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { size, text, weight } from '../../styles/scale.stylex'

export const tableStyles = stylex.create({
  frame: {
    width: '100%',
    minWidth: 0,
  },
  scroll: {
    overflowX: 'auto',
    overscrollBehaviorX: 'contain',
  },
  table: {
    width: '100%',
    borderCollapse: 'separate',
    borderSpacing: 0,
    fontFamily: tokens['--xid-font'],
    fontSize: text.base,
    lineHeight: '1.125rem',
    fontVariantNumeric: 'tabular-nums',
    color: tokens['--xid-fg'],
  },
  // 列优先级模式下窄屏的标识列吃掉剩余宽度;max-width: 0 让单元格可以窄于邮箱等长串,由 IdentityCell 省略。
  priorityFillHead: {
    width: { default: 'var(--xid-col-width, auto)', '@media (max-width: 47.99rem)': '100%' },
    maxWidth: { default: 'none', '@media (max-width: 47.99rem)': 0 },
  },
  priorityFillCell: {
    maxWidth: { default: 'none', '@media (max-width: 47.99rem)': 0 },
  },
  caption: {
    captionSide: 'top',
    textAlign: 'start',
    paddingBlock: '0.5rem',
    fontSize: text.base,
    fontWeight: weight.medium,
    color: tokens['--xid-fg'],
  },
  th: {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    height: size.rowCompact,
    paddingBlock: 0,
    paddingInline: '0.5rem',
    textAlign: 'start',
    verticalAlign: 'middle',
    fontSize: text.xs,
    fontWeight: weight.regular,
    lineHeight: '1rem',
    letterSpacing: tokens['--xid-tracking-small'],
    color: tokens['--xid-muted-foreground'],
    backgroundColor: tokens['--xid-bg'],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    whiteSpace: 'nowrap',
  },
  sortButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.25rem',
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: 'inherit',
    font: 'inherit',
    cursor: 'pointer',
  },
  row: {
    backgroundColor: tokens['--xid-bg'],
  },
  rowCompact: { height: { default: size.rowCompact, '@media (pointer: coarse)': size.touch } },
  rowDefault: { height: { default: size.rowDefault, '@media (pointer: coarse)': size.touch } },
  rowComfortable: {
    height: { default: size.rowComfortable, '@media (pointer: coarse)': size.touch },
  },
  cell: {
    paddingBlock: '0.375rem',
    paddingInline: '0.5rem',
    verticalAlign: 'middle',
    backgroundColor: 'inherit',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  alignEnd: {
    textAlign: 'end',
  },
  stickyFirst: {
    position: 'sticky',
    insetInlineStart: 0,
    zIndex: 1,
    backgroundColor: tokens['--xid-bg'],
  },
  emptyCell: {
    paddingBlock: '2rem',
    paddingInline: '0.5rem',
    textAlign: 'start',
    color: tokens['--xid-muted-foreground'],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  clickableRow: {
    cursor: 'pointer',
    backgroundColor: {
      default: tokens['--xid-bg'],
      ':hover': tokens['--xid-sidebar'],
      ':focus-visible': tokens['--xid-sidebar'],
    },
  },
  selectedRow: {
    backgroundColor: tokens['--xid-muted'],
  },
})
