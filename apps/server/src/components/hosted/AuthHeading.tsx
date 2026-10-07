// Hosted Auth 表单区的标题组:可选上方标识(已输入的标识符或已登录账户),标题,说明。

import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '../../styles/tokens.stylex'

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '0.5rem',
  },
  eyebrow: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: '1rem',
    fontVariantNumeric: 'tabular-nums',
  },
  title: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.xl,
    fontWeight: weight.display,
    letterSpacing: tokens['--xid-tracking-heading'],
    lineHeight: 1.15,
    overflowWrap: 'anywhere',
    textWrap: 'balance',
    outline: 'none',
  },
  lead: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.base,
    lineHeight: 1.55,
    overflowWrap: 'anywhere',
  },
  above: {
    marginBottom: '0.25rem',
    maxWidth: '100%',
  },
})

export type AuthHeadingProps = {
  title: ReactNode
  lead?: ReactNode
  eyebrow?: ReactNode
  above?: ReactNode
}

export function AuthHeading({ title, lead, eyebrow, above }: AuthHeadingProps): ReactNode {
  return (
    <div {...stylex.props(styles.root)}>
      {above ? <div {...stylex.props(styles.above)}>{above}</div> : null}
      {eyebrow ? <p {...stylex.props(styles.eyebrow)}>{eyebrow}</p> : null}
      <h1 tabIndex={-1} {...stylex.props(styles.title)}>
        {title}
      </h1>
      {lead ? <p {...stylex.props(styles.lead)}>{lead}</p> : null}
    </div>
  )
}
