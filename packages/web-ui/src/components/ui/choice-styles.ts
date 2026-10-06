// 选择类控件:选中态用墨色,焦点用 accent;未选描边 ink-muted 保证与表面 3:1。

import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { text } from '../../styles/scale.stylex'

export const choiceStyles = stylex.create({
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.625rem',
    cursor: 'pointer',
    fontFamily: tokens['--xid-font'],
    minHeight: { default: 'auto', '@media (pointer: coarse)': '2.75rem' },
  },
  text: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    minWidth: 0,
  },
  label: {
    color: tokens['--xid-fg'],
    fontSize: text.base,
    lineHeight: '1rem',
  },
  description: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: '1.125rem',
  },
  box: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '1rem',
    height: '1rem',
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: tokens['--xid-surface'],
    boxShadow: `inset 0 0 0 1px ${tokens['--xid-muted-foreground']}`,
    color: tokens['--xid-primary-foreground'],
    cursor: 'pointer',
  },
  boxChecked: {
    backgroundColor: tokens['--xid-primary'],
    boxShadow: 'none',
  },
  radio: {
    borderRadius: tokens['--xid-radius-full'],
  },
  radioChecked: {
    boxShadow: `inset 0 0 0 5px ${tokens['--xid-primary']}`,
  },
  disabled: {
    opacity: 0.55,
    cursor: 'not-allowed',
  },
  track: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    width: '2rem',
    height: '1.25rem',
    padding: '0.125rem',
    borderWidth: 0,
    borderRadius: tokens['--xid-radius-full'],
    backgroundColor: tokens['--xid-faint-foreground'],
    cursor: 'pointer',
    transitionProperty: {
      default: 'background-color',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
    transitionDuration: '120ms',
  },
  trackChecked: {
    backgroundColor: tokens['--xid-primary'],
  },
  thumb: {
    display: 'block',
    width: '1rem',
    height: '1rem',
    borderRadius: tokens['--xid-radius-full'],
    backgroundColor: tokens['--xid-surface'],
    transform: 'translateX(0)',
    transitionProperty: { default: 'transform', '@media (prefers-reduced-motion: reduce)': 'none' },
    transitionDuration: '120ms',
  },
  thumbChecked: {
    transform: 'translateX(0.75rem)',
  },
})
