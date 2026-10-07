// 输入验证码的三种第二步:验证器、短信、备用码。都是单个输入框,格式错误前端具体提示。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'
import * as stylex from '@stylexjs/stylex'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { Button, Notice } from '../../components/ui'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { CodeField, useCodeFormatMessage } from '../../components/hosted/CodeField'
import {
  codeFormatIssue,
  normalizeCode,
  type CodeCharset,
} from '../../components/hosted/code-input'
import { hosted } from '../../components/hosted/hosted-styles'
import { useHostedAuthConfig } from '../../components/hosted/use-hosted-auth-config'
import { useAuth } from '../../lib/auth-context'
import { ChallengeExits } from './MfaExits'
import type { MfaMethod } from './mfa-search'
import { useMfaVerify } from './use-mfa-verify'

export type ChallengeProps = {
  isStepUp: boolean
  methods: readonly MfaMethod[]
  above: ReactNode
}

type CodeFormProps = ChallengeProps & {
  method: Exclude<MfaMethod, 'passkey'>
  title: ReactNode
  lead: ReactNode
  label: ReactNode
  hint: ReactNode
  invalidMessage: string
  length: number
  charset: CodeCharset
  notice?: ReactNode
  disabled?: boolean
}

function CodeChallengeForm(props: CodeFormProps): ReactNode {
  const verify = useMfaVerify({ method: props.method, invalidMessage: props.invalidMessage })
  const formatMessage = useCodeFormatMessage()
  const [code, setCode] = useState('')

  function submit(raw: string): void {
    if (verify.isPending) return
    const issue = codeFormatIssue(raw, { length: props.length, charset: props.charset })
    if (issue) {
      verify.setError(
        formatMessage(issue, { length: props.length, actual: raw, charset: props.charset }),
      )
      return
    }
    void verify.submit({
      path: '/auth/mfa/verify',
      body: {
        method: props.method,
        code: normalizeCode(raw, props.charset),
        stepUp: props.isStepUp,
      },
    })
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    submit(code)
  }

  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading above={props.above} title={props.title} lead={props.lead} />
      {props.notice}
      <form noValidate onSubmit={handleSubmit} {...stylex.props(hosted.form)}>
        <CodeField
          label={props.label}
          value={code}
          onValueChange={(value) => {
            verify.setError(null)
            setCode(value)
          }}
          onComplete={submit}
          length={props.length}
          charset={props.charset}
          oneTimeCode={props.charset === 'numeric'}
          hint={props.hint}
          error={verify.error ?? undefined}
          disabled={props.disabled}
          autoFocus
        />
        <Button
          type="submit"
          variant="accent"
          size="lg"
          fullWidth
          isLoading={verify.isPending}
          disabled={props.disabled}
        >
          <Trans>Verify</Trans>
        </Button>
      </form>
      {props.isStepUp ? (
        <p {...stylex.props(hosted.note)}>
          <Trans>Text message codes can't be used to confirm changes like this.</Trans>
        </p>
      ) : null}
      <ChallengeExits methods={props.methods} isStepUp={props.isStepUp} />
    </div>
  )
}

export function TotpChallenge(props: ChallengeProps): ReactNode {
  const { t } = useLingui()
  const { config } = useHostedAuthConfig()
  const org = config.context.organizationName
  return (
    <CodeChallengeForm
      {...props}
      method="totp"
      title={<Trans>Enter the code from your authenticator app</Trans>}
      lead={
        org ? (
          <Trans>Open the app you set up for {org} and enter the 6-digit code it shows now.</Trans>
        ) : (
          <Trans>Open your authenticator app and enter the 6-digit code it shows now.</Trans>
        )
      }
      label={<Trans>6-digit code</Trans>}
      hint={<Trans>You can paste the code. Spaces are ignored.</Trans>}
      invalidMessage={t`That code didn't work. Enter the code your app shows now.`}
      length={6}
      charset="numeric"
    />
  )
}

export function BackupCodeChallenge(props: ChallengeProps): ReactNode {
  const { t } = useLingui()
  return (
    <CodeChallengeForm
      {...props}
      method="backup"
      title={<Trans>Enter a backup code</Trans>}
      lead={
        <Trans>
          Use one of the codes you saved when you set up two-step verification. Each code works
          once.
        </Trans>
      }
      label={<Trans>Backup code</Trans>}
      hint={<Trans>8 letters and numbers. Spaces are ignored.</Trans>}
      invalidMessage={t`That code didn't work. Check it against your saved list, or try another way.`}
      length={8}
      charset="alphanumeric"
    />
  )
}

export function SmsOtpChallenge(props: ChallengeProps): ReactNode {
  const { t } = useLingui()
  const { api } = useAuth()
  const apiErrorMessage = useApiErrorMessage()
  const [sentAt, setSentAt] = useState<number | null>(null)
  const [resent, setResent] = useState(false)
  const send = useMutation({ mutationFn: () => api.post('/auth/mfa/sms/send') })

  function requestCode(): void {
    send.mutate(undefined, {
      onSuccess: (result) => {
        if (!result.ok) return
        setResent(sentAt !== null)
        setSentAt(Date.now())
      },
    })
  }

  const sendError =
    send.data && !send.data.ok ? apiErrorMessage(send.data.error, { surface: 'general' }) : null
  const notice = sendError ? (
    <Notice tone="danger">{sendError}</Notice>
  ) : resent ? (
    <Notice tone="info" title={<Trans>New code sent</Trans>}>
      <Trans>The previous code no longer works. Use the code in the newest message.</Trans>
    </Notice>
  ) : null

  if (sentAt === null) {
    return (
      <div {...stylex.props(hosted.screen)}>
        <AuthHeading
          above={props.above}
          title={<Trans>Get a code by text message</Trans>}
          lead={<Trans>We'll text a 6-digit code to the phone number on your account.</Trans>}
        />
        {notice}
        <Button
          variant="accent"
          size="lg"
          fullWidth
          isLoading={send.isPending}
          onClick={requestCode}
        >
          <Trans>Text me a code</Trans>
        </Button>
        <ChallengeExits methods={props.methods} isStepUp={props.isStepUp} />
      </div>
    )
  }

  return (
    <CodeChallengeForm
      {...props}
      method="sms"
      title={<Trans>Enter the code we texted you</Trans>}
      lead={
        <>
          <Trans>It works for 5 minutes.</Trans>{' '}
          <button
            type="button"
            onClick={requestCode}
            disabled={send.isPending}
            {...stylex.props(hosted.textLink)}
          >
            <Trans>Resend code</Trans>
          </button>
        </>
      }
      label={<Trans>6-digit code</Trans>}
      hint={<Trans>You can paste the code. Spaces are ignored.</Trans>}
      invalidMessage={t`That code didn't work. Check the newest message and enter it again.`}
      length={6}
      charset="numeric"
      notice={notice}
    />
  )
}
