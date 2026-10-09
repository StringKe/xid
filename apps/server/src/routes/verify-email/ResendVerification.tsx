// 重发验证邮件:已登录按当前账户重发;未登录(注册后链接过期)输入邮箱 + Turnstile,服务端恒 200。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import * as stylex from '@stylexjs/stylex'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { Button, Field, Input, Notice } from '../../components/ui'
import { hosted } from '../../components/hosted/hosted-styles'
import { useAuth } from '../../lib/auth-context'
import { Link } from '@xid-kit/web-ui/tanstack-router'
import { DEFAULT_PUBLIC_AUTH_CONFIG, type PublicHostedAuthConfig } from '../sign-in/auth-config'
import { TurnstileSlot } from '../../components/hosted/TurnstileSlot'
import { useTurnstile } from '../sign-in/useTurnstile'
import { forgotPasswordHref } from '../forgot-password/navigation'

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
  const handle = useTurnstile(siteKey, turnstileToken, setTurnstileToken)
  const ready =
    !enabled || (!configQuery.isPending && (siteKey === null || Boolean(turnstileToken)))
  return { handle, turnstileToken, ready, reset: () => setTurnstileToken(null) }
}

export function ResendVerification(): ReactNode {
  const { t } = useLingui()
  const { api, status } = useAuth()
  const needsEmail = status !== 'authenticated'
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [emailError, setEmailError] = useState<string | null>(null)
  const [requestError, setRequestError] = useState<string | null>(null)
  const apiErrorMessage = useApiErrorMessage()
  const turnstile = useTurnstileGate(needsEmail)

  const resendMutation = useMutation({
    mutationFn: () =>
      api.post(
        '/auth/resend-verification',
        needsEmail ? { email, turnstileToken: turnstile.turnstileToken } : undefined,
      ),
    onSuccess: (result) => {
      // 枚举防护:账户是否存在都返回 200;非 200 只会是限流、人机验证或服务端错误,按错误码提示。
      if (!result.ok) {
        setRequestError(apiErrorMessage(result.error, { surface: 'general' }))
        return
      }
      setSent(true)
    },
    onSettled: turnstile.reset,
  })

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    setEmailError(null)
    setRequestError(null)
    if (needsEmail && !email.includes('@')) {
      setEmailError(t`Enter a valid email address`)
      return
    }
    if (status !== 'loading' && turnstile.ready) resendMutation.mutate()
  }

  if (sent) {
    return (
      <Notice tone="success" title={<Trans>Check your email</Trans>}>
        <Trans>
          If this address has an account, a new link is on its way. Open the newest email.
        </Trans>
      </Notice>
    )
  }

  return (
    <form onSubmit={handleSubmit} noValidate {...stylex.props(hosted.form)}>
      {requestError ? <Notice tone="danger">{requestError}</Notice> : null}
      {needsEmail ? (
        <>
          <Field label={<Trans>Email address</Trans>} error={emailError ?? undefined} required>
            <Input
              type="email"
              inputSize="lg"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t`you@example.com`}
              disabled={resendMutation.isPending}
            />
          </Field>
          <TurnstileSlot turnstile={turnstile.handle} />
        </>
      ) : null}
      <Button
        type="submit"
        variant="accent"
        size="lg"
        fullWidth
        isLoading={resendMutation.isPending}
        disabled={status === 'loading' || !turnstile.ready}
      >
        <Trans>Send a new link</Trans>
      </Button>
      <div {...stylex.props(hosted.linkRow)}>
        <Link to="/sign-in" {...stylex.props(hosted.textLink)}>
          <Trans>Sign in instead</Trans>
        </Link>
        <Link to={forgotPasswordHref({})} {...stylex.props(hosted.quietLink)}>
          <Trans>Forgot password?</Trans>
        </Link>
      </div>
    </form>
  )
}
