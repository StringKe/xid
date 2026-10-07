// 找回密码:request 枚举防护始终"已发送";reset token 从 URL fragment 捕获并在提交表单时消费。

import { Trans, useLingui } from '@lingui/react/macro'
import { useCallback, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { createLazyRoute, useSearch } from '@tanstack/react-router'
import { Link, useLocation, useNavigate } from '@xid-kit/web-ui/tanstack-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import * as stylex from '@stylexjs/stylex'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { Button, Field, Input, Notice, PasswordField, Spinner } from '../../components/ui'
import { AuthLayout } from '../../components/layout'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { hosted } from '../../components/hosted/hosted-styles'
import { useAuth } from '../../lib/auth-context'
import { page } from '../../styles/product-surface.stylex'
import { PasswordStrength, scorePassword, type PasswordScore } from '../sign-up/PasswordStrength'
import { trackPasswordResetRequest } from '../../lib/google-analytics-funnel'
import { handleResetPasswordSuccess } from './reset-success'
import { useDefaultLandingPath } from '../../lib/default-landing'
import { DEFAULT_PUBLIC_AUTH_CONFIG, type PublicHostedAuthConfig } from '../sign-in/auth-config'
import { useTurnstile } from '../sign-in/useTurnstile'
import { buildSignInFlowFields } from '../sign-in/sign-in-flow'
import { maskEmail } from '../sign-in/identifier-mask'
import { useOneTimeLinkToken } from '../../lib/use-one-time-link-token'
import {
  forgotPasswordHref,
  passwordRecoverySignInHref,
  type PasswordRecoverySearch,
} from './navigation'

type RequestStepProps = {
  search: PasswordRecoverySearch
  onDone: (email: string) => void
}

type ResetStepProps = {
  token: string
  clearToken: () => void
  // 注册后经邮箱证明首次设密:同一表单,标题说明是完成注册而不是找回密码。
  isAccountSetup: boolean
}

const MIN_PASSWORD_LENGTH = 12
const MAX_PASSWORD_LENGTH = 128

const styles = stylex.create({
  turnstile: {
    display: 'flex',
    justifyContent: 'center',
    width: '100%',
  },
})

function RequestStep({ search, onDone }: RequestStepProps): ReactNode {
  const { t } = useLingui()
  const { api } = useAuth()
  const apiErrorMessage = useApiErrorMessage()
  const organizationId = search.organization_id ?? null
  const [email, setEmail] = useState(search.login_hint?.includes('@') ? search.login_hint : '')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [globalError, setGlobalError] = useState<string | null>(null)
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const authConfigQuery = useQuery<PublicHostedAuthConfig, never>({
    queryKey: ['auth-config', 'forgot-password', organizationId ?? null],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (organizationId) params.set('organization_id', organizationId)
      const path = params.size > 0 ? `/auth/config?${params.toString()}` : '/auth/config'
      const result = await api.get<PublicHostedAuthConfig>(path)
      return result.ok ? result.value : DEFAULT_PUBLIC_AUTH_CONFIG
    },
    retry: false,
  })
  const authConfig = authConfigQuery.data ?? DEFAULT_PUBLIC_AUTH_CONFIG
  const { containerRef } = useTurnstile(
    authConfig.turnstileSiteKey,
    turnstileToken,
    setTurnstileToken,
  )
  const turnstileReady =
    !authConfigQuery.isPending && (authConfig.turnstileSiteKey === null || Boolean(turnstileToken))

  const requestMutation = useMutation({
    mutationFn: (emailValue: string) => {
      const { continue: continuePath, intent, clientId } = buildSignInFlowFields(search)
      return api.post('/auth/forgot-password', {
        email: emailValue,
        ...(organizationId ? { organizationId } : {}),
        ...(continuePath ? { continue: continuePath } : {}),
        ...(intent ? { intent } : {}),
        ...(clientId ? { clientId } : {}),
        turnstileToken,
      })
    },
    onSuccess: (result, emailValue) => {
      if (!result.ok) {
        const { code } = result.error
        if (code === 'rate_limited') {
          setGlobalError(t`Too many requests. Wait a minute, then try again.`)
        } else if (code === 'captcha_required' || code === 'captcha_failed') {
          setGlobalError(t`The security check didn't finish. Reload the page and try again.`)
        } else {
          setGlobalError(apiErrorMessage(result.error, { surface: 'general' }))
        }
        return
      }
      trackPasswordResetRequest()
      onDone(emailValue)
    },
    onSettled: () => setTurnstileToken(null),
  })

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setEmailError(null)
    setGlobalError(null)
    if (!email.includes('@')) {
      setEmailError(t`Enter the email address you sign in with.`)
      return
    }
    if (!turnstileReady) return
    await requestMutation.mutateAsync(email)
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} noValidate {...stylex.props(hosted.screen)}>
      <AuthHeading
        title={<Trans>Reset your password</Trans>}
        lead={
          <Trans>
            Enter the email you sign in with. We'll send a link to choose a new password.
          </Trans>
        }
      />
      {globalError ? <Notice tone="danger">{globalError}</Notice> : null}
      <div {...stylex.props(hosted.form)}>
        <Field label={<Trans>Email address</Trans>} error={emailError ?? undefined}>
          <Input
            type="email"
            inputSize="lg"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t`you@example.com`}
            disabled={requestMutation.isPending}
          />
        </Field>
        <div ref={containerRef} {...stylex.props(styles.turnstile)} />
        <Button
          type="submit"
          variant="accent"
          size="lg"
          fullWidth
          isLoading={requestMutation.isPending}
          disabled={!turnstileReady}
        >
          <Trans>Send reset link</Trans>
        </Button>
      </div>
    </form>
  )
}

function ResetStep({ token, clearToken, isAccountSetup }: ResetStepProps): ReactNode {
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

function RequestDoneView({ email }: { email: string }): ReactNode {
  const masked = maskEmail(email)
  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        title={<Trans>Check your email</Trans>}
        lead={
          <Trans>
            If {masked} has an account, a reset link is on its way. It works once, for 15 minutes.
          </Trans>
        }
      />
      <p {...stylex.props(hosted.note)}>
        <Trans>
          No email after a few minutes? Check spam, or try again with the address you sign in with.
        </Trans>
      </p>
    </div>
  )
}

function BackToSignIn({ search }: { search: PasswordRecoverySearch }): ReactNode {
  return (
    <Link to={passwordRecoverySignInHref(search)} {...stylex.props(hosted.textLink)}>
      <Trans>Back to sign in</Trans>
    </Link>
  )
}

function ForgotPasswordPage(): ReactNode {
  const { t } = useLingui()
  // 挂两条路径,strict:false 不绑单一 route id。
  const search = useSearch({ strict: false }) as PasswordRecoverySearch & {
    token?: string
    setup?: string
  }
  const { pathname } = useLocation()
  const isResetRoute = pathname === '/reset-password'
  const { token, ready, clearToken } = useOneTimeLinkToken({
    storageKey: 'xid.password-reset.token',
    legacyQueryToken: isResetRoute ? (search.token ?? null) : null,
  })
  const backToSignIn = <BackToSignIn search={search} />
  const [requestedEmail, setRequestedEmail] = useState<string | null>(null)
  const context = {
    lead: t`Your account`,
    title: t`Password reset`,
    description: t`Reset links are single-use and expire after 15 minutes so nobody else can use an old email.`,
  }

  function content(): ReactNode {
    if (isResetRoute && !ready) {
      return (
        <div {...stylex.props(page.loadingCenter)} aria-live="polite">
          <Spinner label={t`Preparing password reset`} />
        </div>
      )
    }
    if (isResetRoute && token === null) {
      return (
        <div {...stylex.props(hosted.screen)}>
          <AuthHeading
            title={<Trans>This reset link no longer works</Trans>}
            lead={
              <Trans>
                Reset links work once, for 15 minutes. Request a new one and open the newest email.
              </Trans>
            }
          />
          <Link to={forgotPasswordHref(search)} {...stylex.props(hosted.textLink)}>
            <Trans>Request a new reset link</Trans>
          </Link>
        </div>
      )
    }
    if (requestedEmail !== null) return <RequestDoneView email={requestedEmail} />
    if (isResetRoute) {
      return (
        <ResetStep
          token={token as string}
          clearToken={clearToken}
          isAccountSetup={String(search.setup) === '1'}
        />
      )
    }
    return <RequestStep search={search} onDone={setRequestedEmail} />
  }

  return (
    <AuthLayout context={context} footer={backToSignIn}>
      {content()}
    </AuthLayout>
  )
}

export const Route = createLazyRoute('/forgot-password')({
  component: ForgotPasswordPage,
})
