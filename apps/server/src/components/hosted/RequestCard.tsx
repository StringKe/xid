// 设备激活与 CIBA 审批共用的请求卡:应用名、client_id、第一方标签,以及批准后对方能拿到什么。

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Badge } from '../ui'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '../../styles/tokens.stylex'
import { useScopeLabel } from './scope-copy'

const styles = stylex.create({
  card: {
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius-lg'],
    overflow: 'hidden',
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
    paddingBlock: '0.875rem',
    paddingInline: '1rem',
  },
  names: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    minWidth: 0,
  },
  name: {
    fontSize: text.base,
    fontWeight: weight.medium,
    color: tokens['--xid-fg'],
    overflowWrap: 'anywhere',
  },
  clientId: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.xs,
    color: tokens['--xid-muted-foreground'],
    overflowWrap: 'anywhere',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    paddingBlock: '0.875rem',
    paddingInline: '1rem',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  sectionTitle: {
    margin: 0,
    fontSize: text.sm,
    fontWeight: weight.medium,
    color: tokens['--xid-fg'],
  },
  scopes: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
    margin: 0,
    padding: 0,
    listStyle: 'none',
    fontSize: text.sm,
    color: tokens['--xid-muted-foreground'],
  },
  footer: {
    paddingBlock: '0.75rem',
    paddingInline: '1rem',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
    backgroundColor: tokens['--xid-sidebar'],
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: 1.45,
  },
})

export type RequestCardProps = {
  clientName: string
  clientId: string
  firstParty: boolean
  scopes: readonly string[]
  heading: ReactNode
  footer?: ReactNode
}

export function RequestCard(props: RequestCardProps): ReactNode {
  const label = useScopeLabel()
  return (
    <section {...stylex.props(styles.card)}>
      <div {...stylex.props(styles.head)}>
        <span {...stylex.props(styles.names)}>
          <span {...stylex.props(styles.name)}>{props.clientName}</span>
          {props.clientName !== props.clientId ? (
            <span {...stylex.props(styles.clientId)}>{props.clientId}</span>
          ) : null}
        </span>
        {props.firstParty ? (
          <Badge variant="outline">
            <Trans>First-party</Trans>
          </Badge>
        ) : (
          <Badge tone="warning">
            <Trans>Third-party</Trans>
          </Badge>
        )}
      </div>
      {props.scopes.length > 0 ? (
        <div {...stylex.props(styles.section)}>
          <h2 {...stylex.props(styles.sectionTitle)}>{props.heading}</h2>
          <ul {...stylex.props(styles.scopes)}>
            {props.scopes.map((scope) => (
              <li key={scope}>{label(scope)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {props.footer ? <div {...stylex.props(styles.footer)}>{props.footer}</div> : null}
    </section>
  )
}
