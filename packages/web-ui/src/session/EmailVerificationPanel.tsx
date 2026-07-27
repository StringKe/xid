import { Trans } from '@lingui/react/macro'
import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { ApiClient } from '../api'
import { motion, springSnappy } from '../motion'
import { tokens } from '../styles/tokens.stylex'
import { Alert, Button } from '../components/ui'

type SendState = 'idle' | 'sending' | 'sent' | 'rate_limited' | 'error'

export type EmailVerificationPanelProps = {
  api: ApiClient
  email: string
  onClose: () => void
}

const styles = stylex.create({
  dialog: {
    width: 'min(90vw, 26rem)',
    maxWidth: '26rem',
    padding: '1.5rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius-lg'],
    backgroundColor: tokens['--xid-surface'],
    color: tokens['--xid-fg'],
    boxShadow: tokens['--xid-shadow-lg'],
    fontFamily: tokens['--xid-font'],
  },
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
  },
  heading: {
    margin: 0,
    fontSize: '1.125rem',
    fontWeight: 650,
    lineHeight: 1.2,
    textWrap: 'balance',
  },
  description: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: '0.875rem',
    lineHeight: 1.55,
    textWrap: 'pretty',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: '0.75rem',
  },
})

const motionEnter = { opacity: 1, scale: 1 } as const
const motionExit = { opacity: 0, scale: 0.96 } as const

export function EmailVerificationPanel({
  api,
  email,
  onClose,
}: EmailVerificationPanelProps): ReactNode {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const [sendState, setSendState] = useState<SendState>('idle')
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    return () => dialog.close()
  }, [])

  async function sendVerification(): Promise<void> {
    setSendState('sending')
    const result = await api.post<unknown>('/auth/resend-verification')
    if (result.ok) {
      setSendState('sent')
      return
    }
    setSendState(result.error.code === 'rate_limited' ? 'rate_limited' : 'error')
  }

  function handleCancel(event: React.SyntheticEvent): void {
    event.preventDefault()
    setClosing(true)
  }

  function handleAnimationComplete(): void {
    if (!closing) return
    dialogRef.current?.close()
    onClose()
  }

  const sent = sendState === 'sent'

  return (
    <motion.dialog
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={handleCancel}
      initial={motionExit}
      animate={closing ? motionExit : motionEnter}
      transition={springSnappy}
      onAnimationComplete={handleAnimationComplete}
      {...stylex.props(styles.dialog)}
    >
      <div {...stylex.props(styles.stack)}>
        <h2 id={titleId} {...stylex.props(styles.heading)}>
          <Trans>Verify your email</Trans>
        </h2>
        <p id={descriptionId} {...stylex.props(styles.description)}>
          {email ? (
            <Trans>
              Send a verification link to {email}. The Console stays read-only until you use it.
            </Trans>
          ) : (
            <Trans>
              Send a verification link to your email. The Console stays read-only until you use it.
            </Trans>
          )}
        </p>

        {sent ? (
          <Alert tone="success" title={<Trans>Verification email sent</Trans>}>
            <Trans>Open the link in your inbox, then sign in again.</Trans>
          </Alert>
        ) : null}
        {sendState === 'rate_limited' ? (
          <Alert tone="error" title={<Trans>Too many requests</Trans>}>
            <Trans>Wait a minute before requesting another verification email.</Trans>
          </Alert>
        ) : null}
        {sendState === 'error' ? (
          <Alert tone="error" title={<Trans>Verification email not sent</Trans>}>
            <Trans>Check your connection and try again.</Trans>
          </Alert>
        ) : null}

        <div {...stylex.props(styles.actions)}>
          <Button
            variant="secondary"
            disabled={sendState === 'sending' || closing}
            onClick={() => setClosing(true)}
          >
            {sent ? <Trans>Close</Trans> : <Trans>Cancel</Trans>}
          </Button>
          <Button
            isLoading={sendState === 'sending'}
            disabled={closing}
            onClick={() => void sendVerification()}
          >
            {sent ? (
              <Trans>Resend verification email</Trans>
            ) : (
              <Trans>Send verification email</Trans>
            )}
          </Button>
        </div>
      </div>
    </motion.dialog>
  )
}
