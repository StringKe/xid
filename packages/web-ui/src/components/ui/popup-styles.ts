// 菜单、弹出层、选择列表共用的浮层表面与列表项。高亮态由 Base UI 的 state 函数驱动。

import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { media, size, text } from '../../styles/scale.stylex'

export const popupStyles = stylex.create({
  positioner: {
    zIndex: 50,
    outline: 'none',
  },
  surface: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    minWidth: '12rem',
    maxWidth: 'min(20rem, var(--available-width))',
    maxHeight: 'var(--available-height)',
    overflowY: 'auto',
    padding: '0.25rem',
    borderRadius: tokens['--xid-radius-lg'],
    backgroundColor: tokens['--xid-surface'],
    color: tokens['--xid-fg'],
    boxShadow: `0 0 0 1px ${tokens['--xid-border']}, ${tokens['--xid-shadow-md']}`,
    fontFamily: tokens['--xid-font'],
    fontSize: text.base,
    lineHeight: '1.125rem',
    outline: 'none',
  },
  matchAnchor: {
    minWidth: 'var(--anchor-width)',
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    width: '100%',
    boxSizing: 'border-box',
    minHeight: { default: size.rowCompact, [media.coarse]: size.touch },
    paddingInline: '0.625rem',
    borderWidth: 0,
    borderRadius: tokens['--xid-radius'],
    backgroundColor: 'transparent',
    color: tokens['--xid-fg'],
    fontFamily: 'inherit',
    fontSize: 'inherit',
    textAlign: 'start',
    textDecoration: 'none',
    cursor: 'default',
    outline: 'none',
    userSelect: 'none',
  },
  itemHighlighted: {
    backgroundColor: tokens['--xid-muted'],
  },
  itemDisabled: {
    color: tokens['--xid-faint-foreground'],
    cursor: 'not-allowed',
  },
  itemDanger: {
    color: tokens['--xid-danger'],
  },
  itemIcon: {
    display: 'inline-flex',
    color: tokens['--xid-muted-foreground'],
  },
  itemLabel: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  itemCheck: {
    display: 'inline-flex',
    marginInlineStart: 'auto',
    color: tokens['--xid-fg'],
  },
  header: {
    paddingBlock: '0.375rem 0.5rem',
    paddingInline: '0.625rem',
    marginBlockEnd: '0.25rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    color: tokens['--xid-muted-foreground'],
    fontSize: text.xs,
    lineHeight: '1rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  separator: {
    height: '1px',
    marginBlock: '0.25rem',
    backgroundColor: tokens['--xid-border'],
  },
  groupLabel: {
    paddingBlock: '0.375rem 0.25rem',
    paddingInline: '0.625rem',
    color: tokens['--xid-faint-foreground'],
    fontSize: text.xs,
    lineHeight: '1rem',
    letterSpacing: tokens['--xid-tracking-small'],
  },
})
