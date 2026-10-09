import type { I18n } from '@lingui/core'
import { Trans, useLingui } from '@lingui/react/macro'
import { useDeferredValue, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { Alert, Button, EmptyState, Input, Select, Skeleton } from '@xid-kit/web-ui/ui'
import { ConsolePage, ConsolePageNotice, ConsolePageSection } from '@xid-kit/web-ui/ui'
import { LoadMore } from '@xid-kit/web-ui/ui/LoadMore'
import { organizationDisplayName } from '@xid-kit/web-ui/display-names'
import { text } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { AuditChainVerifyPanel } from './AuditChainVerifyPanel'
import { usePlatformAuditEvents } from './ops-queries'
import type { PlatformAuditEventDetail, PlatformAuditFilters } from './ops-queries'
import { useInstanceManagerAssignmentsList, usePlatformOrganizationsList } from './queries'

const NARROW = '@media (max-width: 40rem)'
const DEFAULT_EVENT_FILTER = 'platform.*'

const styles = stylex.create({
  filters: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
    alignItems: 'center',
  },
  eventField: {
    position: 'relative',
    flex: { default: '0 1 17.5rem', [NARROW]: '1 1 100%' },
  },
  eventLabel: {
    position: 'absolute',
    insetBlock: 0,
    insetInlineStart: '0.75rem',
    display: 'flex',
    alignItems: 'center',
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    pointerEvents: 'none',
  },
  eventInput: {
    paddingInlineStart: '3.25rem',
    fontFamily: tokens['--xid-font-mono'],
  },
  filterSelect: {
    flex: { default: '0 0 auto', [NARROW]: '1 1 45%' },
    minWidth: '8rem',
  },
  list: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  row: {
    display: 'grid',
    gridTemplateColumns: {
      default: '8.5rem minmax(0, 1fr) auto',
      [NARROW]: '6.5rem minmax(0, 1fr)',
    },
    columnGap: '1rem',
    paddingBlock: '0.875rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  time: {
    color: tokens['--xid-muted-foreground'],
    fontSize: text.sm,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    paddingInlineEnd: { default: 0, [NARROW]: '0.75rem' },
    borderInlineEndWidth: { default: 0, [NARROW]: '1px' },
    borderInlineEndStyle: 'solid',
    borderInlineEndColor: tokens['--xid-border'],
  },
  toggle: {
    display: 'block',
    width: '100%',
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: tokens['--xid-fg'],
    fontSize: text.base,
    textAlign: 'start',
    cursor: 'pointer',
  },
  sentence: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: { default: 'normal', [NARROW]: 'nowrap' },
  },
  eventType: {
    display: 'block',
    marginTop: '0.125rem',
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.xs,
  },
  ip: {
    display: { default: 'block', [NARROW]: 'none' },
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.xs,
    fontVariantNumeric: 'tabular-nums',
  },
  details: {
    gridColumn: { default: '2 / -1', [NARROW]: '1 / -1' },
    margin: '0.75rem 0 0',
    padding: '0.875rem 1rem',
    overflowX: 'auto',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-code'],
    color: tokens['--xid-code-foreground'],
    fontFamily: tokens['--xid-font-mono'],
    fontSize: text.xs,
    lineHeight: 1.65,
  },
  skeletons: {
    display: 'grid',
    gap: '0.5rem',
  },
})

export function shortEventTime(i18n: I18n, iso: string): string {
  const date = new Date(iso)
  const today = new Date().toDateString() === date.toDateString()
  return today
    ? i18n.date(date, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    : i18n.date(date, { month: 'short', day: 'numeric' })
}

function eventTime(i18n: I18n, iso: string): string {
  return i18n.date(new Date(iso), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
}

type SentenceEvent = {
  eventType: string
  actorId: string | null
  actorName: string | null
  actorDisplay?: string | null
  targetId: string | null
}

// 平台操作的固定句式;未登记的事件类型退回「谁 记录了 事件名」。
export function PlatformEventSentence({ event }: { event: SentenceEvent }): ReactNode {
  const { t } = useLingui()
  const actor = event.actorName ?? event.actorDisplay ?? event.actorId ?? t`System`
  const target = event.targetId ?? ''
  const eventType = event.eventType
  switch (eventType) {
    case 'platform.queue_dead_letter.replayed':
      return (
        <Trans>
          {actor} replayed dead letter {target}.
        </Trans>
      )
    case 'platform.impersonation.started':
      return (
        <Trans>
          {actor} started impersonation of user {target}.
        </Trans>
      )
    case 'platform.impersonation.ended':
      return (
        <Trans>
          {actor} ended impersonation of user {target}.
        </Trans>
      )
    case 'platform.status_incident.created':
      return (
        <Trans>
          {actor} opened status incident {target}.
        </Trans>
      )
    case 'platform.status_incident.updated':
    case 'platform.status_incident.update_published':
      return (
        <Trans>
          {actor} updated status incident {target}.
        </Trans>
      )
    case 'platform.status_incident.deleted':
      return (
        <Trans>
          {actor} deleted status incident {target}.
        </Trans>
      )
    case 'platform.tenant_status_changed':
      return (
        <Trans>
          {actor} changed the status of organization {target}.
        </Trans>
      )
    case 'platform.quota_changed':
      return (
        <Trans>
          {actor} updated quotas of organization {target}.
        </Trans>
      )
    case 'platform.instance_manager.granted':
      return (
        <Trans>
          {actor} made user {target} an instance manager.
        </Trans>
      )
    case 'platform.instance_manager.revoked':
      return (
        <Trans>
          {actor} removed instance manager {target}.
        </Trans>
      )
    case 'platform.announcement.created':
      return (
        <Trans>
          {actor} created announcement {target}.
        </Trans>
      )
    case 'platform.announcement.updated':
      return (
        <Trans>
          {actor} updated announcement {target}.
        </Trans>
      )
    case 'platform.announcement.deleted':
      return (
        <Trans>
          {actor} deleted announcement {target}.
        </Trans>
      )
    case 'platform.compliance_document.created':
      return (
        <Trans>
          {actor} registered compliance evidence {target}.
        </Trans>
      )
    case 'platform.compliance_document.updated':
      return (
        <Trans>
          {actor} updated compliance evidence {target}.
        </Trans>
      )
    case 'platform.compliance_document.deleted':
      return (
        <Trans>
          {actor} deleted compliance evidence {target}.
        </Trans>
      )
    case 'platform.settings_changed':
      return <Trans>{actor} changed instance settings.</Trans>
    default:
      return target ? (
        <Trans>
          {actor} recorded {eventType} on {target}.
        </Trans>
      ) : (
        <Trans>
          {actor} recorded {eventType}.
        </Trans>
      )
  }
}

function AuditRow({ event }: { event: PlatformAuditEventDetail }): ReactNode {
  const { i18n, t } = useLingui()
  const [expanded, setExpanded] = useState(false)
  const hasDetails = Object.keys(event.details).length > 0
  const detailsId = `audit-details-${event.id}`
  return (
    <li {...stylex.props(styles.row)}>
      <time dateTime={event.occurredAt} {...stylex.props(styles.time)}>
        {eventTime(i18n, event.occurredAt)}
      </time>
      <div>
        <button
          type="button"
          aria-expanded={hasDetails ? expanded : undefined}
          aria-controls={hasDetails ? detailsId : undefined}
          aria-label={hasDetails ? t`Show details for ${event.eventType}` : undefined}
          disabled={!hasDetails}
          onClick={() => setExpanded((open) => !open)}
          {...stylex.props(styles.toggle)}
        >
          <span {...stylex.props(styles.sentence)}>
            <PlatformEventSentence event={event} />
          </span>
          <span {...stylex.props(styles.eventType)}>{event.eventType}</span>
        </button>
      </div>
      <span {...stylex.props(styles.ip)}>{event.actorIp}</span>
      {expanded ? (
        <pre id={detailsId} {...stylex.props(styles.details)}>
          {JSON.stringify(event.details, null, 2)}
        </pre>
      ) : null}
    </li>
  )
}

function AuditFilters({
  filters,
  onChange,
}: {
  filters: PlatformAuditFilters
  onChange: (next: PlatformAuditFilters) => void
}): ReactNode {
  const { t } = useLingui()
  const managers = useInstanceManagerAssignmentsList()
  const organizations = usePlatformOrganizationsList('')
  return (
    <div role="group" aria-label={t`Filter entries`} {...stylex.props(styles.filters)}>
      <label {...stylex.props(styles.eventField)}>
        <span {...stylex.props(styles.eventLabel)}>
          <Trans>Event</Trans>
        </span>
        <Input
          value={filters.eventType}
          spellCheck={false}
          aria-label={t`Event type, end with * to match a prefix`}
          onChange={(event) => onChange({ ...filters, eventType: event.target.value.trim() })}
          {...stylex.props(styles.eventInput)}
        />
      </label>
      <div {...stylex.props(styles.filterSelect)}>
        <Select
          aria-label={t`Actor`}
          value={filters.actorId}
          onChange={(event) => onChange({ ...filters, actorId: event.target.value })}
        >
          <option value="">{t`Any actor`}</option>
          {(managers.data?.data ?? []).map((manager) => (
            <option key={manager.id} value={manager.userId}>
              {manager.displayName ?? manager.email ?? manager.userId}
            </option>
          ))}
        </Select>
      </div>
      <div {...stylex.props(styles.filterSelect)}>
        <Select
          aria-label={t`Organization`}
          value={filters.organizationId}
          onChange={(event) => onChange({ ...filters, organizationId: event.target.value })}
        >
          <option value="">{t`Any organization`}</option>
          <option value="platform">{t`Instance managers (platform)`}</option>
          {(organizations.data?.data ?? []).map((organization) => (
            <option key={organization.id} value={organization.id}>
              {organizationDisplayName(organization)}
            </option>
          ))}
        </Select>
      </div>
    </div>
  )
}

const EVENT_FILTER_PATTERN = /^[A-Za-z0-9_.-]{1,100}\*?$/u

export default function PlatformAuditEvents(): ReactNode {
  const [filters, setFilters] = useState<PlatformAuditFilters>({
    eventType: DEFAULT_EVENT_FILTER,
    actorId: '',
    organizationId: '',
  })
  const deferredFilters = useDeferredValue(filters)
  const eventType = EVENT_FILTER_PATTERN.test(deferredFilters.eventType)
    ? deferredFilters.eventType
    : ''
  const events = usePlatformAuditEvents({ ...deferredFilters, eventType })
  const rows = events.data?.data ?? []

  return (
    <ConsolePage
      wide
      title={<Trans>Audit log</Trans>}
      lead={
        <Trans>
          What instance managers did across this instance. Entries are append-only and each
          organization's entries form a hash chain you can verify.
        </Trans>
      }
    >
      {events.isError ? (
        <ConsolePageNotice>
          <Alert tone="error">
            <Trans>The audit log could not be loaded.</Trans>{' '}
            <Button variant="secondary" onClick={() => void events.refetch()}>
              <Trans>Try again</Trans>
            </Button>
          </Alert>
        </ConsolePageNotice>
      ) : null}

      <AuditChainVerifyPanel />

      <ConsolePageSection title={<Trans>Entries</Trans>}>
        <AuditFilters filters={filters} onChange={setFilters} />
        {events.isLoading ? (
          <div {...stylex.props(styles.skeletons)}>
            <Skeleton height="3.25rem" />
            <Skeleton height="3.25rem" />
            <Skeleton height="3.25rem" />
          </div>
        ) : null}
        {!events.isLoading && !events.isError && rows.length === 0 ? (
          <EmptyState title={<Trans>No entries match these filters.</Trans>} />
        ) : null}
        {rows.length > 0 ? (
          <>
            <ul {...stylex.props(styles.list)}>
              {rows.map((event) => (
                <AuditRow key={event.id} event={event} />
              ))}
            </ul>
            <LoadMore query={events} loadMoreLabel={<Trans>Load more entries</Trans>} />
          </>
        ) : null}
      </ConsolePageSection>
    </ConsolePage>
  )
}
