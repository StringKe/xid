// 邮箱验证回调页(TanStack Router + Query)。
// 从 URL ?token= 取验证 token -> POST /auth/verify-email。token 有效期由 server 控制
// (magic link HMAC-SHA256 签名 JWT,15min,jti 一次性)。
// useQuery:token 作 queryKey 自动去重,isPending/isSuccess/error 驱动 UI。
// ResendLink 用 useMutation。视觉语言对齐 sign-in:1.25rem stack、hairline 层次、textLink 处理。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { createLazyRoute, useSearch } from '@tanstack/react-router'
import { Link, useNavigate } from '../../lib/router'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { XidErrorCode } from '@xid-kit/types'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '../../styles/tokens.stylex'
import { Alert, Button, PageHeader, Spinner } from '../../components/ui'
import { AuthLayout } from '../../components/layout'
import { useAuth } from '../../lib/auth-context'
import { trackEmailVerified } from '../../lib/google-analytics-funnel'
import { styles as signInStyles } from '../sign-in/styles'

// 验证失败原因(映射到本地化文案)。
type VerifyErrorKind = 'expired' | 'invalid'
type VerifyEmailResult = { ok: true; email?: string; redirectUrl?: string }

function classifyError(code: XidErrorCode): VerifyErrorKind {
  return code === 'token_expired' ? 'expired' : 'invalid'
}

// sign-in 跳转附带 verified=1 + login_hint:SignInPage 显示验证成功 Alert 并预填 identifier。
function withVerifiedHint(target: string, email: string | undefined): string {
  if (target !== '/sign-in' && !target.startsWith('/sign-in?')) return target
  const [path, query] = target.split('?')
  const params = new URLSearchParams(query ?? '')
  params.set('verified', '1')
  if (email) params.set('login_hint', email)
  return `${path}?${params.toString()}`
}

const styles = stylex.create({
  // 卡片内主栈:对齐 sign-in 密度(1.25rem)。
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
    minWidth: 0,
  },
  // 验证中等待行:mono microlabel 文案 + spinner 同行。
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
  // 重发区:gap 1rem 对齐 panel 密度。
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
  // strict:false -- TanStack lazy route 不绑定单一 route id。
  const search = useSearch({ strict: false }) as { token?: string }
  const token = search.token ?? null
  const { api, refresh } = useAuth()
  const navigate = useNavigate()

  // 验证调用:token 作 queryKey 自动去重,免 StrictMode 双调用 guard;失败不重试(token 一次性)。
  const verification = useQuery({
    queryKey: ['verify-email', token],
    enabled: token !== null,
    retry: false,
    queryFn: async (): Promise<VerifyEmailResult | never> => {
      const result = await api.post<VerifyEmailResult>('/auth/verify-email', { token })
      if (!result.ok) throw result.error
      // server 可能已将 emailVerified 置 true,刷新本地 session 视图。
      trackEmailVerified()
      await refresh()
      return result.value
    },
  })

  // 验证成功后短暂停留再跳转,让用户看到成功提示。
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
        <PageHeader title={<Trans>Verify your email</Trans>} />

        {token === null ? (
          <>
            <Alert tone="error">
              <Trans>No verification token found. Please use the link from your email.</Trans>
            </Alert>
            <ResendLink />
          </>
        ) : null}

        {token !== null && verification.isPending ? (
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
          // 枚举防护:不区分邮箱存在与否,rate_limited 直接在 isError 展示。
          setSent(true)
          return
        }
        // rate_limited 不设 sent,让 isError 显示提示。
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
