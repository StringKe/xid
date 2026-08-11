import { Trans } from '@lingui/react/macro'
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { Button } from '../../components/ui'

export type ConsentActionsProps = {
  isSubmitting: boolean
  onAllow: () => void
  onDeny: () => void
}

const styles = stylex.create({
  actions: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.625rem',
  },
  actionFootnote: {
    margin: 0,
    textAlign: 'center',
    fontSize: '0.75rem',
    lineHeight: 1.5,
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
  },
})

export function ConsentActions({ isSubmitting, onAllow, onDeny }: ConsentActionsProps): ReactNode {
  const allowRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    allowRef.current?.focus()
  }, [])

  return (
    <div {...stylex.props(styles.actions)}>
      <Button ref={allowRef} variant="primary" fullWidth isLoading={isSubmitting} onClick={onAllow}>
        <Trans>Allow access</Trans>
      </Button>

      <Button variant="secondary" fullWidth disabled={isSubmitting} onClick={onDeny}>
        <Trans>Deny</Trans>
      </Button>

      <p {...stylex.props(styles.actionFootnote)}>
        <Trans>You can revoke these permissions at any time from your account settings.</Trans>
      </p>
    </div>
  )
}
