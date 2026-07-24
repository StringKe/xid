import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { createLazyRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import * as stylex from '@stylexjs/stylex'
import { AuthLayout } from '../../components/layout'
import { Alert, Button, PageHeader, Spinner } from '../../components/ui'
import { useAuth } from '../../lib/auth-context'
import { trackInvitationAccepted } from '../../lib/google-analytics-funnel'
import { Link } from '../../lib/router'
import { tokens } from '../../styles/tokens.stylex'

type InvitationPreview = {
  status: 'pending' | 'expired' | 'invalid'
  email: string | null
  orgId: string | null
  orgName: string | null
  role: string | null
  expiresAt: string | null
}

const styles = stylex.create({
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
    minWidth: 0,
  },
  meta: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: '0.875rem',
    lineHeight: 1.5,
  },
})

function AcceptInvitationPage(): ReactNode {
  const search = useSearch({ strict: false }) as { token?: string }
  const token = search.token ?? null
  const { api, status, user, refresh } = useAuth()
  const navigate = useNavigate()
  const { t } = useLingui()
  const [acceptError, setAcceptError] = useState<string | null>(null)
  const [accepting, setAccepting] = useState(false)

  const preview = useQuery({
    queryKey: ['invitation-preview', token],
    enabled: token !== null,
    retry: false,
    queryFn: async (): Promise<InvitationPreview> => {
      const result = await api.get<InvitationPreview>(
        `/auth/invitation/preview?token=${encodeURIComponent(token ?? '')}`,
      )
      if (!result.ok) throw result.error
      return result.value
    },
  })

  useEffect(() => {
    if (preview.data?.status === 'pending' && preview.data.email && status === 'unauthenticated') {
      const params = new URLSearchParams({
        login_hint: preview.data.email,
        invitation_token: token ?? '',
        continue: `/accept-invitation?token=${encodeURIComponent(token ?? '')}`,
      })
      void navigate({ to: `/sign-in?${params.toString()}` as never, replace: true })
    }
  }, [navigate, preview.data, status, token])

  async function handleAccept(): Promise<void> {
    if (!token) return
    setAccepting(true)
    setAcceptError(null)
    const result = await api.post<{ redirectUrl: string }>('/auth/invitation/accept', { token })
    setAccepting(false)
    if (!result.ok) {
      setAcceptError(t`Unable to accept this invitation. Please sign in with the invited email.`)
      return
    }
    trackInvitationAccepted()
    await refresh()
    void navigate({ to: result.value.redirectUrl as never, replace: true })
  }

  if (!token) {
    return (
      <AuthLayout>
        <div {...stylex.props(styles.stack)}>
          <PageHeader title={<Trans>Invitation unavailable</Trans>} />
          <Alert tone="error">
            <Trans>Invitation link is invalid.</Trans>
          </Alert>
          <Link to="/sign-in">
            <Trans>Back to sign in</Trans>
          </Link>
        </div>
      </AuthLayout>
    )
  }

  if (preview.isPending) {
    return (
      <AuthLayout>
        <Spinner label={t`Loading invitation`} />
      </AuthLayout>
    )
  }

  const data = preview.data
  if (!data || data.status === 'invalid') {
    return (
      <AuthLayout>
        <div {...stylex.props(styles.stack)}>
          <PageHeader title={<Trans>Invitation unavailable</Trans>} />
          <Alert tone="error">
            <Trans>This invitation link is invalid or has already been used.</Trans>
          </Alert>
          <Link to="/sign-in">
            <Trans>Back to sign in</Trans>
          </Link>
        </div>
      </AuthLayout>
    )
  }

  if (data.status === 'expired') {
    return (
      <AuthLayout>
        <div {...stylex.props(styles.stack)}>
          <PageHeader title={<Trans>Invitation expired</Trans>} />
          <Alert tone="warning">
            <Trans>Ask your organization admin to send a new invitation.</Trans>
          </Alert>
          <Link to="/sign-in">
            <Trans>Back to sign in</Trans>
          </Link>
        </div>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout>
      <div {...stylex.props(styles.stack)}>
        <PageHeader
          title={
            data.orgName ? <Trans>Join {data.orgName}</Trans> : <Trans>Join organization</Trans>
          }
          lead={
            <Trans>
              You have been invited as {data.role ?? 'member'}. Sign in with {data.email} to
              continue.
            </Trans>
          }
        />
        <p {...stylex.props(styles.meta)}>
          <Trans>Invited email: {data.email}</Trans>
        </p>
        {status === 'authenticated' ? (
          <>
            {user?.email && data.email && user.email.toLowerCase() !== data.email.toLowerCase() ? (
              <Alert tone="warning">
                <Trans>
                  You are signed in as {user.email}. Sign out and use {data.email} to accept this
                  invitation.
                </Trans>
              </Alert>
            ) : (
              <Button type="button" onClick={() => void handleAccept()} disabled={accepting}>
                {accepting ? <Trans>Accepting…</Trans> : <Trans>Accept invitation</Trans>}
              </Button>
            )}
          </>
        ) : (
          <p {...stylex.props(styles.meta)}>
            <Trans>Redirecting to sign in…</Trans>
          </p>
        )}
        {acceptError ? <Alert tone="error">{acceptError}</Alert> : null}
        <Link to="/sign-in">
          <Trans>Back to sign in</Trans>
        </Link>
      </div>
    </AuthLayout>
  )
}

export const Route = createLazyRoute('/accept-invitation')({
  component: AcceptInvitationPage,
})
