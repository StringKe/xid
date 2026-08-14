import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { Button } from '../../components/ui'
import { styles } from './styles'

const guestStyles = stylex.create({
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  note: {
    margin: 0,
    fontSize: '0.8125rem',
    lineHeight: 1.55,
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
    textAlign: 'center',
    textWrap: 'pretty',
  },
})

export type SignInGuestButtonProps = {
  onContinue: () => void
  isLoading: boolean
  disabled?: boolean
}

export function SignInGuestButton({
  onContinue,
  isLoading,
  disabled = false,
}: SignInGuestButtonProps): ReactNode {
  const { t } = useLingui()
  return (
    <div {...stylex.props(guestStyles.stack)}>
      <div role="separator" aria-hidden="true" {...stylex.props(styles.separator)}>
        <span {...stylex.props(styles.separatorRule)} />
        <Trans>or</Trans>
        <span {...stylex.props(styles.separatorRule)} />
      </div>
      <Button
        variant="secondary"
        fullWidth
        isLoading={isLoading}
        disabled={disabled}
        aria-label={t`Continue as guest`}
        onClick={onContinue}
      >
        <Trans>Continue as guest</Trans>
      </Button>
      <p {...stylex.props(guestStyles.note)}>
        <Trans>Browse without an account. Guest data cannot be recovered after sign-out.</Trans>
      </p>
    </div>
  )
}
