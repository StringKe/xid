// 添加邮箱或手机号的两步弹窗:先填地址发送 6 位码,再输入验证码。重发受 1 分钟间隔限制。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, Dialog, TextField } from '../../components/ui'
import { surface } from './account-surface'
import { errorCode, useActionError } from './use-security-action-error'

const RESEND_INTERVAL_SEC = 60

export type ContactKind = 'email' | 'phone'

export type PendingContact = { id: string; target: string }

export type ContactCodeDialogProps = {
  kind: ContactKind
  // 已有待验证地址时直接进入输入验证码这一步。
  pending?: PendingContact
  send: (target: string) => Promise<PendingContact>
  resend: (pending: PendingContact) => Promise<PendingContact>
  verify: (pending: PendingContact, code: string) => Promise<void>
  onClose: () => void
}

function useCountdown(startRunning: boolean): [number, () => void] {
  const [remaining, setRemaining] = useState(startRunning ? RESEND_INTERVAL_SEC : 0)
  useEffect(() => {
    if (remaining <= 0) return
    const timer = setTimeout(() => setRemaining((value) => value - 1), 1000)
    return () => clearTimeout(timer)
  }, [remaining])
  return [remaining, () => setRemaining(RESEND_INTERVAL_SEC)]
}

function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function ContactCodeDialog({
  kind,
  pending: initialPending,
  send,
  resend,
  verify,
  onClose,
}: ContactCodeDialogProps): ReactNode {
  const { t } = useLingui()
  const actionError = useActionError()
  const [open, setOpen] = useState(true)
  const [pending, setPending] = useState<PendingContact | null>(initialPending ?? null)
  const [target, setTarget] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [remaining, restartCountdown] = useCountdown(Boolean(initialPending))
  const formId = `add-${kind}`

  const failMessage = (err: unknown): string | null => {
    if (errorCode(err) === 'otp_invalid') return t`That code didn't work. Check it and try again.`
    if (errorCode(err) === 'otp_expired') return t`That code has expired. Send a new one.`
    if (errorCode(err) === 'already_exists') {
      return kind === 'email'
        ? t`This address is already on your account.`
        : t`This number is already on your account.`
    }
    if (errorCode(err) === 'validation_failed') {
      return kind === 'email'
        ? t`Enter a valid email address.`
        : t`Enter a mobile number with its country code, for example +1 415 555 0134.`
    }
    return actionError(err, t`Something went wrong. Try again.`)
  }

  const run = async (action: () => Promise<void>): Promise<void> => {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      await action()
    } catch (err) {
      setError(failMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!pending) {
      void run(async () => {
        setPending(await send(target.trim()))
        restartCountdown()
      })
      return
    }
    void run(async () => {
      await verify(pending, code.trim())
      setOpen(false)
    })
  }

  const handleResend = (): void => {
    if (!pending) return
    void run(async () => {
      setPending(await resend(pending))
      setCode('')
      restartCountdown()
      setNotice(t`We sent a new code. The previous code no longer works.`)
    })
  }

  const title = pending ? (
    kind === 'email' ? (
      <Trans>Check {pending.target}</Trans>
    ) : (
      <Trans>Check your messages</Trans>
    )
  ) : kind === 'email' ? (
    <Trans>Add an email address</Trans>
  ) : (
    <Trans>Add a phone number</Trans>
  )

  const description = pending ? (
    kind === 'email' ? (
      <Trans>Enter the 6-digit code we just sent. It works for 10 minutes.</Trans>
    ) : (
      <Trans>Enter the 6-digit code we texted to {pending.target}. It works for 5 minutes.</Trans>
    )
  ) : kind === 'email' ? (
    <Trans>
      We'll send a 6-digit code to confirm it's yours. You can sign in with it once it's verified.
    </Trans>
  ) : (
    <Trans>We'll text a 6-digit code to confirm it's yours.</Trans>
  )

  const submitLabel = !pending ? (
    <Trans>Send code</Trans>
  ) : kind === 'email' ? (
    <Trans>Verify email</Trans>
  ) : (
    <Trans>Verify number</Trans>
  )

  const countdown = formatCountdown(remaining)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) setOpen(false)
      }}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) onClose()
      }}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" form={formId} isLoading={busy}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit} noValidate {...stylex.props(surface.formStack)}>
        {pending ? (
          <TextField
            label={<Trans>Code</Trans>}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/gu, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            hint={
              remaining > 0 ? (
                kind === 'phone' ? (
                  <Trans>
                    Didn't get it? You can send a new code in {countdown}. Up to 5 codes an hour.
                  </Trans>
                ) : (
                  <Trans>Didn't get it? You can send a new code in {countdown}.</Trans>
                )
              ) : undefined
            }
          />
        ) : kind === 'email' ? (
          <TextField
            label={<Trans>Email</Trans>}
            type="email"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            autoComplete="email"
            autoFocus
          />
        ) : (
          <TextField
            label={<Trans>Mobile number</Trans>}
            type="tel"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            autoComplete="tel"
            inputMode="tel"
            autoFocus
          />
        )}
      </form>
      {pending && remaining === 0 ? (
        <button type="button" onClick={handleResend} {...stylex.props(surface.linkButton)}>
          <Trans>Send a new code</Trans>
        </button>
      ) : null}
      {notice ? <Alert tone="info">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
    </Dialog>
  )
}
