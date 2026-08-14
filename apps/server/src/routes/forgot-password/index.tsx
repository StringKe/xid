// 找回密码:request 枚举防护始终"已发送";reset token 从 URL fragment 捕获并在提交表单时消费。

import { Trans, useLingui } from '@lingui/react/macro'
import { useCallback, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { createLazyRoute, useSearch } from '@tanstack/react-router'
import { Link, useLocation, useNavigate } from '../../lib/router'
import { useMutation, useQuery } from '@tanstack/react-query'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { Alert, Button, Field, Input, PageHeader, Spinner } from '../../components/ui'
import { AuthLayout } from '../../components/layout'
import { useAuth } from '../../lib/auth-context'
import { PasswordStrength } from '../sign-up/PasswordStrength'
import { trackPasswordResetRequest } from '../../lib/google-analytics-funnel'
import { handleResetPasswordSuccess } from './reset-success'
import { DEFAULT_PUBLIC_AUTH_CONFIG, type PublicHostedAuthConfig } from '../sign-in/auth-config'
import { useTurnstile } from '../sign-in/useTurnstile'
import { useOneTimeLinkToken } from '../../lib/use-one-time-link-token'
import { forgotPasswordHref, passwordRecoverySignInHref } from './navigation'

type RequestStepProps = {
  organizationId?: string | null
  onDone: () => void
}

type ResetStepProps = {
  token: string
  clearToken: () => void
}

function scorePassword(password: string): 0 | 1 | 2 | 3 | 4 {
  if (!password) return 0
  let score = 0
  if (password.length >= 12) score++
  if (password.length >= 16) score++
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++
  if (/\d/.test(password)) score++
  if (/[^A-Za-z0-9]/.test(password)) score++
  return Math.min(4, score) as 0 | 1 | 2 | 3 | 4
}

const styles = stylex.create({
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
    minWidth: 0,
  },
  formFields: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  passwordGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  textLink: {
    fontSize: '0.8125rem',
    color: tokens['--xid-primary'],
    textDecorationLine: 'underline',
    textDecorationColor: {
      default: `color-mix(in oklch, ${tokens['--xid-primary']} 35%, transparent)`,
      ':hover': tokens['--xid-primary'],
    },
    textUnderlineOffset: '0.1875rem',
    transitionProperty: {
      default: 'text-decoration-color',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
    transitionDuration: '0.12s',
    transitionTimingFunction: 'ease-out',
    fontFamily: tokens['--xid-font'],
  },
  footerText: {
    margin: 0,
    fontSize: '0.8125rem',
    lineHeight: 1.55,
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
    textWrap: 'pretty',
  },
  turnstile: {
    display: 'flex',
    justifyContent: 'center',
    width: '100%',
  },
})

function RequestStep({ organizationId, onDone }: RequestStepProps): ReactNode {
  const { t } = useLingui()
  const { api } = useAuth()
  const [email, setEmail] = useState('')
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
    mutationFn: (emailValue: string) =>
      api.post('/auth/forgot-password', {
        email: emailValue,
        ...(organizationId ? { organizationId } : {}),
        turnstileToken,
      }),
    onSuccess: (result) => {
      if (!result.ok) {
        if (result.error.code === 'rate_limited') {
          setGlobalError(t`Too many requests. Please wait a minute before trying again.`)
          return
        }
        setGlobalError(t`Security verification failed. Please refresh and try again.`)
        return
      }
      trackPasswordResetRequest()
      onDone()
    },
    onSettled: () => setTurnstileToken(null),
  })

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setEmailError(null)
    setGlobalError(null)
    if (!email.includes('@')) {
      setEmailError(t`Enter a valid email address`)
      return
    }
    if (!turnstileReady) return
    await requestMutation.mutateAsync(email)
  }

  const isSubmitting = requestMutation.isPending

  return (
    <form onSubmit={(e) => void handleSubmit(e)} noValidate {...stylex.props(styles.stack)}>
      <PageHeader
        title={<Trans>Reset your password</Trans>}
        lead={<Trans>Enter your email and we will send a reset link.</Trans>}
      />

      {globalError ? <Alert tone="error">{globalError}</Alert> : null}

      <div {...stylex.props(styles.formFields)}>
        <Field label={<Trans>Email address</Trans>} error={emailError ?? undefined} required>
          <Input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t`you@example.com`}
            disabled={isSubmitting}
          />
        </Field>

        <div ref={containerRef} {...stylex.props(styles.turnstile)} />
        <Button type="submit" fullWidth isLoading={isSubmitting} disabled={!turnstileReady}>
          <Trans>Send reset link</Trans>
        </Button>
      </div>
    </form>
  )
}

function ResetStep({ token, clearToken }: ResetStepProps): ReactNode {
  const { t } = useLingui()
  const { api, refresh } = useAuth()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [passwordScore, setPasswordScore] = useState<0 | 1 | 2 | 3 | 4>(0)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [globalError, setGlobalError] = useState<string | null>(null)

  const handlePasswordChange = useCallback((value: string): void => {
    setPassword(value)
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
          setPasswordError(
            t`This password has appeared in a data breach. Please choose a different password.`,
          )
        } else if (error.meta?.paramName === 'password') {
          setPasswordError(error.message || t`Invalid password`)
        } else {
          setGlobalError(error.message || t`Something went wrong. Please try again.`)
        }
        return
      }
      clearToken()
      await handleResetPasswordSuccess({
        refresh,
        navigate: async (options) => navigate(options.to, { replace: options.replace }),
        redirectUrl: result.value.redirectUrl,
      })
    },
  })

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setPasswordError(null)
    setConfirmError(null)
    setGlobalError(null)

    let hasError = false
    if (password.length < 12) {
      setPasswordError(t`Password must be at least 12 characters`)
      hasError = true
    } else if (password.length > 128) {
      setPasswordError(t`Password must be at most 128 characters`)
      hasError = true
    }
    if (password !== confirm) {
      setConfirmError(t`Passwords do not match`)
      hasError = true
    }
    if (hasError) return

    await resetMutation.mutateAsync({ token, password })
  }

  const isSubmitting = resetMutation.isPending

  return (
    <form onSubmit={(e) => void handleSubmit(e)} noValidate {...stylex.props(styles.stack)}>
      <PageHeader
        title={<Trans>Choose a new password</Trans>}
        lead={<Trans>Enter a strong password to secure your account.</Trans>}
      />

      {globalError ? <Alert tone="error">{globalError}</Alert> : null}

      <div {...stylex.props(styles.formFields)}>
        <div {...stylex.props(styles.passwordGroup)}>
          <Field label={<Trans>New password</Trans>} error={passwordError ?? undefined} required>
            <Input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => handlePasswordChange(e.target.value)}
              placeholder={t`Minimum 12 characters`}
              disabled={isSubmitting}
            />
          </Field>
          {password.length > 0 ? <PasswordStrength score={passwordScore} /> : null}
        </div>

        <Field label={<Trans>Confirm password</Trans>} error={confirmError ?? undefined} required>
          <Input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={t`Repeat your password`}
            disabled={isSubmitting}
          />
        </Field>

        <Button type="submit" fullWidth isLoading={isSubmitting}>
          <Trans>Set new password</Trans>
        </Button>
      </div>
    </form>
  )
}

function RequestDoneView(): ReactNode {
  return (
    <div {...stylex.props(styles.stack)}>
      <PageHeader
        title={<Trans>Check your email</Trans>}
        lead={
          <Trans>
            If an account with that email exists, you will receive a password reset link shortly.
          </Trans>
        }
      />
    </div>
  )
}

function BackToSignIn({
  organizationId,
  locale,
}: {
  organizationId?: string | null
  locale?: string | null
}): ReactNode {
  return (
    <p {...stylex.props(styles.footerText)}>
      <Link
        to={passwordRecoverySignInHref({ organizationId, locale })}
        {...stylex.props(styles.textLink)}
      >
        <Trans>Back to sign in</Trans>
      </Link>
    </p>
  )
}

function ForgotPasswordPage(): ReactNode {
  // 挂两条路径,strict:false 不绑单一 route id。
  const search = useSearch({ strict: false }) as {
    token?: string
    organization_id?: string
    locale?: string
  }
  const { pathname } = useLocation()
  const isResetRoute = pathname === '/reset-password'
  const { token, ready, clearToken } = useOneTimeLinkToken({
    storageKey: 'xid.password-reset.token',
    legacyQueryToken: isResetRoute ? (search.token ?? null) : null,
  })
  const organizationId = search.organization_id ?? null
  const locale = search.locale ?? null
  const backToSignIn = <BackToSignIn organizationId={organizationId} locale={locale} />
  const requestNewLinkHref = forgotPasswordHref({ organizationId, locale })
  const [requestDone, setRequestDone] = useState(false)

  if (isResetRoute && !ready) {
    return (
      <AuthLayout footer={backToSignIn}>
        <div {...stylex.props(styles.stack)} aria-live="polite">
          <Spinner size={24} />
          <Trans>Preparing password reset...</Trans>
        </div>
      </AuthLayout>
    )
  }

  if (isResetRoute && token === null) {
    return (
      <AuthLayout footer={backToSignIn}>
        <div {...stylex.props(styles.stack)}>
          <PageHeader title={<Trans>Reset link unavailable</Trans>} />
          <Alert tone="error">
            <Trans>This reset link is invalid or has expired. Please request a new one.</Trans>
          </Alert>
          <Link to={requestNewLinkHref} {...stylex.props(styles.textLink)}>
            <Trans>Request a new reset link</Trans>
          </Link>
        </div>
      </AuthLayout>
    )
  }

  if (requestDone) {
    return (
      <AuthLayout footer={backToSignIn}>
        <RequestDoneView />
      </AuthLayout>
    )
  }

  return (
    <AuthLayout footer={backToSignIn}>
      {isResetRoute ? (
        <ResetStep token={token as string} clearToken={clearToken} />
      ) : (
        <RequestStep organizationId={organizationId} onDone={() => setRequestDone(true)} />
      )}
    </AuthLayout>
  )
}

export const Route = createLazyRoute('/forgot-password')({
  component: ForgotPasswordPage,
})
