// Sessions:活跃会话(设备与浏览器、模拟登录标记、登录方式与时间、位置、最后活跃)、单个退出与全部退出。

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { I18n } from '@lingui/core'
import type { UseQueryResult } from '@tanstack/react-query'
import type { XidError } from '@xid-kit/types'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { Alert, Badge, Button, EmptyState, Skeleton } from '@xid-kit/web-ui/ui'
import { detail } from '../../../components/page/detail-styles'
import type { UserDetail, UserSession } from '../user-api'
import { useRevokeSession } from '../user-api'
import { describeUserAgent } from '../user-agent'
import { formatDateTime, formatRelative } from '../user-format'

function deviceLabel(i18n: I18n, session: UserSession): string {
  const { browser, os } = describeUserAgent(session.userAgent)
  if (browser && os) return i18n._(msg`${browser} on ${os}`)
  return browser ?? os ?? i18n._(msg`Unknown device`)
}

function methodLabel(i18n: I18n, amr: readonly string[] | null): string | null {
  if (!amr || amr.length === 0) return null
  if (amr.includes('phr')) return i18n._(msg`a passkey`)
  if (amr.includes('pwd')) return i18n._(msg`a password`)
  if (amr.includes('email')) return i18n._(msg`an email code`)
  if (amr.includes('sms') || amr.includes('otp')) return i18n._(msg`a one-time code`)
  if (amr.includes('guest')) return i18n._(msg`a guest session`)
  return null
}

function SessionRow({
  session,
  name,
  onRevoke,
  revoking,
}: {
  session: UserSession
  name: string
  onRevoke: () => void
  revoking: boolean
}): ReactNode {
  const { i18n } = useLingui()
  const method = methodLabel(i18n, session.amr)
  const when = formatDateTime(i18n, session.authenticatedAt)
  const impersonator = session.impersonatorDisplayName ?? i18n._(msg`An instance manager`)
  return (
    <li {...stylex.props(detail.itemRow)}>
      <div {...stylex.props(detail.itemMain)}>
        <span {...stylex.props(detail.itemTitle)}>
          {deviceLabel(i18n, session)}{' '}
          {session.isImpersonation ? (
            <Badge tone="info">
              <Trans>Impersonation</Trans>
            </Badge>
          ) : null}
        </span>
        <span {...stylex.props(detail.itemSub)}>
          {session.isImpersonation ? (
            <Trans>
              {impersonator} is viewing as {name}. Read-only.
            </Trans>
          ) : method ? (
            <Trans>
              Signed in with {method} on {when}.
            </Trans>
          ) : (
            <Trans>Signed in on {when}.</Trans>
          )}
        </span>
      </div>
      <span {...stylex.props(detail.itemState)}>
        {session.location ?? <Trans>Unknown location</Trans>}
      </span>
      <span {...stylex.props(detail.itemState)}>{formatRelative(i18n, session.lastActiveAt)}</span>
      <span {...stylex.props(detail.itemAction)}>
        <Button variant="secondary" isLoading={revoking} onClick={onRevoke}>
          <Trans>Sign out</Trans>
        </Button>
      </span>
    </li>
  )
}

export function SessionsTab({
  user,
  name,
  sessions,
  onSignOutEverywhere,
}: {
  user: UserDetail
  name: string
  sessions: UseQueryResult<{ data: UserSession[] }, XidError>
  onSignOutEverywhere: () => void
}): ReactNode {
  const errorMessage = useManagementErrorMessage()
  const revoke = useRevokeSession(user.id)
  const rows = sessions.data?.data ?? []
  const count = rows.length
  return (
    <section {...stylex.props(detail.section)}>
      <div {...stylex.props(detail.sectionHead)}>
        <div {...stylex.props(detail.sectionText)}>
          <h2 {...stylex.props(detail.sectionTitle)}>
            <Plural value={count} one="# active session" other="# active sessions" />
          </h2>
          <p {...stylex.props(detail.sectionLead)}>
            <Trans>
              Locations are estimated from the IP address. Last active includes background token
              refreshes, so a session can look active while the app is closed.
            </Trans>
          </p>
        </div>
        {count > 0 && user.status !== 'deleted' ? (
          <Button variant="secondary" onClick={onSignOutEverywhere}>
            <Trans>Sign out everywhere</Trans>
          </Button>
        ) : null}
      </div>
      {revoke.error ? <Alert tone="error">{errorMessage(revoke.error)}</Alert> : null}
      {sessions.isError ? (
        <EmptyState variant="load-failure" title={<Trans>Sessions could not be loaded</Trans>} />
      ) : !sessions.data ? (
        <Skeleton width="100%" height="4rem" />
      ) : count === 0 ? (
        <p {...stylex.props(detail.sectionLead)}>
          <Trans>{name} is not signed in anywhere.</Trans>
        </p>
      ) : (
        <ul {...stylex.props(detail.rows)}>
          {rows.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              name={name}
              revoking={revoke.isPending && revoke.variables === session.id}
              onRevoke={() => revoke.mutate(session.id)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}
