import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, ConsolePageSection } from '@xid-kit/web-ui/ui'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import type { BillingConfig } from '@xid-kit/types'
import { useCreateStripePortal } from './queries'

const styles = stylex.create({
  panel: {
    display: 'grid',
    gap: '0.875rem',
    padding: '1rem',
    maxWidth: '56rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-muted'],
  },
  copy: {
    margin: 0,
    maxWidth: '48rem',
    color: tokens['--xid-muted-foreground'],
    fontSize: '0.875rem',
    lineHeight: 1.55,
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.75rem',
  },
})

export function UsageBillingSection({
  config,
  tenantId,
}: {
  config: BillingConfig
  tenantId: string
}): ReactNode {
  const createStripePortal = useCreateStripePortal()

  function openStripePortal(): void {
    createStripePortal.mutate(
      { tenantId },
      { onSuccess: (session) => globalThis.location.assign(session.url) },
    )
  }

  return (
    <ConsolePageSection title={<Trans>Usage billing</Trans>}>
      <div {...stylex.props(styles.panel)}>
        <p {...stylex.props(styles.copy)}>
          <Trans>
            Usage is billed by metered MAU. Open the Customer Portal to view invoices and payment
            methods.
          </Trans>
        </p>
        {config.portal ? (
          <div {...stylex.props(styles.actions)}>
            <Button
              type="button"
              variant="secondary"
              isLoading={createStripePortal.isPending}
              onClick={openStripePortal}
            >
              <Trans>Open Customer Portal</Trans>
            </Button>
          </div>
        ) : (
          <p {...stylex.props(styles.copy)}>
            <Trans>
              This organization has no Stripe customer yet. In Stripe, create a customer and a
              metered subscription, and set the subscription metadata key xid_tenant_id to this
              organization ID.
            </Trans>
          </p>
        )}
        {createStripePortal.isError ? (
          <Alert tone="error">
            <Trans>Failed to open the Customer Portal. Try again.</Trans>
          </Alert>
        ) : null}
      </div>
    </ConsolePageSection>
  )
}
