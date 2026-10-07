// 工作区页面骨架:面包屑、28px 标题、说明与右侧操作;内容最大宽 70rem,窄屏 16px、平板 24px、桌面 40px 边距。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'

export const frame = stylex.create({
  root: {
    width: '100%',
    maxWidth: '75rem',
    paddingInline: {
      default: '1rem',
      '@media (min-width: 48rem)': '1.5rem',
      '@media (min-width: 64rem)': '2.5rem',
    },
    paddingTop: {
      default: '1rem',
      '@media (min-width: 48rem)': '1.5rem',
      '@media (min-width: 64rem)': '2rem',
    },
    paddingBottom: '3rem',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: { default: '1rem', '@media (min-width: 48rem)': '1.5rem' },
  },
  head: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  headRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '0.75rem 1.5rem',
  },
  headText: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
    minWidth: 0,
    flex: '1 1 20rem',
  },
  title: {
    margin: 0,
    fontSize: { default: text.lg, '@media (min-width: 48rem)': text.xl },
    lineHeight: { default: leading.lg, '@media (min-width: 48rem)': leading.xl },
    fontWeight: weight.display,
    letterSpacing: tokens['--xid-tracking-heading'],
    color: tokens['--xid-fg'],
    textWrap: 'balance',
    overflowWrap: 'anywhere',
  },
  lead: {
    margin: 0,
    maxWidth: '50rem',
    fontSize: text.base,
    lineHeight: leading.body,
    color: tokens['--xid-muted-foreground'],
    textWrap: 'pretty',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.5rem',
  },
  crumbs: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.5rem',
    margin: 0,
    padding: 0,
    listStyle: 'none',
    fontSize: text.sm,
    color: tokens['--xid-muted-foreground'],
  },
  crumbLink: {
    color: tokens['--xid-accent'],
    textDecoration: 'none',
  },
  crumbSep: {
    color: tokens['--xid-faint-foreground'],
  },
})

export type PageFrameProps = {
  title: ReactNode
  lead?: ReactNode
  actions?: ReactNode
  breadcrumb?: ReactNode
  children: ReactNode
}

export function PageFrame({
  title,
  lead,
  actions,
  breadcrumb,
  children,
}: PageFrameProps): ReactNode {
  return (
    <div {...stylex.props(frame.root)}>
      <header {...stylex.props(frame.head)}>
        {breadcrumb}
        <div {...stylex.props(frame.headRow)}>
          <div {...stylex.props(frame.headText)}>
            <h1 {...stylex.props(frame.title)}>{title}</h1>
            {lead ? <p {...stylex.props(frame.lead)}>{lead}</p> : null}
          </div>
          {actions ? <div {...stylex.props(frame.actions)}>{actions}</div> : null}
        </div>
      </header>
      {children}
    </div>
  )
}
