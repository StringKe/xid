import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, Card } from '../../components/ui'
import { tokens } from '../../styles/tokens.stylex'
import { page } from '../../styles/product-surface.stylex'

const styles = stylex.create({
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  confirmHeader: {
    textAlign: 'center',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.625rem',
  },
  confirmTitle: {
    textAlign: 'center',
  },
  confirmLead: {
    textAlign: 'center',
    maxWidth: 'none',
  },
  code: {
    display: 'inline-flex',
    alignSelf: 'center',
    paddingBlock: '0.4375rem',
    paddingInline: '0.875rem',
    borderRadius: tokens['--xid-radius'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border-strong'],
    backgroundColor: tokens['--xid-muted'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '1.0625rem',
    fontWeight: 600,
    letterSpacing: '0.06em',
    color: tokens['--xid-fg'],
    fontVariantNumeric: 'tabular-nums',
  },
  detailCard: {
    padding: '0.875rem',
  },
  detailList: {
    display: 'grid',
    gap: '0.625rem',
    margin: 0,
  },
  detailRow: {
    display: 'grid',
    gap: '0.1875rem',
  },
  detailValue: {
    margin: 0,
    fontSize: '0.8125rem',
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    overflowWrap: 'anywhere',
  },
  scopeList: {
    margin: 0,
    paddingInlineStart: '1.25rem',
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: '0.8125rem',
    lineHeight: 1.55,
  },
  actions: {
    display: 'grid',
    gap: '0.75rem',
  },
})

export type DeviceActivationParams = {
  userCode: string
  clientId: string
  scopes: string[]
  expiresAt: string
  firstParty: boolean
}

export type ActivationDetailsProps = {
  params: DeviceActivationParams
  isSubmitting: boolean
  submitError: string | null
  onApprove: () => void
  onDeny: () => void
}

export function ActivationDetails({
  params,
  isSubmitting,
  submitError,
  onApprove,
  onDeny,
}: ActivationDetailsProps): ReactNode {
  const { t } = useLingui()
  const expiresAt = new Date(params.expiresAt)
  const expiresLabel = Number.isNaN(expiresAt.getTime())
    ? params.expiresAt
    : expiresAt.toLocaleTimeString()

  return (
    <section {...stylex.props(styles.panel)}>
      <div {...stylex.props(styles.confirmHeader)}>
        <span {...stylex.props(styles.code)}>{params.userCode}</span>
        <h2 {...stylex.props(page.title, styles.confirmTitle)}>
          <Trans>Allow this device to sign in?</Trans>
        </h2>
        <p {...stylex.props(page.lead, styles.confirmLead)}>
          {params.firstParty
            ? t`This is a first-party application by the same provider.`
            : t`Only approve this request if the code matches your device.`}
        </p>
      </div>

      <Card as="section" variant="default" {...stylex.props(styles.detailCard)}>
        <dl {...stylex.props(styles.detailList)}>
          <div {...stylex.props(styles.detailRow)}>
            <dt {...stylex.props(page.monoLabel)}>
              <Trans>Client</Trans>
            </dt>
            <dd {...stylex.props(styles.detailValue)}>{params.clientId}</dd>
          </div>
          <div {...stylex.props(styles.detailRow)}>
            <dt {...stylex.props(page.monoLabel)}>
              <Trans>Expires</Trans>
            </dt>
            <dd {...stylex.props(styles.detailValue)}>{expiresLabel}</dd>
          </div>
        </dl>
      </Card>

      {params.scopes.length > 0 ? (
        <Card as="section" variant="default" {...stylex.props(styles.detailCard)}>
          <p {...stylex.props(page.monoLabel)}>
            <Trans>Permissions requested</Trans>
          </p>
          <ul {...stylex.props(styles.scopeList)}>
            {params.scopes.map((scope) => (
              <li key={scope}>{scope}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      {submitError ? (
        <Alert tone="error" title={<Trans>Device request failed</Trans>}>
          {submitError}
        </Alert>
      ) : null}

      <div {...stylex.props(styles.actions)}>
        <Button variant="primary" fullWidth isLoading={isSubmitting} onClick={onApprove}>
          <Trans>Allow device</Trans>
        </Button>
        <Button variant="ghost" fullWidth disabled={isSubmitting} onClick={onDeny}>
          <Trans>Deny</Trans>
        </Button>
      </div>
    </section>
  )
}
