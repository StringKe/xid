// 归属与筛选都由后端执行,前端只组装筛选参数。

import { Trans, useLingui } from '@lingui/react/macro'
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { DataTableColumnDef as ColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import { Alert, Field, Input } from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageToolbar,
} from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { LoadMore } from '@xid-kit/web-ui/ui/LoadMore'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { useAuditEventsQuery } from './queries'
import type { AuditEvent, AuditEventFilters } from './types'
import { useOrgTarget } from './useOrgTarget'

const styles = stylex.create({
  filterRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    gap: '0.75rem',
    flex: '1 1 auto',
    minWidth: 0,
  },
  seqText: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.8125rem',
    fontVariantNumeric: 'tabular-nums',
    color: tokens['--xid-muted-foreground'],
  },
  timeText: {
    whiteSpace: 'nowrap',
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.8125rem',
    fontVariantNumeric: 'tabular-nums',
  },
  // 用 span 不用 code:全局 :not(pre)>code 在窄屏会 white-space:normal 拆断 token。
  codeTag: {
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.8125rem',
    background: tokens['--xid-muted'],
    paddingBlock: '0.125rem',
    paddingInline: '0.375rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius-sm'],
    whiteSpace: 'nowrap',
  },
  mutedSmall: {
    fontSize: '0.8125rem',
    color: tokens['--xid-muted-foreground'],
  },
  // 裸 ID 单行截断 + title 全文,避免多行 UUID。
  actorId: {
    display: 'block',
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  actorIp: {
    display: 'block',
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.75rem',
    fontVariantNumeric: 'tabular-nums',
  },
  targetId: {
    display: 'block',
    fontFamily: tokens['--xid-font-mono'],
    fontSize: '0.75rem',
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
})

const columns: ColumnDef<AuditEvent>[] = [
  {
    id: 'seq',
    header: () => <Trans>Seq</Trans>,
    cell: ({ row }) => <span {...stylex.props(styles.seqText)}>{row.original.seq}</span>,
    meta: { width: '80px' },
  },
  {
    id: 'occurred',
    header: () => <Trans>Time</Trans>,
    cell: ({ row }) => (
      <span {...stylex.props(styles.timeText)}>
        {new Date(row.original.occurredAt).toLocaleString()}
      </span>
    ),
    meta: { width: '170px' },
  },
  {
    id: 'event',
    header: () => <Trans>Event type</Trans>,
    cell: ({ row }) => <span {...stylex.props(styles.codeTag)}>{row.original.eventType}</span>,
  },
  {
    id: 'actor',
    header: () => <Trans>Actor</Trans>,
    cell: ({ row }) => (
      <span {...stylex.props(styles.mutedSmall)}>
        {row.original.actorDisplay ? (
          <span
            {...stylex.props(styles.actorId)}
            title={
              row.original.actorDisplay === row.original.actorId
                ? (row.original.actorId ?? undefined)
                : undefined
            }
          >
            {row.original.actorDisplay}
          </span>
        ) : (
          <Trans>system</Trans>
        )}
        {row.original.actorIp ? (
          <span {...stylex.props(styles.actorIp)}>{row.original.actorIp}</span>
        ) : null}
      </span>
    ),
    meta: { width: '180px' },
  },
  {
    id: 'target',
    header: () => <Trans>Target</Trans>,
    cell: ({ row }) =>
      row.original.targetType ? (
        <span {...stylex.props(styles.mutedSmall)}>
          {row.original.targetType}
          {row.original.targetId ? (
            <span {...stylex.props(styles.targetId)} title={row.original.targetId}>
              {row.original.targetId}
            </span>
          ) : null}
        </span>
      ) : null,
    meta: { width: '180px' },
  },
]

const FILTER_DEBOUNCE_MS = 300

// 日期输入按本地时区换算:From 取当天 00:00,To 取次日 00:00 作为不含上界。
function localDayStart(date: string, offsetDays = 0): string | undefined {
  if (!date) return undefined
  const start = new Date(`${date}T00:00:00`)
  start.setDate(start.getDate() + offsetDays)
  return start.toISOString()
}

function useDebouncedValue(value: string): string {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), FILTER_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [value])
  return debounced
}

export default function OrgAuditEvents(): ReactNode {
  const { t } = useLingui()
  const errorMessage = useManagementErrorMessage()
  const { orgId } = useOrgTarget()

  const [eventTypeFilter, setEventTypeFilter] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const eventTypePrefix = useDebouncedValue(eventTypeFilter.trim())

  const filters = useMemo<AuditEventFilters>(
    () => ({
      event_type: eventTypePrefix || undefined,
      occurred_from: localDayStart(fromDate),
      occurred_to: localDayStart(toDate, 1),
    }),
    [eventTypePrefix, fromDate, toDate],
  )
  const events = useAuditEventsQuery(orgId, filters)
  const { data, isLoading, error } = events

  if (!orgId) {
    return (
      <ConsolePage wide title={<Trans>Audit events</Trans>}>
        <ConsolePageNotice>
          <Alert tone="info">
            <Trans>No organization selected.</Trans>
          </Alert>
        </ConsolePageNotice>
      </ConsolePage>
    )
  }

  return (
    <ConsolePage
      wide
      title={<Trans>Audit events</Trans>}
      lead={<Trans>Read-only event log for this organization.</Trans>}
    >
      {error ? (
        <ConsolePageNotice>
          <Alert tone="error">{errorMessage(error)}</Alert>
        </ConsolePageNotice>
      ) : null}

      <ConsolePageToolbar>
        <div role="search" aria-label={t`Filter audit events`} {...stylex.props(styles.filterRow)}>
          <div {...stylex.props(consoleShell.toolbarField)}>
            <Field
              label={<Trans>Event type</Trans>}
              hint={<Trans>Matches names that start with this text.</Trans>}
            >
              <Input
                value={eventTypeFilter}
                onChange={(event) => setEventTypeFilter(event.target.value)}
                placeholder={t`api_key.`}
              />
            </Field>
          </div>
          <div {...stylex.props(consoleShell.toolbarField)}>
            <Field label={<Trans>From</Trans>}>
              <Input
                type="date"
                value={fromDate}
                onChange={(event) => setFromDate(event.target.value)}
                aria-label={t`Filter events from date`}
              />
            </Field>
          </div>
          <div {...stylex.props(consoleShell.toolbarField)}>
            <Field label={<Trans>To</Trans>}>
              <Input
                type="date"
                value={toDate}
                onChange={(event) => setToDate(event.target.value)}
                aria-label={t`Filter events to date`}
              />
            </Field>
          </div>
        </div>
      </ConsolePageToolbar>

      <ConsolePageSection title={<Trans>Events</Trans>}>
        <DataTable
          columns={columns}
          data={data?.data ?? []}
          getRowId={(row) => row.id}
          isLoading={isLoading}
          emptyMessage={<Trans>No audit events match the current filters.</Trans>}
        />
        <LoadMore query={events} loadMoreLabel={<Trans>Load more events</Trans>} />
      </ConsolePageSection>
    </ConsolePage>
  )
}
