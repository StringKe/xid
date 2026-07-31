// 密码区:有 passwords 行 -> current + new + confirm 改密表单;
// passwordless(guest / social / OTP 建号)-> "Set a password" 邮件链接仪式
// (已验证邮箱发 setup 链接;未验证先发验证邮件;无邮箱引导加 passkey)。
// 状态与 mutation 完全自包含,经 Section/SectionRow 共享骨架渲染。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, Field, Input, Section, SectionRow } from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import { trackPasswordChanged } from '../../lib/google-analytics-funnel'
import { useChangePassword, useResendVerificationEmail, useSendPasswordSetupLink } from './queries'

const styles = stylex.create({
  formFooter: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    // hairline 邻接 >= 1.25rem:SectionRow 末行底线到提交按钮文本 >= 1.25rem
    paddingBlockStart: '1.25rem',
    paddingBlockEnd: '0.875rem',
  },
  submitBtn: {
    alignSelf: 'flex-start',
  },
  staticValue: {
    fontSize: '0.875rem',
    lineHeight: 1.5,
    overflowWrap: 'anywhere',
  },
})

type XidErrorShape = {
  message?: string
  longMessage?: string
  meta?: { paramName?: string }
}

function errorText(err: unknown, fallback: string): string {
  const xidErr = err as XidErrorShape
  return xidErr.longMessage || xidErr.message || fallback
}

export function ChangePasswordSection(): ReactNode {
  const { user } = useAuth()
  // hasPassword 缺失(旧版 Core)回退改密表单,保持既有行为。
  if (user?.hasPassword === false) {
    return <SetPasswordSection email={user.email} emailVerified={user.emailVerified} />
  }
  return <ChangePasswordForm />
}

// passwordless 设密:不设密码字段,统一走邮件证明仪式(setup 链接 = reset token 仪式)。
function SetPasswordSection({
  email,
  emailVerified,
}: {
  email: string
  emailVerified: boolean
}): ReactNode {
  const { t } = useLingui()
  const sendSetupLink = useSendPasswordSetupLink()
  const resendVerification = useResendVerificationEmail()
  const [sentKind, setSentKind] = useState<'setup' | 'verification' | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const handleSendSetupLink = async (): Promise<void> => {
    setErrorMsg(null)
    setSentKind(null)
    try {
      await sendSetupLink.mutateAsync()
      setSentKind('setup')
    } catch (err) {
      setErrorMsg(errorText(err, t`Failed to send the setup link. Try again.`))
    }
  }

  const handleResendVerification = async (): Promise<void> => {
    setErrorMsg(null)
    setSentKind(null)
    try {
      await resendVerification.mutateAsync()
      setSentKind('verification')
    } catch (err) {
      setErrorMsg(errorText(err, t`Failed to send the verification email. Try again.`))
    }
  }

  return (
    <Section label={<Trans>Set a password</Trans>}>
      {email ? (
        <SectionRow variant="static" label={<Trans>Email address</Trans>}>
          <span {...stylex.props(styles.staticValue)}>{email}</span>
        </SectionRow>
      ) : null}

      <div {...stylex.props(styles.formFooter)}>
        {!email ? (
          <Alert tone="info" title={<Trans>No email address</Trans>}>
            <Trans>
              This account has no email address yet. Add a passkey below to secure it and keep
              access after you sign out.
            </Trans>
          </Alert>
        ) : null}

        {email && !emailVerified && sentKind !== 'verification' ? (
          <Alert tone="info" title={<Trans>Verify your email first</Trans>}>
            <Trans>
              Your email address is not verified yet. We will send a verification email; after
              verifying, return here to set a password.
            </Trans>
          </Alert>
        ) : null}

        {sentKind === 'verification' ? (
          <Alert tone="success">
            <Trans>
              Verification email sent. After verifying your email, return here to set a password.
            </Trans>
          </Alert>
        ) : null}

        {sentKind === 'setup' ? (
          <Alert tone="success">
            <Trans>Setup link sent. Check your inbox to finish setting a password.</Trans>
          </Alert>
        ) : null}

        {errorMsg ? <Alert tone="error">{errorMsg}</Alert> : null}

        {email && !emailVerified ? (
          <Button
            type="button"
            variant="primary"
            isLoading={resendVerification.isPending}
            onClick={() => void handleResendVerification()}
            {...stylex.props(styles.submitBtn)}
          >
            <Trans>Resend verification email</Trans>
          </Button>
        ) : null}

        {email && emailVerified && sentKind !== 'setup' ? (
          <Button
            type="button"
            variant="primary"
            isLoading={sendSetupLink.isPending}
            onClick={() => void handleSendSetupLink()}
            {...stylex.props(styles.submitBtn)}
          >
            <Trans>Email me a setup link</Trans>
          </Button>
        ) : null}
      </div>
    </Section>
  )
}

function ChangePasswordForm(): ReactNode {
  const { t } = useLingui()
  const changePassword = useChangePassword()

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setFieldErrors({})
    setErrorMsg(null)
    setSuccessMsg(null)

    if (newPassword !== confirmPassword) {
      setFieldErrors({ confirmPassword: t`Passwords do not match.` })
      return
    }
    if (newPassword.length < 12) {
      setFieldErrors({ newPassword: t`Password must be at least 12 characters.` })
      return
    }

    try {
      await changePassword.mutateAsync({ currentPassword, newPassword })
      trackPasswordChanged()
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setSuccessMsg(t`Password updated successfully.`)
    } catch (err) {
      const xidErr = err as XidErrorShape
      if (xidErr.meta?.paramName) {
        setFieldErrors({ [xidErr.meta.paramName]: xidErr.longMessage || xidErr.message || '' })
      } else {
        setErrorMsg(errorText(err, t`Failed to update password.`))
      }
    }
  }

  return (
    <Section label={<Trans>Change password</Trans>}>
      <form onSubmit={(e) => void handleSubmit(e)} noValidate>
        <SectionRow variant="control" label={<Trans>Current password</Trans>}>
          <Field required error={fieldErrors.currentPassword}>
            <Input
              type="password"
              aria-label={t`Current password`}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
        </SectionRow>

        <SectionRow variant="control" label={<Trans>New password</Trans>}>
          <Field required error={fieldErrors.newPassword}>
            <Input
              type="password"
              aria-label={t`New password`}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </Field>
        </SectionRow>

        <SectionRow variant="control" label={<Trans>Confirm new password</Trans>}>
          <Field required error={fieldErrors.confirmPassword}>
            <Input
              type="password"
              aria-label={t`Confirm new password`}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </Field>
        </SectionRow>

        <div {...stylex.props(styles.formFooter)}>
          {errorMsg ? <Alert tone="error">{errorMsg}</Alert> : null}
          {successMsg ? <Alert tone="success">{successMsg}</Alert> : null}
          <Button
            type="submit"
            variant="primary"
            isLoading={changePassword.isPending}
            {...stylex.props(styles.submitBtn)}
          >
            <Trans>Update password</Trans>
          </Button>
        </div>
      </form>
    </Section>
  )
}
