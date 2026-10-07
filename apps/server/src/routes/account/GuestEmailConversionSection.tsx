// 访客用邮箱验证码原地转正(sub 不变),与 Hosted Auth 走同一组接口:send 把邮箱挂为访客的
// 未验证主邮箱,verify 成功后吊销访客会话并签发正式会话。租户不允许邮箱验证码建号时说明原因。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import type { XidError } from '@xid-kit/types'
import { useNavigate } from '@xid-kit/web-ui/tanstack-router'
import { Alert, Button, Dialog, TextField } from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import { DEFAULT_PUBLIC_AUTH_CONFIG, type PublicHostedAuthConfig } from '../sign-in/auth-config'
import { useTurnstile } from '../sign-in/useTurnstile'

const RETURN_PATH = '/account/security'

function emailOtpCreationAllowed(config: PublicHostedAuthConfig): boolean {
  const emailOtp = config.methods.emailOtp
  return config.allowUserCreation && emailOtp.enabled && emailOtp.allowUserCreation
}

export function GuestAddEmailDialog({ onClose }: { onClose: () => void }): ReactNode {
  const { t } = useLingui()
  const { api, refresh } = useAuth()
  const navigate = useNavigate()
  const apiErrorMessage = useApiErrorMessage()
  const config = useQuery<PublicHostedAuthConfig, never>({
    queryKey: ['auth-config', 'guest-conversion'],
    queryFn: async () => {
      const result = await api.get<PublicHostedAuthConfig>('/auth/config')
      return result.ok ? result.value : DEFAULT_PUBLIC_AUTH_CONFIG
    },
    retry: false,
  })
  const [open, setOpen] = useState(true)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [error, setError] = useState<string | null>(null)
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const siteKey = config.data?.turnstileSiteKey ?? null
  const { containerRef } = useTurnstile(siteKey, turnstileToken, setTurnstileToken)
  const turnstileReady = siteKey === null || Boolean(turnstileToken)
  const allowed = config.data ? emailOtpCreationAllowed(config.data) : true

  function showError(apiError: Pick<XidError, 'code' | 'meta'>): void {
    // 验证码已证明邮箱控制权,提示该邮箱属于另一账户不会向第三方泄露存在性。
    setError(
      apiError.code === 'invalid_credentials'
        ? t`This email address already belongs to another account. Sign out of the guest account, then sign in with that email.`
        : apiErrorMessage(apiError, { surface: 'general' }),
    )
  }

  const send = useMutation({
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

  const verify = useMutation({
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
    setError(null)
    if (step === 'email') {
      if (email.includes('@') && turnstileReady) send.mutate()
      return
    }
    if (code.length === 6) verify.mutate()
  }

  const busy = send.isPending || verify.isPending
  const formId = 'guest-add-email'

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) setOpen(false)
      }}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) onClose()
      }}
      title={step === 'email' ? <Trans>Add an email address</Trans> : <Trans>Check {email}</Trans>}
      description={
        step === 'email' ? (
          <Trans>
            We'll send a 6-digit code to confirm it's yours. After that, you sign in with this email
            and the account stays yours.
          </Trans>
        ) : (
          <Trans>Enter the 6-digit code we just sent. It works for 10 minutes.</Trans>
        )
      }
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            variant="accent"
            type="submit"
            form={formId}
            isLoading={busy}
            disabled={
              !allowed ||
              (step === 'email' ? !email.includes('@') || !turnstileReady : code.length !== 6)
            }
          >
            {step === 'email' ? <Trans>Send code</Trans> : <Trans>Verify email</Trans>}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit} noValidate>
        {step === 'email' ? (
          <TextField
            label={<Trans>Email</Trans>}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoFocus
          />
        ) : (
          <TextField
            label={<Trans>Code</Trans>}
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            autoFocus
          />
        )}
      </form>
      {step === 'email' ? <div ref={containerRef} /> : null}
      {!allowed ? (
        <Alert tone="warning">
          <Trans>
            This organization doesn't let guests add an email. Create a passkey instead.
          </Trans>
        </Alert>
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
    </Dialog>
  )
}
