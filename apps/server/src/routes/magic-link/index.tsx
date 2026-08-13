import { Trans } from '@lingui/react/macro'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { createLazyRoute, useSearch } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import type { XidErrorCode } from '@xid-kit/types'
import * as stylex from '@stylexjs/stylex'
import { AuthLayout } from '../../components/layout'
import { Alert, Button, PageHeader, Spinner } from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import { Link, useNavigate } from '../../lib/router'
import { useOneTimeLinkToken } from '../../lib/use-one-time-link-token'
import { styles as signInStyles } from '../sign-in/styles'
import { tokens } from '../../styles/tokens.stylex'

type MagicLinkResult = { redirectUrl: string }
type MagicLinkErrorKind = 'expired' | 'invalid'

function classifyError(code: XidErrorCode): MagicLinkErrorKind {
  return code === 'magic_link_expired' ? 'expired' : 'invalid'
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
})

export function MagicLinkPage(): ReactNode {
  const search = useSearch({ strict: false }) as { token?: string }
  const { token, ready, clearToken } = useOneTimeLinkToken({
    storageKey: 'xid.magic-link.token',
    legacyQueryToken: search.token ?? null,
  })
  const { api, refresh } = useAuth()
  const navigate = useNavigate()

  const verification = useMutation({
    mutationFn: async (): Promise<MagicLinkResult> => {
      if (!token) throw new Error('missing magic-link token')
      const result = await api.post<MagicLinkResult>('/auth/magic-link/verify', { token })
      if (!result.ok) throw result.error
      await refresh()
      clearToken()
      return result.value
    },
  })

  useEffect(() => {
    if (!verification.isSuccess) return
    const target =
      verification.data.redirectUrl.startsWith('/') &&
      !verification.data.redirectUrl.startsWith('//')
        ? verification.data.redirectUrl
        : '/console'
    const timer = globalThis.setTimeout(() => navigate(target, { replace: true }), 1200)
    return () => globalThis.clearTimeout(timer)
  }, [navigate, verification.data?.redirectUrl, verification.isSuccess])

  const errorKind: MagicLinkErrorKind | null =
    verification.error && typeof verification.error === 'object' && 'code' in verification.error
      ? classifyError((verification.error as { code: XidErrorCode }).code)
      : verification.error
        ? 'invalid'
        : null

  const confirmReady = ready && token !== null && verification.isIdle

  return (
    <AuthLayout>
      <div {...stylex.props(styles.stack)}>
        <PageHeader
          title={confirmReady ? <Trans>Confirm sign in</Trans> : <Trans>Magic link sign in</Trans>}
          lead={
            confirmReady ? (
              <Trans>Continue only if you requested this sign-in link.</Trans>
            ) : undefined
          }
        />

        {!ready ? (
          <div {...stylex.props(styles.pendingRow)} aria-live="polite">
            <Spinner size={16} />
            <span {...stylex.props(styles.pendingLabel)}>
              <Trans>Preparing sign in...</Trans>
            </span>
          </div>
        ) : null}

        {ready && token === null && !verification.isSuccess ? (
          <Alert tone="error">
            <Trans>No magic-link token found. Please use the link from your email.</Trans>
          </Alert>
        ) : null}

        {confirmReady ? (
          <Button type="button" fullWidth onClick={() => verification.mutate()}>
            <Trans>Continue to sign in</Trans>
          </Button>
        ) : null}

        {verification.isPending ? (
          <div {...stylex.props(styles.pendingRow)} aria-live="polite">
            <Spinner size={16} />
            <span {...stylex.props(styles.pendingLabel)}>
              <Trans>Signing you in...</Trans>
            </span>
          </div>
        ) : null}

        {verification.isSuccess ? (
          <Alert tone="success">
            <Trans>Sign-in confirmed. Redirecting...</Trans>
          </Alert>
        ) : null}

        {errorKind === 'expired' ? (
          <Alert tone="error">
            <Trans>This magic link has expired. Request a new link to continue.</Trans>
          </Alert>
        ) : null}

        {errorKind === 'invalid' ? (
          <Alert tone="error">
            <Trans>This magic link is invalid or has already been used.</Trans>
          </Alert>
        ) : null}

        {ready && !verification.isPending && !verification.isSuccess ? (
          <Link to="/sign-in" {...stylex.props(signInStyles.textLink)}>
            <Trans>Back to sign in</Trans>
          </Link>
        ) : null}
      </div>
    </AuthLayout>
  )
}

export const Route = createLazyRoute('/magic-link')({
  component: MagicLinkPage,
})
