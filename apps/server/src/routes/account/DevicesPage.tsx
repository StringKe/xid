// Devices:登录中的会话,标出本设备与模拟会话,可单独退出或退出其他所有设备。
// 位置按 IP 估算、最后活跃包含后台活动,这两点常驻说明。

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Badge, Button, Skeleton } from '../../components/ui'
import { useAccountBrand } from './use-account-brand'
import { AccountPage, AccountRow, AccountSection, RowMeta } from './AccountPage'
import { AccountIcon } from './account-icons'
import { useAccountDates, useLocationLabel } from './account-format'
import { surface } from './account-surface'
import { ConfirmDialog } from './ConfirmDialog'
import { parseUserAgent } from './device-label'
import { useRevokeAllSessions, useRevokeSession, useSessionsQuery } from './queries'
import type { ActiveSession } from './types'
import { useActionError } from './use-security-action-error'

function useSessionTitle(): (session: ActiveSession) => string {
  const { t } = useLingui()
  return (session) => {
    const { browser, platform } = parseUserAgent(session.userAgent)
    if (browser && platform) return t`${browser} on ${platform}`
    return browser ?? platform ?? session.deviceName ?? t`Unknown device`
  }
}

function SignInMethod({ amr, date }: { amr: readonly string[]; date: string }): ReactNode {
  if (amr.includes('phr')) return <Trans>Signed in on {date} with a passkey.</Trans>
  if (amr.includes('sms')) return <Trans>Signed in on {date} with a text message code.</Trans>
  if (amr.includes('email')) return <Trans>Signed in on {date} with an email code.</Trans>
  if (amr.includes('guest')) return <Trans>Signed in on {date} as a guest.</Trans>
  return <Trans>Signed in on {date}.</Trans>
}

function SessionRow({
  session,
  onSignOut,
}: {
  session: ActiveSession
  onSignOut: (session: ActiveSession) => void
}): ReactNode {
  const { t } = useLingui()
  const dates = useAccountDates()
  const locationLabel = useLocationLabel()
  const title = useSessionTitle()(session)
  const kind = parseUserAgent(session.userAgent).kind
  const location = locationLabel(session.location) ?? t`Unknown location`
  const signedIn = dates.date(session.signedInAt)
  const lastActive = dates.dateTime(session.lastActiveAt)
  const impersonator = session.impersonator?.displayName ?? session.impersonator?.email ?? null
  const ends = dates.dateTime(session.expiresAt)

  return (
    <AccountRow
      icon={
        <span aria-hidden="true" {...stylex.props(surface.iconTile)}>
          <AccountIcon
            name={
              session.isImpersonation
                ? 'impersonation'
                : kind === 'phone'
                  ? 'phone'
                  : kind === 'tablet'
                    ? 'tablet'
                    : 'devices'
            }
          />
        </span>
      }
      title={title}
      badges={
        <>
          {session.isCurrent ? (
            <Badge tone="info">
              <Trans>This device</Trans>
            </Badge>
          ) : null}
          {session.isImpersonation ? (
            <Badge tone="warning">
              <Trans>Impersonation</Trans>
            </Badge>
          ) : null}
        </>
      }
      meta={
        session.isImpersonation ? (
          <>
            <RowMeta>
              {impersonator ? (
                <Trans>
                  {impersonator}, an administrator, is viewing your account as you. Read-only.
                </Trans>
              ) : (
                <Trans>An administrator is viewing your account as you. Read-only.</Trans>
              )}
            </RowMeta>
            <RowMeta>
              <Trans>
                {location}. Started {signedIn}, ends by itself at {ends}.
              </Trans>
            </RowMeta>
          </>
        ) : (
          <>
            <RowMeta>{location}</RowMeta>
            <RowMeta>
              {session.isCurrent ? (
                <Trans>Active now.</Trans>
              ) : (
                <Trans>Last active {lastActive}.</Trans>
              )}{' '}
              <SignInMethod amr={session.amr} date={signedIn} />
            </RowMeta>
          </>
        )
      }
      actions={
        session.isCurrent ? null : (
          <Button variant="secondary" onClick={() => onSignOut(session)}>
            {session.isImpersonation ? <Trans>End this session</Trans> : <Trans>Sign out</Trans>}
          </Button>
        )
      }
    />
  )
}

export default function DevicesPage(): ReactNode {
  const { t } = useLingui()
  const sessions = useSessionsQuery()
  const revoke = useRevokeSession()
  const revokeAll = useRevokeAllSessions()
  const actionError = useActionError()
  const sessionTitle = useSessionTitle()
  const [signingOut, setSigningOut] = useState<ActiveSession | null>(null)
  const [signingOutAll, setSigningOutAll] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const appName = useAccountBrand().name

  const list = [...(sessions.data ?? [])].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
    return b.lastActiveAt.localeCompare(a.lastActiveAt)
  })
  const others = list.filter((session) => !session.isCurrent).length

  const handleSignOut = async (session: ActiveSession): Promise<void> => {
    setError(null)
    try {
      await revoke.mutateAsync(session.id)
      setSigningOut(null)
    } catch (err) {
      setSigningOut(null)
      setError(actionError(err, t`We couldn't sign out that device. Try again.`))
    }
  }

  const handleSignOutAll = async (): Promise<void> => {
    setError(null)
    try {
      await revokeAll.mutateAsync()
      setSigningOutAll(false)
    } catch (err) {
      setSigningOutAll(false)
      setError(actionError(err, t`We couldn't sign out your other devices. Try again.`))
    }
  }

  return (
    <AccountPage
      title={<Trans>Devices</Trans>}
      description={
        <Trans>
          Where you're signed in to {appName}. If you don't recognize one, sign it out and update
          your password.
        </Trans>
      }
      actions={
        others > 0 ? (
          <Button variant="secondary" onClick={() => setSigningOutAll(true)}>
            <Trans>Sign out of all other devices…</Trans>
          </Button>
        ) : null
      }
    >
      <AccountSection
        title={<Trans>Signed in</Trans>}
        description={
          <Trans>
            Locations are estimated from IP addresses and can be off by a city or more. Last active
            includes background activity, such as an app refreshing in the background.
          </Trans>
        }
      >
        {error ? (
          <div {...stylex.props(surface.note)}>
            <Alert tone="error">{error}</Alert>
          </div>
        ) : null}
        {sessions.isPending ? (
          <div {...stylex.props(surface.skeletonStack)}>
            <Skeleton height="3.5rem" />
            <Skeleton height="3.5rem" />
            <Skeleton height="3.5rem" />
          </div>
        ) : sessions.error ? (
          <div {...stylex.props(surface.note)}>
            <Alert tone="warning" title={<Trans>We couldn't load your devices</Trans>}>
              <Trans>
                Your devices are still signed in as before. Refresh the page to try again.
              </Trans>
            </Alert>
          </div>
        ) : (
          list.map((session) => (
            <SessionRow key={session.id} session={session} onSignOut={setSigningOut} />
          ))
        )}
      </AccountSection>
      {signingOut ? (
        <ConfirmDialog
          title={
            signingOut.isImpersonation ? (
              <Trans>End this session?</Trans>
            ) : (
              <Trans>Sign out of {sessionTitle(signingOut)}?</Trans>
            )
          }
          description={
            <Trans>That device has to sign in again before it can use your account.</Trans>
          }
          confirmLabel={
            signingOut.isImpersonation ? <Trans>End session</Trans> : <Trans>Sign out</Trans>
          }
          isLoading={revoke.isPending}
          onConfirm={() => void handleSignOut(signingOut)}
          onCancel={() => setSigningOut(null)}
        />
      ) : null}
      {signingOutAll ? (
        <ConfirmDialog
          title={<Trans>Sign out of all other devices?</Trans>}
          description={
            <Plural
              value={others}
              one="You stay signed in here. # other device has to sign in again, and apps you use on it stop syncing until it does."
              other="You stay signed in here. # other devices have to sign in again, and apps you use on them stop syncing until they do."
            />
          }
          confirmLabel={<Trans>Sign out other devices</Trans>}
          isLoading={revokeAll.isPending}
          onConfirm={() => void handleSignOutAll()}
          onCancel={() => setSigningOutAll(false)}
        />
      ) : null}
    </AccountPage>
  )
}
