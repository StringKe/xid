// SSO 连接与 SAML app 详情共用的分节、键值行、到期提醒和活动列表。

import { Trans, useLingui } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import type { UseInfiniteQueryResult } from '@tanstack/react-query'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, CopyButton, EmptyState, Spinner } from '@xid-kit/web-ui/ui'
import type { XidError } from '@xid-kit/types'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { formatDateTime } from '../../lib/date-format'
import type { ActivityEvent } from './auth-queries'
import type { V1Page } from './types'

const WIDE = '@media (min-width: 48rem)'

export const detailParts = stylex.create({
  column: {
    display: 'flex',
    flexDirection: 'column',
    gap: { default: '2rem', [WIDE]: '2.75rem' },
    maxWidth: '45rem',
    paddingTop: '0.25rem',
    fontFamily: tokens['--xid-font'],
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    minWidth: 0,
  },
  sectionHead: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '1rem',
  },
  sectionText: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    minWidth: 0,
  },
  sectionTitle: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: { default: text.md, [WIDE]: text.lg },
    lineHeight: { default: leading.md, [WIDE]: leading.lg },
    fontWeight: weight.display,
    letterSpacing: tokens['--xid-tracking-title'],
  },
  sectionDescription: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.base,
    lineHeight: leading.base,
  },
  rows: {
    display: 'flex',
    flexDirection: 'column',
    margin: 0,
    padding: 0,
    listStyle: 'none',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  valueRow: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr) auto',
      [WIDE]: '12.5rem minmax(0, 1fr) auto',
    },
    alignItems: 'center',
    gap: '0.25rem 1rem',
    minHeight: '2.75rem',
    paddingBlock: '0.625rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  label: {
    gridColumn: { default: '1 / -1', [WIDE]: 'auto' },
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.base,
    lineHeight: leading.sm,
  },
  value: {
    margin: 0,
    minWidth: 0,
    color: tokens['--xid-fg'],
    fontSize: text.base,
    lineHeight: leading.base,
    overflowWrap: 'anywhere',
  },
  mono: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.sm,
  },
  subValue: {
    display: 'block',
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.xs,
    lineHeight: leading.xs,
  },
  notice: {
    display: 'flex',
    flexDirection: { default: 'column', [WIDE]: 'row' },
    alignItems: { default: 'stretch', [WIDE]: 'flex-start' },
    justifyContent: 'space-between',
    gap: '1rem',
    padding: '1rem',
    borderRadius: tokens['--xid-radius-lg'],
    backgroundColor: tokens['--xid-warning-bg'],
  },
  noticeDanger: {
    backgroundColor: tokens['--xid-danger-bg'],
  },
  noticeText: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
    minWidth: 0,
  },
  noticeTitle: {
    margin: 0,
    color: tokens['--xid-fg'],
    fontSize: text.base,
    fontWeight: weight.medium,
    lineHeight: leading.sm,
  },
  noticeBody: {
    margin: 0,
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    lineHeight: leading.base,
  },
  activityRow: {
    display: 'grid',
    gridTemplateColumns: { default: 'minmax(0, 1fr)', [WIDE]: 'minmax(0, 1fr) 12rem' },
    gap: '0.125rem 1rem',
    paddingBlock: '0.75rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    fontSize: text.base,
  },
  activityMeta: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    fontVariantNumeric: 'tabular-nums',
  },
  center: {
    display: 'flex',
    justifyContent: 'center',
    paddingBlock: '2rem',
  },
})

export function DetailSection({
  title,
  description,
  action,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
}): ReactNode {
  return (
    <section {...stylex.props(detailParts.section)}>
      <div {...stylex.props(detailParts.sectionHead)}>
        <div {...stylex.props(detailParts.sectionText)}>
          <h2 {...stylex.props(detailParts.sectionTitle)}>{title}</h2>
          {description ? (
            <p {...stylex.props(detailParts.sectionDescription)}>{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

export type ValueRow = {
  key: string
  label: ReactNode
  value: ReactNode
  mono?: boolean
  copyValue?: string
  copySubject?: string
}

export function ValueRows({ rows }: { rows: readonly ValueRow[] }): ReactNode {
  return (
    <dl {...stylex.props(detailParts.rows)}>
      {rows.map((row) => (
        <div key={row.key} {...stylex.props(detailParts.valueRow)}>
          <dt {...stylex.props(detailParts.label)}>{row.label}</dt>
          <dd {...stylex.props(detailParts.value, row.mono && detailParts.mono)}>{row.value}</dd>
          {row.copyValue ? (
            <CopyButton value={row.copyValue} subject={row.copySubject ?? row.copyValue} />
          ) : (
            <span />
          )}
        </div>
      ))}
    </dl>
  )
}

export function ExpiryNotice({
  title,
  body,
  action,
  isExpired,
}: {
  title: ReactNode
  body: ReactNode
  action?: ReactNode
  isExpired: boolean
}): ReactNode {
  return (
    <div role="status" {...stylex.props(detailParts.notice, isExpired && detailParts.noticeDanger)}>
      <div {...stylex.props(detailParts.noticeText)}>
        <p {...stylex.props(detailParts.noticeTitle)}>{title}</p>
        <p {...stylex.props(detailParts.noticeBody)}>{body}</p>
      </div>
      {action}
    </div>
  )
}

function useEventLabel(): (eventType: string) => ReactNode {
  const { t } = useLingui()
  const labels: Record<string, string> = {
    'sso_connection.created': t`Connection created`,
    'sso_connection.updated': t`Connection settings changed`,
    'sso_connection.deleted': t`Connection deleted`,
    'connection.saml_certificate_renewed': t`Signing certificate renewed`,
    'user.created': t`Account created on first sign-in`,
    'outbound_saml_app.created': t`App added`,
    'outbound_saml_app.updated': t`App settings changed`,
    'outbound_saml_app.deleted': t`App removed`,
  }
  return (eventType) => labels[eventType] ?? eventType
}

export function ActivityList({
  query,
}: {
  query: UseInfiniteQueryResult<V1Page<ActivityEvent>, XidError>
}): ReactNode {
  const { t, i18n } = useLingui()
  const label = useEventLabel()
  if (query.isPending) {
    return (
      <div {...stylex.props(detailParts.center)}>
        <Spinner label={t`Loading activity`} />
      </div>
    )
  }
  if (query.isError) {
    return (
      <Alert tone="error">
        <Trans>Activity could not be loaded. Reload the page to try again.</Trans>
      </Alert>
    )
  }
  const events = query.data.data
  if (events.length === 0) {
    return <EmptyState title={<Trans>No activity yet.</Trans>} />
  }
  return (
    <div>
      <ul {...stylex.props(detailParts.rows)}>
        {events.map((event) => (
          <li key={event.id} {...stylex.props(detailParts.activityRow)}>
            <span>
              {label(event.eventType)}
              {event.actorDisplay ? (
                <span {...stylex.props(detailParts.subValue)}>{event.actorDisplay}</span>
              ) : null}
            </span>
            <span {...stylex.props(detailParts.activityMeta)}>
              {formatDateTime(i18n, event.occurredAt)}
            </span>
          </li>
        ))}
      </ul>
      {query.hasNextPage ? (
        <div {...stylex.props(detailParts.center)}>
          <Button
            type="button"
            variant="secondary"
            isLoading={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            <Trans>Load more</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  )
}
