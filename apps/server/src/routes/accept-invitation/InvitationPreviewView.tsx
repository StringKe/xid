// 邀请预览状态:按当前会话决定由已登录账号直接接受,或给受邀邮箱发送认领链接。
import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Button, Notice } from '../../components/ui'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { AccountChip } from '../../components/hosted/IdentityChip'
import { hosted } from '../../components/hosted/hosted-styles'
import { useAuth } from '../../lib/auth-context'
import { Link } from '@xid-kit/web-ui/tanstack-router'
import { InvitationDetails, type InvitationPreview } from './InvitationViews'

export type InvitationPreviewViewProps = {
  invite: InvitationPreview
  rawToken: string | null
  acceptError: string | null
  acceptPending: boolean
  onAccept: () => void
  claimStartError: string | null
  claimStartPending: boolean
  claimStartDisabled: boolean
  onClaimStart: () => void
  turnstileSlot: ReactNode
}

export function InvitationPreviewView({
  invite,
  rawToken,
  acceptError,
  acceptPending,
  onAccept,
  claimStartError,
  claimStartPending,
  claimStartDisabled,
  onClaimStart,
  turnstileSlot,
}: InvitationPreviewViewProps): ReactNode {
  const { user } = useAuth()
  const org = invite.orgName
  const signedInAsInvitee =
    user !== null &&
    user.emailVerified &&
    invite.email !== null &&
    invite.email !== undefined &&
    user.email.trim().toLowerCase() === invite.email.trim().toLowerCase()
  // 普通登录后回到本页由现有账号接受;invitation_token 会把登录页切到邮件认领(新账号)流程。
  const signInToAcceptPath = `/sign-in?${new URLSearchParams({
    continue: `/accept-invitation?${new URLSearchParams({ token: rawToken ?? '' }).toString()}`,
  }).toString()}`

  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        above={user ? <AccountChip label={user.email} name={user.name} /> : undefined}
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
            onClick={onAccept}
          >
            <Trans>Accept with this account</Trans>
          </Button>
        </div>
      ) : null}
      {signedInAsInvitee ? null : (
        <div {...stylex.props(hosted.group)}>
          {claimStartError ? <Notice tone="danger">{claimStartError}</Notice> : null}
          {turnstileSlot}
          <Button
            variant="accent"
            size="lg"
            fullWidth
            isLoading={claimStartPending}
            disabled={claimStartDisabled}
            onClick={onClaimStart}
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
