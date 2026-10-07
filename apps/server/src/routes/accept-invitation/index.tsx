import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createLazyRoute, useSearch } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import * as stylex from '@stylexjs/stylex'
import { AuthLayout, type AuthContextCopy } from '../../components/layout'
import { Button, Notice, Spinner } from '../../components/ui'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { AccountChip } from '../../components/hosted/IdentityChip'
import { hosted } from '../../components/hosted/hosted-styles'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { useAuth } from '../../lib/auth-context'
import { trackInvitationAccepted } from '../../lib/google-analytics-funnel'
import { Link } from '@xid-kit/web-ui/tanstack-router'
import { page } from '../../styles/product-surface.stylex'
import { DEFAULT_PUBLIC_AUTH_CONFIG, type PublicHostedAuthConfig } from '../sign-in/auth-config'
import { useTurnstile } from '../sign-in/useTurnstile'
import {
  claimTokenFromFragment,
  clearClaimStorage,
  clearCurrentClaimStorage,
  getOrCreateRecovery,
  readStoredClaimToken,
  rememberClaimToken,
  scrubFragment,
  type ClaimRecovery,
} from './claim-storage'
import {
  CheckEmailView,
  ClaimConfirmView,
  InvitationDetails,
  InvitationProblem,
  type InvitationPreview,
} from './InvitationViews'

type InvitationPageStatus =
  | 'loading'
  | 'claim-confirm'
  | 'missing-token'
  | 'invalid'
  | 'expired'
  | 'check-email'
  | 'preview'

const styles = stylex.create({
  turnstile: {
    display: { default: 'flex', ':empty': 'none' },
    justifyContent: 'center',
    width: '100%',
  },
})

export const invitationNavigation = {
  assign(redirectUrl: string): void {
    globalThis.location.assign(redirectUrl)
  },
}

function useInvitationContext(data: InvitationPreview | undefined): AuthContextCopy | undefined {
  const { t } = useLingui()
  if (!data?.orgName) return undefined
  return {
    lead: t`You're invited to join`,
    title: data.orgName,
    description: data.email
      ? t`This invitation was sent to ${data.email}. Only that account can accept it.`
      : undefined,
  }
}

export function AcceptInvitationPage(): ReactNode {
  const search = useSearch({ strict: false }) as { token?: string }
  const rawToken = search.token?.trim() || null
  const { api, signOut, user } = useAuth()
  const { t } = useLingui()
  const [fragmentReady, setFragmentReady] = useState(false)
  const [claimToken, setClaimToken] = useState<string | null>(
    () => claimTokenFromFragment() ?? (rawToken ? null : readStoredClaimToken()),
  )
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const [claimStartPending, setClaimStartPending] = useState(false)
  const [claimStartComplete, setClaimStartComplete] = useState(false)
  const [claimStartError, setClaimStartError] = useState<string | null>(null)
  const [claimVerifyPending, setClaimVerifyPending] = useState(false)
  const [claimVerifyError, setClaimVerifyError] = useState<string | null>(null)
  const [claimNeedsSignIn, setClaimNeedsSignIn] = useState(false)
  const [acceptPending, setAcceptPending] = useState(false)
  const [acceptError, setAcceptError] = useState<string | null>(null)
  const apiErrorMessage = useApiErrorMessage()
  const recoveryRef = useRef<ClaimRecovery | null>(null)

  useLayoutEffect(() => {
    const fragmentToken = claimTokenFromFragment()
    if (fragmentToken) {
      scrubFragment()
      setClaimToken(fragmentToken)
    } else if (rawToken) {
      clearCurrentClaimStorage()
      setClaimToken(null)
    }
    setFragmentReady(true)
  }, [rawToken])

  useEffect(() => {
    if (!claimToken) return
    void rememberClaimToken(claimToken)
  }, [claimToken])

  const preview = useQuery({
    queryKey: ['invitation-preview', rawToken],
    enabled: fragmentReady && claimToken === null && rawToken !== null,
    retry: false,
    queryFn: async (): Promise<InvitationPreview> => {
      const result = await api.get<InvitationPreview>(
        `/auth/invitation/preview?token=${encodeURIComponent(rawToken ?? '')}`,
      )
      if (!result.ok) throw result.error
      return result.value
    },
  })

  const data = preview.data
  const authConfigEnabled =
    claimToken === null && rawToken !== null && data?.status === 'pending' && data.orgId !== null
  const authConfigQuery = useQuery<PublicHostedAuthConfig, never>({
    queryKey: ['auth-config', 'invitation-claim', data?.orgId ?? null],
    enabled: authConfigEnabled,
    retry: false,
    queryFn: async () => {
      const params = new URLSearchParams()
      if (data?.orgId) params.set('organization_id', data.orgId)
      const path = params.size > 0 ? `/auth/config?${params.toString()}` : '/auth/config'
      const result = await api.get<PublicHostedAuthConfig>(path)
      return result.ok ? result.value : DEFAULT_PUBLIC_AUTH_CONFIG
    },
  })
  const authConfig = authConfigQuery.data ?? DEFAULT_PUBLIC_AUTH_CONFIG
  const { containerRef } = useTurnstile(
    authConfig.turnstileSiteKey,
    turnstileToken,
    setTurnstileToken,
  )
  const context = useInvitationContext(data)

  async function handleClaimStart(): Promise<void> {
    if (!rawToken || claimStartPending) return
    setClaimStartPending(true)
    setClaimStartError(null)
    const result = await api.post<{ ok: true }>('/auth/invitation/claim', {
      token: rawToken,
      turnstileToken,
    })
    setClaimStartPending(false)
    setTurnstileToken(null)
    if (!result.ok) {
      setClaimStartError(t`We couldn't send the invitation email. Try again.`)
      return
    }
    setClaimStartComplete(true)
  }

  async function handleAcceptAsSignedInUser(): Promise<void> {
    if (!rawToken || acceptPending) return
    setAcceptPending(true)
    setAcceptError(null)
    const result = await api.post<{ redirectUrl: string }>('/auth/invitation/accept', {
      token: rawToken,
    })
    setAcceptPending(false)
    if (!result.ok) {
      setAcceptError(apiErrorMessage(result.error, { surface: 'general' }))
      return
    }
    trackInvitationAccepted()
    invitationNavigation.assign(result.value.redirectUrl)
  }

  async function handleClaimVerify(): Promise<void> {
    if (!claimToken || claimVerifyPending) return
    setClaimVerifyPending(true)
    setClaimVerifyError(null)
    setClaimNeedsSignIn(false)
    const recovery = await getOrCreateRecovery(claimToken, recoveryRef.current)
    recoveryRef.current = recovery
    const result = await api.post<{ redirectUrl: string }>('/auth/invitation/claim/verify', {
      token: claimToken,
      recoveryKey: recovery.recoveryKey,
    })
    setClaimVerifyPending(false)
    if (!result.ok) {
      if (result.error.code === 'invitation_sign_in_required') {
        setClaimNeedsSignIn(true)
        setClaimVerifyError(apiErrorMessage(result.error, { surface: 'general' }))
        return
      }
      setClaimVerifyError(
        t`This email link is invalid or expired. Open the latest invitation email and try again.`,
      )
      return
    }
    clearClaimStorage(recovery.identifier)
    recoveryRef.current = null
    trackInvitationAccepted()
    invitationNavigation.assign(result.value.redirectUrl)
  }

  const status: InvitationPageStatus = !fragmentReady
    ? 'loading'
    : claimToken !== null
      ? 'claim-confirm'
      : rawToken === null
        ? 'missing-token'
        : preview.isPending
          ? 'loading'
          : !data || data.status === 'invalid'
            ? 'invalid'
            : data.status === 'expired'
              ? 'expired'
              : claimStartComplete
                ? 'check-email'
                : 'preview'

  const signedInAsInvitee =
    user !== null &&
    user.emailVerified &&
    data?.email !== null &&
    data?.email !== undefined &&
    user.email.trim().toLowerCase() === data.email.trim().toLowerCase()
  // 普通登录后回到本页由现有账号接受;invitation_token 会把登录页切到邮件认领(新账号)流程。
  const signInToAcceptPath = `/sign-in?${new URLSearchParams({
    continue: `/accept-invitation?${new URLSearchParams({ token: rawToken ?? '' }).toString()}`,
  }).toString()}`
  const turnstileRequired = authConfig.turnstileSiteKey !== null
  const waitingForAuthConfig = authConfigEnabled && authConfigQuery.isPending
  const claimStartDisabled =
    claimStartPending || waitingForAuthConfig || (turnstileRequired && turnstileToken === null)

  // Sign out 仅有会话时渲染;匿名 claim 流无会话,preview 身份切换走 "Not you?"。
  const footer = user ? (
    <button type="button" onClick={() => void signOut()} {...stylex.props(hosted.textLink)}>
      <Trans>Sign out and use a different account</Trans>
    </button>
  ) : undefined

  function previewView(invite: InvitationPreview): ReactNode {
    const org = invite.orgName
    return (
      <div {...stylex.props(hosted.screen)}>
        <AuthHeading
          above={user ? <AccountChip label={user.email} /> : undefined}
          title={org ? <Trans>Join {org}</Trans> : <Trans>Join organization</Trans>}
          lead={
            signedInAsInvitee ? (
              <Trans>Check the details, then accept with the account you're signed in to.</Trans>
            ) : user ? (
              <Trans>
                This invitation is for a different account. Switch to the invited account, or we can
                email it a secure link.
              </Trans>
            ) : (
              <Trans>
                We'll email a secure link to the invited address. If it already has an account, sign
                in to it instead.
              </Trans>
            )
          }
        />
        <InvitationDetails data={invite} />
        {user?.emailVerified ? (
          <div {...stylex.props(hosted.group)}>
            {acceptError ? <Notice tone="danger">{acceptError}</Notice> : null}
            <Button
              variant={signedInAsInvitee ? 'accent' : 'secondary'}
              size="lg"
              fullWidth
              isLoading={acceptPending}
              onClick={() => void handleAcceptAsSignedInUser()}
            >
              <Trans>Accept with this account</Trans>
            </Button>
          </div>
        ) : null}
        {signedInAsInvitee ? null : (
          <div {...stylex.props(hosted.group)}>
            {claimStartError ? <Notice tone="danger">{claimStartError}</Notice> : null}
            <Button
              variant="accent"
              size="lg"
              fullWidth
              isLoading={claimStartPending}
              disabled={claimStartDisabled}
              onClick={() => void handleClaimStart()}
            >
              <Trans>Email me a secure link</Trans>
            </Button>
            {user ? null : (
              <Link to={signInToAcceptPath} {...stylex.props(hosted.textLink)}>
                <Trans>Already have an account? Sign in to accept</Trans>
              </Link>
            )}
          </div>
        )}
      </div>
    )
  }

  function renderStatus(): ReactNode {
    if (status === 'claim-confirm') {
      return (
        <ClaimConfirmView
          error={claimVerifyError}
          needsSignIn={claimNeedsSignIn}
          isPending={claimVerifyPending}
          onConfirm={() => void handleClaimVerify()}
        />
      )
    }
    if (status === 'missing-token' || status === 'invalid' || status === 'expired') {
      return <InvitationProblem kind={status} />
    }
    if (status === 'check-email') {
      return (
        <CheckEmailView
          email={data?.email ?? null}
          error={claimStartError}
          isPending={claimStartPending}
          disabled={claimStartDisabled}
          onResend={() => void handleClaimStart()}
        />
      )
    }
    return data ? previewView(data) : null
  }

  return (
    <AuthLayout context={context} footer={footer}>
      {status === 'loading' ? (
        <div {...stylex.props(page.loadingCenter)}>
          <Spinner label={t`Loading invitation`} />
        </div>
      ) : (
        <div {...stylex.props(hosted.screen)}>
          {renderStatus()}
          {/* 同挂载点切换,Turnstile 不重建以便 resend 拿新 challenge。 */}
          {status === 'preview' || status === 'check-email' ? (
            <div ref={containerRef} {...stylex.props(styles.turnstile)} />
          ) : null}
        </div>
      )}
    </AuthLayout>
  )
}

export const Route = createLazyRoute('/accept-invitation')({
  component: AcceptInvitationPage,
})
