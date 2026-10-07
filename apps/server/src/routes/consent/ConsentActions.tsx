import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button } from '../../components/ui'
import { hosted } from '../../components/hosted/hosted-styles'

export type ConsentActionsProps = {
  isSubmitting: boolean
  onAllow: () => void
  onDeny: () => void
}

export function ConsentActions({ isSubmitting, onAllow, onDeny }: ConsentActionsProps): ReactNode {
  return (
    <div {...stylex.props(hosted.actionsRow)}>
      <Button variant="secondary" size="lg" fullWidth disabled={isSubmitting} onClick={onDeny}>
        <Trans>Don't allow</Trans>
      </Button>
      <Button variant="accent" size="lg" fullWidth isLoading={isSubmitting} onClick={onAllow}>
        <Trans>Allow access</Trans>
      </Button>
    </div>
  )
}
