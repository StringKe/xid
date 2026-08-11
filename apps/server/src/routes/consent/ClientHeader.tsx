import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import type { ConsentParams } from './index'

export type ClientHeaderProps = {
  params: ConsentParams
  titleId: string
}

const styles = stylex.create({
  clientRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
  },
  clientLogo: {
    flexShrink: 0,
    width: '2.5rem',
    height: '2.5rem',
    objectFit: 'contain',
    borderRadius: tokens['--xid-radius'],
  },
  clientLogoPlaceholder: {
    flexShrink: 0,
    width: '2.5rem',
    height: '2.5rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-muted'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '1rem',
    fontWeight: 700,
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
  },
  clientMeta: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    minWidth: 0,
  },
  clientName: {
    margin: 0,
    fontSize: '0.9375rem',
    fontWeight: 600,
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    textOverflow: 'ellipsis',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
  },
  clientNature: {
    margin: 0,
    fontSize: '0.75rem',
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font-mono'],
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
  },
  titleSpacing: {
    marginTop: '0.875rem',
  },
  titleBlock: {
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
    margin: '0.375rem 0 0',
    fontSize: '0.875rem',
    lineHeight: 1.55,
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
    textWrap: 'pretty',
  },
})

export function ClientHeader({ params, titleId }: ClientHeaderProps): ReactNode {
  const { t } = useLingui()

  return (
    <div {...stylex.props(styles.titleBlock)}>
      <div {...stylex.props(styles.clientRow)}>
        {params.clientLogoUrl ? (
          <img
            src={params.clientLogoUrl}
            alt={t`${params.clientName} logo`}
            {...stylex.props(styles.clientLogo)}
          />
        ) : (
          <div aria-hidden="true" {...stylex.props(styles.clientLogoPlaceholder)}>
            {params.clientName.charAt(0).toUpperCase()}
          </div>
        )}
        <div {...stylex.props(styles.clientMeta)}>
          <p {...stylex.props(styles.clientName)}>{params.clientName}</p>
          <p {...stylex.props(styles.clientNature)}>
            {params.firstParty ? <Trans>first-party</Trans> : <Trans>third-party app</Trans>}
          </p>
        </div>
      </div>

      <h1 id={titleId} {...stylex.props(styles.title, styles.titleSpacing)}>
        <Trans>Requesting access to your account</Trans>
      </h1>

      <p {...stylex.props(styles.lead)}>
        {params.firstParty ? (
          <Trans>This is a first-party application by the same provider.</Trans>
        ) : (
          <Trans>This application will be able to access the following information.</Trans>
        )}
      </p>
    </div>
  )
}
