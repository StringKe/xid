// 找回密码入口:两步流程。
// Step 1(request):输入 email -> POST /auth/forgot-password -> 枚举防护:不区分邮件存在与否,始终返回"已发送"态。
// Step 2(reset):通过 ?token= 进入 -> 填新密码 -> POST /auth/reset-password。
// token 有效期 15min;token 只存哈希(server 侧);过期/已用 token 返回结构化错误。
// TanStack Router useSearch 读 token + useMutation 提交。
//
// 视觉语言对齐 sign-in(AuthLayout 批次 B):stack gap 1.25rem / formFields gap 1rem /
// 文本链接 35% 弱化下划线 hover 升满 / 页脚用 AuthLayout footer slot。

import { Trans, useLingui } from '@lingui/react/macro'
import { useCallback, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { createLazyRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { Link } from '../../lib/router'
import { useMutation } from '@tanstack/react-query'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { Alert, Button, Field, Input, PageHeader } from '../../components/ui'
import { AuthLayout } from '../../components/layout'
import { useAuth } from '../../lib/auth-context'
import { PasswordStrength } from '../sign-up/PasswordStrength'
import { trackPasswordResetRequest } from '../../lib/google-analytics-funnel'
import { handleResetPasswordSuccess } from './reset-success'

type RequestStepProps = {
  organizationId?: string | null
  onDone: () => void
}

type ResetStepProps = {
  token: string
}

// 密码强度评分(复用 sign-up 逻辑,无需外部依赖)。
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
  // 卡片内主栈:对齐 sign-in stack(1.25rem gap,比 page.root 1.5rem 收一档)。
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
    minWidth: 0,
  },
  // 表单字段区:flex column gap 1rem。
  formFields: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  // 密码字段 + 强度条分组(间距收窄)。
  passwordGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  // 文本链接(忘记密码 / 返回登录):下划线常驻但弱化 35%,hover 升满,对齐 sign-in textLink。
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
  // 页脚文案:对齐 sign-in footerText。
  footerText: {
    margin: 0,
    fontSize: '0.8125rem',
    lineHeight: 1.55,
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
    textWrap: 'pretty',
  },
})

function RequestStep({ organizationId, onDone }: RequestStepProps): ReactNode {
  const { t } = useLingui()
  const { api } = useAuth()
  const [email, setEmail] = useState('')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [globalError, setGlobalError] = useState<string | null>(null)

  const requestMutation = useMutation({
    mutationFn: (emailValue: string) =>
      api.post('/auth/forgot-password', {
        email: emailValue,
        ...(organizationId ? { organizationId } : {}),
      }),
    onSuccess: (result) => {
      if (!result.ok) {
        // 枚举防护:即使请求失败也不区分原因,仅在严重错误时提示。
        if (result.error.code === 'rate_limited') {
          setGlobalError(t`Too many requests. Please wait a minute before trying again.`)
          return
        }
        // 其它错误统一走成功态(不泄露邮箱存在性)。
      }
      trackPasswordResetRequest()
      onDone()
    },
  })

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setEmailError(null)
    setGlobalError(null)
    if (!email.includes('@')) {
      setEmailError(t`Enter a valid email address`)
      return
    }
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

        <Button type="submit" fullWidth isLoading={isSubmitting}>
          <Trans>Send reset link</Trans>
        </Button>
      </div>
    </form>
  )
}

function ResetStep({ token }: ResetStepProps): ReactNode {
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
          setGlobalError(t`This reset link is invalid or has expired. Please request a new one.`)
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
      await handleResetPasswordSuccess({
        refresh,
        navigate: (options) => navigate({ to: options.to as never, replace: options.replace }),
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

function BackToSignIn(): ReactNode {
  return (
    <p {...stylex.props(styles.footerText)}>
      <Link to="/sign-in" {...stylex.props(styles.textLink)}>
        <Trans>Back to sign in</Trans>
      </Link>
    </p>
  )
}

function ForgotPasswordPage(): ReactNode {
  // strict:false -- 本页挂在 /forgot-password 和 /reset-password 两条路径,不绑定单一 route id。
  const search = useSearch({ strict: false }) as { token?: string; organization_id?: string }
  const token = search.token ?? null
  const organizationId = search.organization_id ?? null
  const [requestDone, setRequestDone] = useState(false)

  // 有 token -> reset 流程;否则 -> request 流程。
  const isResetFlow = Boolean(token)

  if (requestDone) {
    return (
      <AuthLayout footer={<BackToSignIn />}>
        <RequestDoneView />
      </AuthLayout>
    )
  }

  return (
    <AuthLayout footer={isResetFlow ? undefined : <BackToSignIn />}>
      {isResetFlow ? (
        <ResetStep token={token as string} />
      ) : (
        <RequestStep organizationId={organizationId} onDone={() => setRequestDone(true)} />
      )}
    </AuthLayout>
  )
}

// TanStack Router lazy 路由:/forgot-password 与 /reset-password 复用。
export const Route = createLazyRoute('/forgot-password')({
  component: ForgotPasswordPage,
})
