// 邀请页各状态:预览(组织、角色、受邀邮箱、有效期)、确认邮件链接、查看邮件、失效与过期。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Link } from '@xid-kit/web-ui/tanstack-router'
import { Badge, Button, Notice } from '../../components/ui'
import { AuthHeading } from '../../components/hosted/AuthHeading'
import { hosted } from '../../components/hosted/hosted-styles'
import { text } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '../../styles/tokens.stylex'

export type InvitationPreview = {
  status: 'pending' | 'expired' | 'invalid'
  email: string | null
  orgId: string | null
  orgName: string | null
  role: string | null
  expiresAt: string | null
}

const styles = stylex.create({
  rows: {
    display: 'flex',
    flexDirection: 'column',
    margin: 0,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    columnGap: '1rem',
    rowGap: '0.25rem',
    paddingBlock: '0.75rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    fontSize: text.sm,
  },
  term: {
    color: tokens['--xid-muted-foreground'],
  },
  value: {
    margin: 0,
    color: tokens['--xid-fg'],
    overflowWrap: 'anywhere',
  },
})

function DetailRow(props: { term: ReactNode; value: ReactNode }): ReactNode {
  return (
    <div {...stylex.props(styles.row)}>
      <dt {...stylex.props(styles.term)}>{props.term}</dt>
      <dd {...stylex.props(styles.value)}>{props.value}</dd>
    </div>
  )
}

function BackToSignIn(): ReactNode {
  return (
    <Link to="/sign-in" {...stylex.props(hosted.textLink)}>
      <Trans>Back to sign in</Trans>
    </Link>
  )
}

export function InvitationProblem(props: {
  kind: 'missing-token' | 'invalid' | 'expired'
}): ReactNode {
  if (props.kind === 'expired') {
    return (
      <div {...stylex.props(hosted.screen)}>
        <AuthHeading
          above={
            <Badge tone="warning">
              <Trans>Expired</Trans>
            </Badge>
          }
          title={<Trans>This invitation has expired</Trans>}
          lead={<Trans>Ask your organization admin to send a new invitation.</Trans>}
        />
        <BackToSignIn />
      </div>
    )
  }
  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        title={<Trans>This invitation link doesn't work</Trans>}
        lead={
          props.kind === 'missing-token' ? (
            <Trans>Open the link from your invitation email.</Trans>
          ) : (
            <Trans>It may have been used already. Ask your organization admin for a new one.</Trans>
          )
        }
      />
      <BackToSignIn />
    </div>
  )
}

export function InvitationDetails({ data }: { data: InvitationPreview }): ReactNode {
  const { i18n } = useLingui()
  const openUntil = data.expiresAt
    ? i18n.date(new Date(data.expiresAt), { dateStyle: 'medium' })
    : null
  return (
    <dl {...stylex.props(styles.rows)}>
      {data.orgName ? <DetailRow term={<Trans>Organization</Trans>} value={data.orgName} /> : null}
      {data.role ? <DetailRow term={<Trans>Role</Trans>} value={data.role} /> : null}
      {data.email ? <DetailRow term={<Trans>Sent to</Trans>} value={data.email} /> : null}
      {openUntil ? <DetailRow term={<Trans>Open until</Trans>} value={openUntil} /> : null}
    </dl>
  )
}

export function ClaimConfirmView(props: {
  error: string | null
  needsSignIn: boolean
  isPending: boolean
  onConfirm: () => void
}): ReactNode {
  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        title={<Trans>Confirm your invitation</Trans>}
        lead={
          <Trans>
            Continue only if you opened this link from the invitation email sent to you.
          </Trans>
        }
      />
      {props.error ? <Notice tone="danger">{props.error}</Notice> : null}
      {props.needsSignIn ? (
        <div {...stylex.props(hosted.group)}>
          <p {...stylex.props(hosted.note)}>
            <Trans>
              After signing in, open the original invitation link again to join with that account.
            </Trans>
          </p>
          <Link to="/sign-in" {...stylex.props(hosted.textLink)}>
            <Trans>Sign in</Trans>
          </Link>
        </div>
      ) : (
        <Button
          variant="accent"
          size="lg"
          fullWidth
          isLoading={props.isPending}
          onClick={props.onConfirm}
        >
          <Trans>Confirm and join</Trans>
        </Button>
      )}
    </div>
  )
}

export function CheckEmailView(props: {
  email: string | null
  error: string | null
  isPending: boolean
  disabled: boolean
  onResend: () => void
}): ReactNode {
  return (
    <div {...stylex.props(hosted.screen)}>
      <AuthHeading
        title={<Trans>Check your email</Trans>}
        lead={
          <Trans>
            We sent a one-time invitation link to {props.email}. Open it in this browser to
            continue.
          </Trans>
        }
      />
      {props.error ? <Notice tone="danger">{props.error}</Notice> : null}
      <Button
        variant="secondary"
        size="lg"
        fullWidth
        isLoading={props.isPending}
        disabled={props.disabled}
        onClick={props.onResend}
      >
        <Trans>Resend invitation email</Trans>
      </Button>
    </div>
  )
}
