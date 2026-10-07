// Activity:该用户作为操作者或对象的审计事件,按天分组,每行一句完整的话 + 事件类型;「Load older events」翻页。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { text } from '@xid-kit/web-ui/styles/scale.stylex'
import { Link, useLocation } from '@xid-kit/web-ui/tanstack-router'
import { Button, EmptyState, Skeleton } from '@xid-kit/web-ui/ui'
import { detail } from '../../../components/page/detail-styles'
import type { UserAuditEvent, UserDetail } from '../user-api'
import { useUserAuditEvents } from '../user-api'
import { activitySentence } from '../activity-sentence'
import { withOrgId } from '../UsersList'

const styles = stylex.create({
  day: {
    margin: 0,
    paddingTop: '0.75rem',
    paddingBottom: '0.5rem',
    fontSize: text.sm,
    fontWeight: 500,
    color: tokens['--xid-muted-foreground'],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  event: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 48rem)': '4rem minmax(0, 1fr) auto',
    },
    gap: '0.25rem 1rem',
    paddingBlock: '0.75rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    fontSize: text.base,
  },
  time: {
    color: tokens['--xid-muted-foreground'],
    fontVariantNumeric: 'tabular-nums',
  },
  type: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.xs,
    color: tokens['--xid-muted-foreground'],
    overflowWrap: 'anywhere',
  },
  list: { margin: 0, padding: 0, listStyle: 'none' },
})

function groupByDay(events: readonly UserAuditEvent[], format: (iso: string) => string) {
  const groups: { day: string; events: UserAuditEvent[] }[] = []
  for (const event of events) {
    const day = format(event.occurredAt)
    const last = groups[groups.length - 1]
    if (last?.day === day) last.events.push(event)
    else groups.push({ day, events: [event] })
  }
  return groups
}

export function ActivityTab({ user, name }: { user: UserDetail; name: string }): ReactNode {
  const { i18n } = useLingui()
  const location = useLocation()
  const [cursors, setCursors] = useState<string[]>([])
  const [loaded, setLoaded] = useState<UserAuditEvent[]>([])
  const page = useUserAuditEvents(user.id, cursors[cursors.length - 1] ?? null)
  const events = [...loaded, ...(page.data?.data ?? [])]
  const groups = groupByDay(events, (iso) => i18n.date(new Date(iso), { dateStyle: 'full' }))

  return (
    <section {...stylex.props(detail.section)}>
      <div {...stylex.props(detail.sectionHead)}>
        <div {...stylex.props(detail.sectionText)}>
          <h2 {...stylex.props(detail.sectionTitle)}>
            <Trans>Activity</Trans>
          </h2>
          <p {...stylex.props(detail.sectionLead)}>
            <Trans>Events where {name} acted or was changed, newest first.</Trans>
          </p>
        </div>
        <Link
          to={withOrgId('/console/org/audit-events', location.search)}
          {...stylex.props(detail.link)}
        >
          <Trans>Open in Audit log</Trans>
        </Link>
      </div>
      {page.isError && events.length === 0 ? (
        <EmptyState
          variant="load-failure"
          title={<Trans>Activity could not be loaded</Trans>}
          action={
            <Button variant="secondary" onClick={() => void page.refetch()}>
              <Trans>Try again</Trans>
            </Button>
          }
        />
      ) : page.isLoading && events.length === 0 ? (
        <Skeleton width="100%" height="6rem" />
      ) : events.length === 0 ? (
        <p {...stylex.props(detail.sectionLead)}>
          <Trans>No activity recorded for {name} yet.</Trans>
        </p>
      ) : (
        <>
          {groups.map((group) => (
            <div key={group.day}>
              <p {...stylex.props(styles.day)}>{group.day}</p>
              <ul {...stylex.props(styles.list)}>
                {group.events.map((event) => (
                  <li key={event.id} {...stylex.props(styles.event)}>
                    <span {...stylex.props(styles.time)}>
                      {i18n.date(new Date(event.occurredAt), { timeStyle: 'short' })}
                    </span>
                    <span>{activitySentence(i18n, event, name, user.id)}</span>
                    <span {...stylex.props(styles.type)}>{event.eventType}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {page.data?.has_more && page.data.next_cursor ? (
            <Button
              variant="secondary"
              isLoading={page.isFetching}
              onClick={() => {
                setLoaded(events)
                setCursors([...cursors, page.data?.next_cursor ?? ''])
              }}
            >
              <Trans>Load older events</Trans>
            </Button>
          ) : null}
        </>
      )}
    </section>
  )
}
