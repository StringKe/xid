// 邮箱验证确认页;GET/页面加载永不消费 token,仅显式按钮触发 POST。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { createLazyRoute, useSearch } from '@tanstack/react-router'
import { Link, useNavigate } from '../../lib/router'
import { useMutation } from '@tanstack/react-query'
import type { XidErrorCode } from '@xid-kit/types'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { Alert, Button, PageHeader, Spinner } from '../../components/ui'
import { AuthLayout } from '../../components/layout'
import { useAuth } from '../../lib/auth-context'
import { trackEmailVerified } from '../../lib/google-analytics-funnel'
import { styles as signInStyles } from '../sign-in/styles'
import { useOneTimeLinkToken } from '../../lib/use-one-time-link-token'

type VerifyErrorKind = 'expired' | 'invalid'
type VerifyEmailResult = { ok: true; email?: string; redirectUrl?: string }

function classifyError(code: XidErrorCode): VerifyErrorKind {
  return code === 'token_expired' ? 'expired' : 'invalid'
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

const styles = stylex.create({
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
    minWidth: 0,
  },
  pendingRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
  },
  pendingLabel: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.6875rem',
    fontWeight: 500,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: tokens['--xid-muted-foreground'],
  },
  resendPanel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  resendActions: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    alignItems: 'flex-start',
  },
})

function VerifyEmailPage(): ReactNode {
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

  const errorKind: VerifyErrorKind | null =
    verification.error && typeof verification.error === 'object' && 'code' in verification.error
      ? classifyError((verification.error as { code: XidErrorCode }).code)
      : verification.error
        ? 'invalid'
        : null

  return (
    <AuthLayout>
      <div {...stylex.props(styles.stack)}>
        <PageHeader
          title={
            ready && token !== null && verification.isIdle ? (
              <Trans>Confirm your email</Trans>
            ) : (
              <Trans>Verify your email</Trans>
            )
          }
          lead={
            ready && token !== null && verification.isIdle ? (
              <Trans>
                Continue only if you opened this link from the verification email sent to you.
              </Trans>
            ) : undefined
          }
        />

        {!ready ? (
          <div {...stylex.props(styles.pendingRow)} aria-live="polite">
            <Spinner size={16} />
            <span {...stylex.props(styles.pendingLabel)}>
              <Trans>Preparing verification...</Trans>
            </span>
          </div>
        ) : null}

        {ready && token === null && !verification.isSuccess ? (
          <>
            <Alert tone="error">
              <Trans>No verification token found. Please use the link from your email.</Trans>
            </Alert>
            <ResendLink />
          </>
        ) : null}

        {ready && token !== null && verification.isIdle ? (
          <Button type="button" fullWidth onClick={() => verification.mutate()}>
            <Trans>Confirm email address</Trans>
          </Button>
        ) : null}

        {verification.isPending ? (
          <div {...stylex.props(styles.pendingRow)} aria-live="polite">
            <Spinner size={16} />
            <span {...stylex.props(styles.pendingLabel)}>
              <Trans>Verifying your email address...</Trans>
            </span>
          </div>
        ) : null}

        {verification.isSuccess ? (
          <Alert tone="success">
            <Trans>Your email has been verified. Redirecting you to sign in...</Trans>
          </Alert>
        ) : null}

        {errorKind === 'expired' ? (
          <>
            <Alert tone="error">
              <Trans>This verification link has expired. Please request a new one.</Trans>
            </Alert>
            <ResendLink />
          </>
        ) : null}

        {errorKind === 'invalid' ? (
          <>
            <Alert tone="error">
              <Trans>This verification link is invalid or has already been used.</Trans>
            </Alert>
            <ResendLink />
          </>
        ) : null}
      </div>
    </AuthLayout>
  )
}

function ResendLink(): ReactNode {
  const { t } = useLingui()
  const { api } = useAuth()
  const [sent, setSent] = useState(false)

  const resendMutation = useMutation({
    mutationFn: () => api.post('/auth/resend-verification'),
    onSuccess: (result) => {
      if (!result.ok) {
        if (result.error.code !== 'rate_limited') {
          setSent(true)
          return
        }
        // rate_limited 不设 sent,走 isError 展示。
        return
      }
      setSent(true)
    },
  })

  if (sent) {
    return (
      <Alert tone="success">
        <Trans>A new verification email has been sent if your account exists.</Trans>
      </Alert>
    )
  }

  return (
    <div {...stylex.props(styles.resendPanel)}>
      {resendMutation.isSuccess &&
      !resendMutation.data?.ok &&
      resendMutation.data?.error?.code === 'rate_limited' ? (
        <Alert tone="error">
          {t`Too many requests. Please wait a minute before trying again.`}
        </Alert>
      ) : null}
      <div {...stylex.props(styles.resendActions)}>
        <Button
          variant="secondary"
          isLoading={resendMutation.isPending}
          onClick={() => void resendMutation.mutate()}
        >
          <Trans>Resend verification email</Trans>
        </Button>
        <Link to="/sign-in" {...stylex.props(signInStyles.textLink)}>
          <Trans>Back to sign in</Trans>
        </Link>
      </div>
    </div>
  )
}

export const Route = createLazyRoute('/verify-email')({
  component: VerifyEmailPage,
})
