// guest 用 email OTP 原地转正(sub 不变):send 把邮箱挂为 guest 的未验证主邮箱,verify 成功后
// 吊销 guest session 并签发正式 session。只有租户允许 email OTP 建号时才显示。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import * as stylex from '@stylexjs/stylex'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import type { XidError } from '@xid-kit/types'
import { Alert, Button, Field, Input, Section, SectionRow } from '../../components/ui'
import { isGuestUser, useAuth } from '../../lib/auth-context'
import { useNavigate } from '../../lib/router'
import { DEFAULT_PUBLIC_AUTH_CONFIG, type PublicHostedAuthConfig } from '../sign-in/auth-config'
import { useTurnstile } from '../sign-in/useTurnstile'

const RETURN_PATH = '/account/security'

const styles = stylex.create({
  footer: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    paddingBlockStart: '1.25rem',
    paddingBlockEnd: '0.875rem',
  },
  submit: {
    alignSelf: 'flex-start',
  },
})

function emailOtpCreationAllowed(config: PublicHostedAuthConfig): boolean {
  const emailOtp = config.methods.emailOtp
  return config.allowUserCreation && emailOtp.enabled && emailOtp.allowUserCreation
}

export function GuestEmailConversionSection(): ReactNode {
  const { api, user } = useAuth()
  const configQuery = useQuery<PublicHostedAuthConfig, never>({
    queryKey: ['auth-config', 'guest-conversion'],
    queryFn: async () => {
      const result = await api.get<PublicHostedAuthConfig>('/auth/config')
      return result.ok ? result.value : DEFAULT_PUBLIC_AUTH_CONFIG
    },
    enabled: isGuestUser(user),
    retry: false,
  })
  if (!isGuestUser(user) || !configQuery.data || !emailOtpCreationAllowed(configQuery.data)) {
    return null
  }
  return <GuestEmailConversionForm turnstileSiteKey={configQuery.data.turnstileSiteKey} />
}

function GuestEmailConversionForm({
  turnstileSiteKey,
}: {
  turnstileSiteKey: string | null
}): ReactNode {
  const { t } = useLingui()
  const { api, refresh } = useAuth()
  const navigate = useNavigate()
  const apiErrorMessage = useApiErrorMessage()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const { containerRef } = useTurnstile(turnstileSiteKey, turnstileToken, setTurnstileToken)
  const turnstileReady = turnstileSiteKey === null || Boolean(turnstileToken)

  function showError(error: Pick<XidError, 'code' | 'meta'>): void {
    // 验证码已证明邮箱控制权,这里提示该邮箱属于另一账户不会向第三方泄露存在性。
    setErrorMsg(
      error.code === 'invalid_credentials'
        ? t`This email address already belongs to another account. Sign out of the guest account, then sign in with that email.`
        : apiErrorMessage(error, { surface: 'general' }),
    )
  }

  const sendMutation = useMutation({
    mutationFn: () =>
      api.post('/auth/otp/email/send', { email, continue: RETURN_PATH, turnstileToken }),
    onSuccess: (result) => {
      if (!result.ok) {
        showError(result.error)
        return
      }
      setStep('code')
    },
    onSettled: () => setTurnstileToken(null),
  })

  const verifyMutation = useMutation({
    mutationFn: () =>
      api.post<{ redirectUrl?: string }>('/auth/otp/email/verify', {
        email,
        code,
        continue: RETURN_PATH,
      }),
    onSuccess: async (result) => {
      if (!result.ok) {
        showError(result.error)
        return
      }
      await refresh()
      navigate(result.value.redirectUrl ?? RETURN_PATH, { replace: true })
    },
  })

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    setErrorMsg(null)
    if (step === 'email') {
      if (email.includes('@') && turnstileReady) sendMutation.mutate()
      return
    }
    if (code.length === 6) verifyMutation.mutate()
  }

  return (
    <Section label={<Trans>Add an email address</Trans>}>
      <form onSubmit={handleSubmit} noValidate>
        <SectionRow variant="control" label={<Trans>Email address</Trans>}>
          <Field required>
            <Input
              type="email"
              aria-label={t`Email address`}
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={step === 'code'}
            />
          </Field>
        </SectionRow>
        {step === 'code' ? (
          <SectionRow variant="control" label={<Trans>Verification code</Trans>}>
            <Field required>
              <Input
                inputMode="numeric"
                aria-label={t`Verification code`}
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              />
            </Field>
          </SectionRow>
        ) : null}
        <div {...stylex.props(styles.footer)}>
          <Alert tone="info">
            <Trans>
              Verify an email address to keep this account and its data after you sign out.
            </Trans>
          </Alert>
          {errorMsg ? <Alert tone="error">{errorMsg}</Alert> : null}
          {step === 'email' ? <div ref={containerRef} /> : null}
          <Button
            type="submit"
            variant="primary"
            isLoading={sendMutation.isPending || verifyMutation.isPending}
            disabled={
              step === 'email' ? !email.includes('@') || !turnstileReady : code.length !== 6
            }
            {...stylex.props(styles.submit)}
          >
            {step === 'email' ? <Trans>Send code</Trans> : <Trans>Verify email</Trans>}
          </Button>
        </div>
      </form>
    </Section>
  )
}
