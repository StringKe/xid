// 邮箱验证确认页;GET/页面加载永不消费 token,仅显式按钮触发 POST。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { createLazyRoute, useSearch } from '@tanstack/react-router'
import { useNavigate } from '@xid-kit/web-ui/tanstack-router'
import { useMutation } from '@tanstack/react-query'
import * as stylex from '@stylexjs/stylex'
import { page } from '../../styles/product-surface.stylex'
import { Badge, Button, Spinner } from '../../components/ui'
import { AuthLayout } from '../../components/layout'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { hosted } from '../../components/hosted/hosted-styles'
import { useAuth } from '../../lib/auth-context'
import { trackEmailVerified } from '../../lib/google-analytics-funnel'
import { useOneTimeLinkToken } from '../../lib/use-one-time-link-token'
import { classifyOneTimeLinkError, type OneTimeLinkErrorKind } from '../../lib/one-time-link-error'
import { ResendVerification } from './ResendVerification'

type VerifyEmailResult = { ok: true; email?: string; redirectUrl?: string }

const VERIFY_EMAIL_TERMINAL_CODES = {
  expired: 'token_expired',
  invalid: 'token_invalid',
} as const

function continuesToPasswordSetup(redirectUrl: string | undefined): boolean {
  return redirectUrl?.startsWith('/reset-password') ?? false
}

// 回 sign-in 附 verified=1 + login_hint,供成功 Alert 与预填。
function withVerifiedHint(target: string, email: string | undefined): string {
  if (target !== '/sign-in' && !target.startsWith('/sign-in?')) return target
  const [path, query] = target.split('?')
  const params = new URLSearchParams(query ?? '')
  params.set('verified', '1')
  if (email) params.set('login_hint', email)
  return `${path}?${params.toString()}`
}

function VerifyEmailPage(): ReactNode {
  const { t } = useLingui()
  const search = useSearch({ strict: false }) as { token?: string }
  const { token, ready, clearToken } = useOneTimeLinkToken({
    storageKey: 'xid.verify-email.token',
    legacyQueryToken: search.token ?? null,
  })
  const { api, refresh } = useAuth()
  const navigate = useNavigate()

  const verification = useMutation({
    mutationFn: async (): Promise<VerifyEmailResult | never> => {
      if (!token) throw new Error('missing verification token')
      const result = await api.post<VerifyEmailResult>('/auth/verify-email', { token })
      if (!result.ok) throw result.error
      trackEmailVerified()
      await refresh()
      clearToken()
      return result.value
    },
    onError: (error) => {
      if (classifyOneTimeLinkError(error, VERIFY_EMAIL_TERMINAL_CODES) !== 'retryable') clearToken()
    },
  })

  // 短暂停留再跳转,让用户看到成功提示。
  useEffect(() => {
    if (!verification.isSuccess) return
    const redirectUrl = verification.data.redirectUrl
    const target =
      redirectUrl?.startsWith('/') && !redirectUrl.startsWith('//') ? redirectUrl : '/sign-in'
    const timer = globalThis.setTimeout(
      () => navigate(withVerifiedHint(target, verification.data.email), { replace: true }),
      2000,
    )
    return () => globalThis.clearTimeout(timer)
  }, [navigate, verification.data?.email, verification.data?.redirectUrl, verification.isSuccess])

  const errorKind: OneTimeLinkErrorKind | null = verification.error
    ? classifyOneTimeLinkError(verification.error, VERIFY_EMAIL_TERMINAL_CODES)
    : null

  function content(): ReactNode {
    if (!ready || verification.isPending) {
      return (
        <div {...stylex.props(page.loadingCenter)} aria-live="polite">
          <Spinner
            label={
              verification.isPending ? t`Confirming your email address` : t`Preparing verification`
            }
          />
        </div>
      )
    }
    if (verification.isSuccess) {
      const email = verification.data.email
      return (
        <div {...stylex.props(hosted.screen)} aria-live="polite">
          <AuthHeading
            above={
              <Badge tone="success">
                <Trans>Verified</Trans>
              </Badge>
            }
            title={
              email ? <Trans>{email} is verified</Trans> : <Trans>Your email is verified</Trans>
            }
            lead={
              continuesToPasswordSetup(verification.data.redirectUrl) ? (
                <Trans>Next, set your password.</Trans>
              ) : (
                <Trans>Taking you back to sign in.</Trans>
              )
            }
          />
        </div>
      )
    }
    if (errorKind && errorKind !== 'retryable') {
      return (
        <div {...stylex.props(hosted.screen)}>
          <AuthHeading
            above={
              <Badge tone="warning">
                <Trans>Link expired</Trans>
              </Badge>
            }
            title={<Trans>This link has expired or was already used</Trans>}
            lead={
              <Trans>
                Verification links work once, for 15 minutes. Send a new one and open the newest
                email.
              </Trans>
            }
          />
          <ResendVerification />
        </div>
      )
    }
    if (token === null) {
      return (
        <div {...stylex.props(hosted.screen)}>
          <AuthHeading
            title={<Trans>Verify your email</Trans>}
            lead={
              <Trans>
                Open the link from your verification email on this device, or send a new one.
              </Trans>
            }
          />
          <ResendVerification />
        </div>
      )
    }
    return (
      <div {...stylex.props(hosted.screen)}>
        <AuthHeading
          title={<Trans>Confirm your email</Trans>}
          lead={
            <Trans>
              Continue only if you opened this link from the verification email sent to you.
            </Trans>
          }
        />
        {errorKind === 'retryable' ? (
          <p {...stylex.props(hosted.note)}>
            <Trans>Something went wrong. Try again.</Trans>
          </p>
        ) : null}
        <Button variant="accent" size="lg" fullWidth onClick={() => verification.mutate()}>
          {errorKind === 'retryable' ? (
            <Trans>Try again</Trans>
          ) : (
            <Trans>Confirm email address</Trans>
          )}
        </Button>
      </div>
    )
  }

  return (
    <AuthLayout
      context={{
        lead: t`Your account`,
        title: t`Verify your email`,
        description: t`Verification links are single-use and short-lived so nobody else can confirm an address that isn't theirs.`,
      }}
    >
      {content()}
    </AuthLayout>
  )
}

export const Route = createLazyRoute('/verify-email')({
  component: VerifyEmailPage,
})
