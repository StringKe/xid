// 输入验证码的三种 MFA 方法:验证器应用、备份码、短信。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'
import * as stylex from '@stylexjs/stylex'
import { apiErrorDescriptor } from '@xid-kit/web-ui/api-error-message'
import { classifyApiError } from '@xid-kit/web-ui/api-errors'
import { Alert, Button, Field, Input, PageHeader } from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import { ChallengeExits } from './MfaExits'
import type { MfaMethod } from './mfa-search'
import { styles } from './styles'
import { useMfaVerify } from './use-mfa-verify'

export type ChallengeProps = {
  isStepUp: boolean
  methods: readonly MfaMethod[]
}

export function TotpChallenge({ isStepUp, methods }: ChallengeProps): ReactNode {
  const { t } = useLingui()
  const verify = useMfaVerify({
    method: 'totp',
    invalidMessage: t`Incorrect code. Check your authenticator app and try again.`,
  })
  const [code, setCode] = useState('')

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const trimmed = code.replace(/\s/g, '')
    if (trimmed.length !== 6 || !/^\d+$/.test(trimmed)) {
      verify.setError(t`Enter the 6-digit code from your authenticator app`)
      return
    }
    await verify.submit({
      path: '/auth/mfa/verify',
      body: { method: 'totp', code: trimmed, stepUp: isStepUp },
    })
  }

  return (
    <div {...stylex.props(styles.stack)}>
      <PageHeader
        title={<Trans>Authenticator code</Trans>}
        lead={<Trans>Open your authenticator app and enter the 6-digit code.</Trans>}
      />

      {verify.error ? <Alert tone="error">{verify.error}</Alert> : null}

      <form onSubmit={(e) => void handleSubmit(e)} noValidate {...stylex.props(styles.form)}>
        <div {...stylex.props(styles.otpInputWrap)}>
          <Field label={<Trans>One-time code</Trans>} error={verify.error ?? undefined} required>
            <Input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t`000000`}
              disabled={verify.isPending}
            />
          </Field>
        </div>

        <Button
          type="submit"
          fullWidth
          isLoading={verify.isPending}
          disabled={code.trim().length < 6}
        >
          <Trans>Verify</Trans>
        </Button>
      </form>

      <ChallengeExits methods={methods} />
    </div>
  )
}

export function BackupCodeChallenge({ isStepUp, methods }: ChallengeProps): ReactNode {
  const { t } = useLingui()
  const verify = useMfaVerify({
    method: 'backup',
    invalidMessage: t`Invalid or already-used backup code.`,
  })
  const [code, setCode] = useState('')

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const trimmed = code.trim().replace(/\s/g, '')
    if (trimmed.length < 8) {
      verify.setError(t`Enter a valid 8-character backup code`)
      return
    }
    await verify.submit({
      path: '/auth/mfa/verify',
      body: { method: 'backup', code: trimmed, stepUp: isStepUp },
    })
  }

  return (
    <div {...stylex.props(styles.stack)}>
      <PageHeader
        title={<Trans>Backup code</Trans>}
        lead={
          <Trans>
            Enter one of your 8-character backup codes. Each code can only be used once.
          </Trans>
        }
      />

      {verify.error ? <Alert tone="error">{verify.error}</Alert> : null}

      <form onSubmit={(e) => void handleSubmit(e)} noValidate {...stylex.props(styles.form)}>
        <Field label={<Trans>Backup code</Trans>} error={verify.error ?? undefined} required>
          <Input
            type="text"
            autoComplete="off"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t`xxxxxxxx`}
            disabled={verify.isPending}
          />
        </Field>

        <Button
          type="submit"
          fullWidth
          isLoading={verify.isPending}
          disabled={code.trim().length < 8}
        >
          <Trans>Verify</Trans>
        </Button>
      </form>

      <ChallengeExits methods={methods} />
    </div>
  )
}

export function SmsOtpChallenge({ isStepUp, methods }: ChallengeProps): ReactNode {
  const { t, i18n } = useLingui()
  const { api } = useAuth()
  const verify = useMfaVerify({
    method: 'sms',
    invalidMessage: t`Incorrect or expired code. Request a new one.`,
  })
  const [code, setCode] = useState('')
  const [smsSent, setSmsSent] = useState(false)

  const sendSmsMutation = useMutation({
    mutationFn: () => api.post('/auth/mfa/sms/send'),
    onSuccess: (result) => {
      if (!result.ok) {
        verify.setError(
          i18n._(apiErrorDescriptor(classifyApiError(result.error, { surface: 'general' }))),
        )
        return
      }
      verify.setError(null)
      setSmsSent(true)
    },
  })

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const trimmed = code.replace(/\s/g, '')
    if (trimmed.length !== 6 || !/^\d+$/.test(trimmed)) {
      verify.setError(t`Enter the 6-digit code sent to your phone`)
      return
    }
    await verify.submit({
      path: '/auth/mfa/verify',
      body: { method: 'sms', code: trimmed, stepUp: isStepUp },
    })
  }

  const isSending = sendSmsMutation.isPending

  return (
    <div {...stylex.props(styles.stack)}>
      <PageHeader
        title={<Trans>SMS verification</Trans>}
        lead={<Trans>We will send a 6-digit code to your registered phone number.</Trans>}
      />

      {verify.error ? <Alert tone="error">{verify.error}</Alert> : null}

      {!smsSent ? (
        <Button fullWidth isLoading={isSending} onClick={() => void sendSmsMutation.mutate()}>
          <Trans>Send code via SMS</Trans>
        </Button>
      ) : (
        <form onSubmit={(e) => void handleSubmit(e)} noValidate {...stylex.props(styles.form)}>
          <Alert tone="info">
            <Trans>A 6-digit code has been sent to your phone.</Trans>
          </Alert>
          <div {...stylex.props(styles.otpInputWrap)}>
            <Field label={<Trans>SMS code</Trans>} error={verify.error ?? undefined} required>
              <Input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={t`000000`}
                disabled={verify.isPending}
              />
            </Field>
          </div>
          <Button
            type="submit"
            fullWidth
            isLoading={verify.isPending}
            disabled={code.trim().length < 6}
          >
            <Trans>Verify</Trans>
          </Button>
          <p {...stylex.props(styles.helperText)}>
            <button
              type="button"
              {...stylex.props(styles.resendButton)}
              onClick={() => void sendSmsMutation.mutate()}
              disabled={isSending}
            >
              <Trans>Resend code</Trans>
            </button>
          </p>
        </form>
      )}

      <ChallengeExits methods={methods} />
    </div>
  )
}
