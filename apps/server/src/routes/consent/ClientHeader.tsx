// 同意页顶部:应用标识、应用归属组织、第一方 / 第三方标签。

import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Badge } from '../../components/ui'
import { initialsOf } from '../../components/hosted/IdentityChip'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '../../styles/tokens.stylex'

const styles = stylex.create({
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    minWidth: 0,
  },
  logo: {
    flexShrink: 0,
    width: '2.5rem',
    height: '2.5rem',
    borderRadius: tokens['--xid-radius-lg'],
    objectFit: 'contain',
  },
  monogram: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '2.5rem',
    height: '2.5rem',
    borderRadius: tokens['--xid-radius-lg'],
    backgroundColor: tokens['--xid-primary'],
    color: tokens['--xid-primary-foreground'],
    fontSize: text.sm,
    fontWeight: weight.display,
  },
  names: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    flexGrow: 1,
    minWidth: 0,
  },
  name: {
    fontSize: text.base,
    fontWeight: weight.medium,
    lineHeight: '1.125rem',
    color: tokens['--xid-fg'],
    overflowWrap: 'anywhere',
  },
  owner: {
    fontSize: text.sm,
    lineHeight: '1rem',
    color: tokens['--xid-muted-foreground'],
    overflowWrap: 'anywhere',
  },
})

export type ClientIdentity = {
  name: string
  logoUrl: string | null
  ownerName: string | null
  firstParty: boolean
}

export function ClientHeader({ client }: { client: ClientIdentity }): ReactNode {
  return (
    <div {...stylex.props(styles.row)}>
      {client.logoUrl ? (
        <img src={client.logoUrl} alt="" {...stylex.props(styles.logo)} />
      ) : (
        <span aria-hidden="true" {...stylex.props(styles.monogram)}>
          {initialsOf(client.name)}
        </span>
      )}
      <span {...stylex.props(styles.names)}>
        <span {...stylex.props(styles.name)}>{client.name}</span>
        {client.ownerName ? (
          <span {...stylex.props(styles.owner)}>
            <Trans>by {client.ownerName}</Trans>
          </span>
        ) : null}
      </span>
      {client.firstParty ? (
        <Badge variant="outline">
          <Trans>First-party</Trans>
        </Badge>
      ) : (
        <Badge tone="warning">
          <Trans>Third-party</Trans>
        </Badge>
      )}
    </div>
  )
}
