// PageHeader:页面头(标题 + 可选导语 + 操作区)。
// 层次靠字号/字重 + muted 导语表达,不加 hairline:auth 卡内与分段控制器同屏时,
// 一条全宽底线会与控制器底槽叠出第二层强调(一个面板最多一层强调)。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'

export type PageHeaderProps = {
  title: ReactNode
  lead?: ReactNode
  actions?: ReactNode
}

const styles = stylex.create({
  root: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '0.75rem 1.5rem',
  },
  text: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    minWidth: 0,
  },
  title: {
    margin: 0,
    fontSize: '1.375rem',
    fontWeight: 650,
    lineHeight: 1.1,
    letterSpacing: '-0.022em',
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    textWrap: 'balance',
  },
  lead: {
    margin: 0,
    fontSize: '0.875rem',
    lineHeight: 1.55,
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
    maxWidth: '65ch',
    textWrap: 'pretty',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.5rem',
    flexShrink: 0,
  },
})

export function PageHeader({ title, lead, actions }: PageHeaderProps): ReactNode {
  return (
    <header {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.text)}>
        <h1 {...stylex.props(styles.title)}>{title}</h1>
        {lead ? <p {...stylex.props(styles.lead)}>{lead}</p> : null}
      </div>
      {actions ? <div {...stylex.props(styles.actions)}>{actions}</div> : null}
    </header>
  )
}
