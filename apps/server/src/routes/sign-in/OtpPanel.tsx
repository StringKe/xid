// 验证码步骤:单输入框;格式错误前端具体提示,错码统一一句;过期由本地计时推算;
// 重发后写明旧码已作废;限流只有一条文案,不点名 IP 或账户。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, Notice } from '../../components/ui'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { CodeField, useCodeFormatMessage } from '../../components/hosted/CodeField'
import { codeFormatIssue, normalizeCode } from '../../components/hosted/code-input'
import { hosted } from '../../components/hosted/hosted-styles'
import { maskEmail, phoneLastDigits } from './identifier-mask'
import { formatCountdown, isOtpExpired, otpLifetimeMinutes, resendWaitSeconds } from './otp-timing'
import type { OtpSignInMethod } from './shared'
import type { SignInActions, SignInState } from './sign-in-types'

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function OtpTitle({ method }: { method: OtpSignInMethod }): ReactNode {
  if (method === 'otp-sms') return <Trans>Enter the code we texted you</Trans>
  if (method === 'otp-whatsapp') return <Trans>Enter the code we sent on WhatsApp</Trans>
  return <Trans>Enter the code we emailed you</Trans>
}

function useTargetLabel(identifier: string, method: OtpSignInMethod): string {
  const { t } = useLingui()
  if (method === 'otp-email') return maskEmail(identifier.trim())
  const last = phoneLastDigits(identifier)
  return t`the number ending in ${last}`
}

function ResendLine(props: {
  method: OtpSignInMethod
  waitSeconds: number
  disabled: boolean
  onResend: () => void
}): ReactNode {
  const question =
    props.method === 'otp-email' ? <Trans>No email yet?</Trans> : <Trans>No message yet?</Trans>
  if (props.waitSeconds > 0) {
    const countdown = formatCountdown(props.waitSeconds)
    return (
      <p {...stylex.props(hosted.note, hosted.tabular)}>
        {question} <Trans>You can resend in {countdown}</Trans>
      </p>
    )
  }
  return (
    <p {...stylex.props(hosted.note)}>
      {question}{' '}
      <button
        type="button"
        disabled={props.disabled}
        onClick={props.onResend}
        {...stylex.props(hosted.textLink)}
      >
        <Trans>Resend code</Trans>
      </button>
    </p>
  )
}

export function OtpPanel(props: {
  method: OtpSignInMethod
  state: SignInState
  actions: SignInActions
  above: ReactNode
}): ReactNode {
  const { i18n, t } = useLingui()
  const { method, state, actions } = props
  const formatMessage = useCodeFormatMessage()
  const [formatError, setFormatError] = useState<string | null>(null)
  const now = useNow(state.otpSentAt !== null)
  const target = useTargetLabel(state.identifier, method)
  const minutes = otpLifetimeMinutes(method)
  const sentAt = state.otpSentAt
  const expired = sentAt !== null && isOtpExpired({ now, sentAt, method })
  const rateLimited = state.error === 'rate_limited'
  const invalid = state.error === 'auth_failed'
  const waitSeconds = sentAt === null ? 0 : resendWaitSeconds({ now, sentAt })
  const sentTime =
    sentAt === null ? '' : i18n.date(new Date(sentAt), { hour: 'numeric', minute: '2-digit' })

  function submit(raw: string): void {
    const issue = codeFormatIssue(raw, { length: 6, charset: 'numeric' })
    if (issue) {
      setFormatError(formatMessage(issue, { length: 6, actual: raw, charset: 'numeric' }))
      return
    }
    setFormatError(null)
    actions.verifyOtp(normalizeCode(raw, 'numeric'))
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    submit(state.otpCode)
  }

  const lead =
    sentAt === null
      ? t`Sending a 6-digit code to ${target}.`
      : t`We sent a 6-digit code to ${target}. It works for ${minutes} minutes.`
  const fieldError =
    formatError ??
    (invalid
      ? method === 'otp-email'
        ? t`That code didn't work. Check the newest email and enter it again.`
        : t`That code didn't work. Check the newest message and enter it again.`
      : undefined)

  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading above={props.above} title={<OtpTitle method={method} />} lead={lead} />
      {rateLimited ? (
        <Notice tone="warning" title={<Trans>Too many attempts</Trans>}>
          <Trans>Wait a few minutes, then try again. You can also sign in another way.</Trans>
        </Notice>
      ) : expired ? (
        <Notice tone="warning" title={<Trans>This code has expired</Trans>}>
          <Trans>Codes work for {minutes} minutes. Send a new one and enter it here.</Trans>
        </Notice>
      ) : state.otpResent ? (
        <Notice tone="info" title={<Trans>New code sent at {sentTime}</Trans>}>
          <Trans>The previous code no longer works. Use the code in the newest message.</Trans>
        </Notice>
      ) : null}
      <form noValidate onSubmit={handleSubmit} {...stylex.props(hosted.form)}>
        <CodeField
          label={<Trans>Verification code</Trans>}
          value={state.otpCode}
          onValueChange={(value) => {
            setFormatError(null)
            actions.setOtpCode(value)
          }}
          onComplete={submit}
          length={6}
          hint={<Trans>6 digits. Spaces and dashes are fine.</Trans>}
          error={fieldError}
          disabled={rateLimited || sentAt === null}
          autoFocus
        />
        {expired ? (
          <Button
            variant="accent"
            size="lg"
            fullWidth
            isLoading={state.isSendingOtp}
            disabled={waitSeconds > 0}
            onClick={actions.requestOtp}
          >
            <Trans>Send a new code</Trans>
          </Button>
        ) : (
          <Button
            type="submit"
            variant="accent"
            size="lg"
            fullWidth
            isLoading={state.isVerifyingOtp || state.isSendingOtp}
            disabled={rateLimited || sentAt === null}
          >
            <Trans>Verify code</Trans>
          </Button>
        )}
      </form>
      {expired || rateLimited ? null : (
        <ResendLine
          method={method}
          waitSeconds={waitSeconds}
          disabled={state.isSendingOtp || !state.turnstileReady}
          onResend={actions.requestOtp}
        />
      )}
    </div>
  )
}
