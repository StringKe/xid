// 邮件登录链接:GET 只打开本页,点按钮后才 POST 消费令牌,邮件扫描器不会把链接用掉。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { createLazyRoute, useSearch } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import * as stylex from '@stylexjs/stylex'
import { AuthLayout } from '../../components/layout'
import { Badge, Button, Spinner } from '../../components/ui'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { hosted } from '../../components/hosted/hosted-styles'
import { useHostedAuthConfig } from '../../components/hosted/use-hosted-auth-config'
import { useAuth } from '../../lib/auth-context'
import { page } from '../../styles/product-surface.stylex'
import { Link, useNavigate } from '@xid-kit/web-ui/tanstack-router'
import { useOneTimeLinkToken } from '../../lib/use-one-time-link-token'
import { classifyOneTimeLinkError, type OneTimeLinkErrorKind } from '../../lib/one-time-link-error'

type MagicLinkResult = { redirectUrl: string }

const MAGIC_LINK_TERMINAL_CODES = {
  expired: 'magic_link_expired',
  invalid: 'magic_link_invalid',
} as const

// 成功后留一点时间读到结果,再续跑原落点。
const REDIRECT_DELAY_MS = 1200

function BackToSignIn(): ReactNode {
  return (
    <Link to="/sign-in" {...stylex.props(hosted.textLink)}>
      <Trans>Back to sign in</Trans>
    </Link>
  )
}

function LinkProblem({ kind }: { kind: OneTimeLinkErrorKind | 'missing' }): ReactNode {
  const title =
    kind === 'unavailable' ? (
      <Trans>This link can't sign in this account</Trans>
    ) : kind === 'missing' ? (
      <Trans>This page needs the link from your email</Trans>
    ) : (
      <Trans>This link has expired or was already used</Trans>
    )
  const lead =
    kind === 'unavailable' ? (
      <Trans>Go back to sign in and choose another way to continue.</Trans>
    ) : kind === 'missing' ? (
      <Trans>Open the sign-in link from your newest email on this device.</Trans>
    ) : (
      <Trans>Sign-in links work once, for 15 minutes. Go back to sign in and send a new one.</Trans>
    )
  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        above={
          kind === 'expired' || kind === 'invalid' ? (
            <Badge tone="warning">
              <Trans>Link expired</Trans>
            </Badge>
          ) : undefined
        }
        title={title}
        lead={lead}
      />
      <BackToSignIn />
    </div>
  )
}

export function MagicLinkPage(): ReactNode {
  const search = useSearch({ strict: false }) as { token?: string }
  const { token, ready, clearToken } = useOneTimeLinkToken({
    storageKey: 'xid.magic-link.token',
    legacyQueryToken: search.token ?? null,
  })
  const { t } = useLingui()
  const { api, refresh, user } = useAuth()
  const navigate = useNavigate()
  const { config } = useHostedAuthConfig()
  const app = config.context.applicationName

  const verification = useMutation({
    mutationFn: async (): Promise<MagicLinkResult> => {
      if (!token) throw new Error('missing magic-link token')
      const result = await api.post<MagicLinkResult>('/auth/magic-link/verify', { token })
      if (!result.ok) throw result.error
      await refresh()
      clearToken()
      return result.value
    },
    onError: (error) => {
      if (classifyOneTimeLinkError(error, MAGIC_LINK_TERMINAL_CODES) !== 'retryable') clearToken()
    },
  })

  const target = verification.data?.redirectUrl
  useEffect(() => {
    if (!target) return
    const timer = globalThis.setTimeout(
      () => navigate(target, { replace: true }),
      REDIRECT_DELAY_MS,
    )
    return () => globalThis.clearTimeout(timer)
  }, [navigate, target])

  const errorKind: OneTimeLinkErrorKind | null = verification.error
    ? classifyOneTimeLinkError(verification.error, MAGIC_LINK_TERMINAL_CODES)
    : null

  function content(): ReactNode {
    if (!ready || verification.isPending) {
      return (
        <div {...stylex.props(page.loadingCenter)} aria-live="polite">
          <Spinner label={verification.isPending ? t`Signing you in` : t`Preparing sign in`} />
        </div>
      )
    }
    if (target) {
      return (
        <div {...stylex.props(hosted.screen)} aria-live="polite">
          <AuthHeading
            above={
              <Badge tone="success">
                <Trans>Signed in</Trans>
              </Badge>
            }
            title={<Trans>You're signed in with your email link</Trans>}
            lead={
              user?.email ? (
                <Trans>
                  Signed in as {user.email} on this browser. The link can't be used again.
                </Trans>
              ) : (
                <Trans>You're signed in on this browser. The link can't be used again.</Trans>
              )
            }
          />
          <Button
            variant="accent"
            size="lg"
            fullWidth
            onClick={() => navigate(target, { replace: true })}
          >
            {app ? <Trans>Continue to {app}</Trans> : <Trans>Continue</Trans>}
          </Button>
        </div>
      )
    }
    if (errorKind && errorKind !== 'retryable') return <LinkProblem kind={errorKind} />
    if (token === null) return <LinkProblem kind="missing" />
    return (
      <div {...stylex.props(hosted.screen)}>
        <AuthHeading
          title={<Trans>Confirm sign in</Trans>}
          lead={<Trans>Continue only if you asked for this sign-in link.</Trans>}
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
            <Trans>Continue to sign in</Trans>
          )}
        </Button>
        <BackToSignIn />
      </div>
    )
  }

  return <AuthLayout>{content()}</AuthLayout>
}

export const Route = createLazyRoute('/magic-link')({
  component: MagicLinkPage,
})
