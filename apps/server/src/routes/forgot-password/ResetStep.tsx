// 重置密码步骤:用 URL fragment 捕获的一次性 token 设置新密码。

import { Trans, useLingui } from '@lingui/react/macro'
import { useCallback, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useNavigate } from '@xid-kit/web-ui/tanstack-router'
import { useMutation } from '@tanstack/react-query'
import * as stylex from '@stylexjs/stylex'
import { Button, Notice, PasswordField } from '../../components/ui'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { hosted } from '../../components/hosted/hosted-styles'
import { useAuth } from '../../lib/auth-context'
import { PasswordStrength, scorePassword, type PasswordScore } from '../sign-up/PasswordStrength'
import { handleResetPasswordSuccess } from './reset-success'
import { useDefaultLandingPath } from '../../lib/default-landing'

type ResetStepProps = {
  token: string
  clearToken: () => void
  // 注册后经邮箱证明首次设密:同一表单,标题说明是完成注册而不是找回密码。
  isAccountSetup: boolean
}

const MIN_PASSWORD_LENGTH = 12
const MAX_PASSWORD_LENGTH = 128

export function ResetStep({ token, clearToken, isAccountSetup }: ResetStepProps): ReactNode {
  const { t } = useLingui()
  const { api, refresh } = useAuth()
  const navigate = useNavigate()
  const defaultLandingPath = useDefaultLandingPath()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [passwordScore, setPasswordScore] = useState<PasswordScore>(0)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [breached, setBreached] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [globalError, setGlobalError] = useState<string | null>(null)

  const handlePasswordChange = useCallback((value: string): void => {
    setPassword(value)
    setBreached(false)
    setPasswordScore(scorePassword(value))
  }, [])

  const resetMutation = useMutation({
    mutationFn: (payload: { token: string; password: string }) =>
      api.post<{ redirectUrl?: string }>('/auth/reset-password', payload),
    onSuccess: async (result) => {
      if (!result.ok) {
        const { error } = result
        if (error.code === 'token_expired' || error.code === 'token_invalid') {
          clearToken()
        } else if (error.code === 'password_breached') {
          setBreached(true)
        } else if (error.meta?.paramName === 'password') {
          setPasswordError(error.message || t`Choose a different password.`)
        } else {
          setGlobalError(error.message || t`Something went wrong. Try again.`)
        }
        return
      }
      clearToken()
      await handleResetPasswordSuccess({
        refresh,
        navigate: async (options) => navigate(options.to, { replace: options.replace }),
        redirectUrl: result.value.redirectUrl,
        fallbackPath: defaultLandingPath,
      })
    },
  })

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setPasswordError(null)
    setConfirmError(null)
    setGlobalError(null)
    let hasError = false
    if (password.length < MIN_PASSWORD_LENGTH) {
      setPasswordError(t`Use at least ${MIN_PASSWORD_LENGTH} characters.`)
      hasError = true
    } else if (password.length > MAX_PASSWORD_LENGTH) {
      setPasswordError(t`Use at most ${MAX_PASSWORD_LENGTH} characters.`)
      hasError = true
    }
    if (password !== confirm) {
      setConfirmError(t`The two passwords don't match.`)
      hasError = true
    }
    if (hasError) return
    await resetMutation.mutateAsync({ token, password })
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} noValidate {...stylex.props(hosted.screen)}>
      <AuthHeading
        title={
          isAccountSetup ? <Trans>Set your password</Trans> : <Trans>Choose a new password</Trans>
        }
        lead={
          isAccountSetup ? (
            <Trans>Your email is verified. Set a password to finish creating your account.</Trans>
          ) : (
            <Trans>
              Use at least {MIN_PASSWORD_LENGTH} characters. A longer phrase is easier to remember
              and harder to guess.
            </Trans>
          )
        }
      />
      {globalError ? <Notice tone="danger">{globalError}</Notice> : null}
      {breached ? (
        <Notice tone="warning" title={<Trans>This password appeared in a data breach</Trans>}>
          <Trans>
            It's on a public list of leaked passwords, so attackers try it first. Choose a different
            one.
          </Trans>
        </Notice>
      ) : null}
      <div {...stylex.props(hosted.form)}>
        <div {...stylex.props(hosted.group)}>
          <PasswordField
            label={<Trans>New password</Trans>}
            autoComplete="new-password"
            value={password}
            onChange={(e) => handlePasswordChange(e.target.value)}
            error={passwordError ?? undefined}
            disabled={resetMutation.isPending}
          />
          {password.length > 0 ? <PasswordStrength score={passwordScore} /> : null}
        </div>
        <PasswordField
          label={<Trans>Confirm password</Trans>}
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={confirmError ?? undefined}
          disabled={resetMutation.isPending}
        />
        <Button
          type="submit"
          variant="accent"
          size="lg"
          fullWidth
          isLoading={resetMutation.isPending}
        >
          <Trans>Set new password</Trans>
        </Button>
      </div>
    </form>
  )
}
