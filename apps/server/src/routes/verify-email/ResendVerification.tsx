// 重发验证邮件:已登录按当前账户重发;未登录(注册后链接过期)输入邮箱 + Turnstile,服务端恒 200。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, Field, Input } from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import { Link } from '../../lib/router'
import { styles as signInStyles } from '../sign-in/styles'
import { DEFAULT_PUBLIC_AUTH_CONFIG, type PublicHostedAuthConfig } from '../sign-in/auth-config'
import { useTurnstile } from '../sign-in/useTurnstile'
import { forgotPasswordHref } from '../forgot-password/navigation'

const styles = stylex.create({
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  actions: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    alignItems: 'flex-start',
  },
  turnstile: {
    display: 'flex',
    justifyContent: 'center',
    width: '100%',
  },
})

function useTurnstileGate(enabled: boolean) {
  const { api } = useAuth()
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const configQuery = useQuery<PublicHostedAuthConfig, never>({
    queryKey: ['auth-config', 'resend-verification'],
    queryFn: async () => {
      const result = await api.get<PublicHostedAuthConfig>('/auth/config')
      return result.ok ? result.value : DEFAULT_PUBLIC_AUTH_CONFIG
    },
    enabled,
    retry: false,
  })
  const siteKey = enabled ? (configQuery.data ?? DEFAULT_PUBLIC_AUTH_CONFIG).turnstileSiteKey : null
  const { containerRef } = useTurnstile(siteKey, turnstileToken, setTurnstileToken)
  const ready =
    !enabled || (!configQuery.isPending && (siteKey === null || Boolean(turnstileToken)))
  return { containerRef, turnstileToken, ready, reset: () => setTurnstileToken(null) }
}

export function ResendVerification(): ReactNode {
  const { t } = useLingui()
  const { api, status } = useAuth()
  const needsEmail = status === 'unauthenticated'
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [emailError, setEmailError] = useState<string | null>(null)
  const turnstile = useTurnstileGate(needsEmail)

  const resendMutation = useMutation({
    mutationFn: () =>
      api.post(
        '/auth/resend-verification',
        needsEmail ? { email, turnstileToken: turnstile.turnstileToken } : undefined,
      ),
    onSuccess: (result) => {
      // 枚举防护:服务端恒 200;只有限流需要单独提示。
      if (!result.ok && result.error.code === 'rate_limited') return
      setSent(true)
    },
    onSettled: turnstile.reset,
  })

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    setEmailError(null)
    if (needsEmail && !email.includes('@')) {
      setEmailError(t`Enter a valid email address`)
      return
    }
    if (turnstile.ready) resendMutation.mutate()
  }

  if (sent) {
    return (
      <Alert tone="success">
        <Trans>A new verification email has been sent if your account exists.</Trans>
      </Alert>
    )
  }

  const rateLimited =
    resendMutation.isSuccess &&
    !resendMutation.data?.ok &&
    resendMutation.data?.error?.code === 'rate_limited'

  return (
    <form onSubmit={handleSubmit} noValidate {...stylex.props(styles.panel)}>
      {rateLimited ? (
        <Alert tone="error">{t`Too many requests. Please wait a minute before trying again.`}</Alert>
      ) : null}
      {needsEmail ? (
        <>
          <Field label={<Trans>Email address</Trans>} error={emailError ?? undefined} required>
            <Input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t`you@example.com`}
              disabled={resendMutation.isPending}
            />
          </Field>
          <div ref={turnstile.containerRef} {...stylex.props(styles.turnstile)} />
        </>
      ) : null}
      <div {...stylex.props(styles.actions)}>
        <Button
          type="submit"
          variant="secondary"
          isLoading={resendMutation.isPending}
          disabled={!turnstile.ready}
        >
          <Trans>Resend verification email</Trans>
        </Button>
        <a href={forgotPasswordHref({})} {...stylex.props(signInStyles.textLink)}>
          <Trans>Forgot password?</Trans>
        </a>
        <Link to="/sign-in" {...stylex.props(signInStyles.textLink)}>
          <Trans>Back to sign in</Trans>
        </Link>
      </div>
    </form>
  )
}
