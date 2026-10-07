// Hosted Auth 页面共用的版式:区块间距、正文与元信息、文字链接、底部链接行。

import * as stylex from '@stylexjs/stylex'
import { size, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '../../styles/tokens.stylex'

export const hosted = stylex.create({
  screen: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.75rem',
    minWidth: 0,
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    minWidth: 0,
  },
  group: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    minWidth: 0,
  },
  actions: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.625rem',
  },
  actionsRow: {
    display: 'grid',
    gridTemplateColumns: { default: '1fr', '@media (min-width: 26rem)': '1fr 1fr' },
    gap: '0.625rem',
  },
  note: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: 1.45,
    overflowWrap: 'anywhere',
  },
  noteStrong: {
    color: tokens['--xid-fg'],
    fontWeight: weight.medium,
  },
  mono: {
    fontFamily: tokens['--xid-font-mono'],
    color: tokens['--xid-fg'],
  },
  tabular: {
    fontVariantNumeric: 'tabular-nums',
  },
  linkRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: '1rem',
    paddingTop: '0.25rem',
  },
  rule: {
    height: '1px',
    borderWidth: 0,
    margin: 0,
    backgroundColor: tokens['--xid-border'],
  },
  textLink: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: { default: '1.5rem', '@media (pointer: coarse)': size.touch },
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: tokens['--xid-accent'],
    fontFamily: tokens['--xid-font'],
    fontSize: text.sm,
    fontWeight: weight.medium,
    lineHeight: '1rem',
    textDecoration: { default: 'none', ':hover': 'underline' },
    textUnderlineOffset: '3px',
    cursor: 'pointer',
  },
  quietLink: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: { default: '2.75rem' },
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: { default: tokens['--xid-muted-foreground'], ':hover': tokens['--xid-fg'] },
    fontFamily: tokens['--xid-font'],
    fontSize: text.sm,
    lineHeight: '1rem',
    textDecoration: 'none',
    cursor: 'pointer',
  },
  inlineLinkText: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
  },
  separator: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: '1rem',
  },
  separatorRule: {
    flexGrow: 1,
    height: '1px',
    backgroundColor: tokens['--xid-border'],
  },
  input: {
    minHeight: { default: '3rem', '@media (min-width: 48rem)': size.touch },
    fontSize: 'max(16px, 1em)',
  },
})
