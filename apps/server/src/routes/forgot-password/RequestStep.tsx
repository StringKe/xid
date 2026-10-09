// 找回密码请求步骤:提交邮箱后无论账户是否存在都显示"已发送"。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import * as stylex from '@stylexjs/stylex'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { Button, Field, Input, Notice } from '../../components/ui'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { hosted } from '../../components/hosted/hosted-styles'
import { useAuth } from '../../lib/auth-context'
import { trackPasswordResetRequest } from '../../lib/google-analytics-funnel'
import { DEFAULT_PUBLIC_AUTH_CONFIG, type PublicHostedAuthConfig } from '../sign-in/auth-config'
import { TurnstileSlot } from '../../components/hosted/TurnstileSlot'
import { turnstileGate, turnstilePasses } from '../sign-in/turnstile-gate'
import { useTurnstile } from '../sign-in/useTurnstile'
import { buildSignInFlowFields } from '../sign-in/sign-in-flow'
import { maskEmail } from '../sign-in/identifier-mask'
import type { PasswordRecoverySearch } from './navigation'

type RequestStepProps = {
  search: PasswordRecoverySearch
  onDone: (email: string) => void
}

export function RequestStep({ search, onDone }: RequestStepProps): ReactNode {
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
  const turnstile = useTurnstile(authConfig.turnstileSiteKey, turnstileToken, setTurnstileToken)
  const turnstileReady = turnstilePasses(
    turnstileGate({
      configSettled: !authConfigQuery.isPending,
      siteKey: authConfig.turnstileSiteKey,
      token: turnstileToken,
      needsInteraction: turnstile.needsInteraction,
    }),
  )

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
        <TurnstileSlot turnstile={turnstile} />
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

export function RequestDoneView({ email }: { email: string }): ReactNode {
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
