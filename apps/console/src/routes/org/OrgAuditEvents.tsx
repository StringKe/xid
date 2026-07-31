// org 审计事件页(只读):时间/actor/event_type/target,支持 event_type 与时间范围过滤。
// 数据来自 GET /v1/organizations/:orgId/audit-events;后端按 org 归属过滤,前端仅做展示层筛选。
// 版式走 ConsolePage 骨架(web-ui):display 页头 + Toolbar 过滤栏 + hairline 表格节。
// 时间/序号 mono tabular-nums。

import { Trans, useLingui } from '@lingui/react/macro'
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { ColumnDef } from '@tanstack/react-table'
import { Alert, Field, Input } from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageToolbar,
} from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useAuditEventsQuery } from './queries'
import type { AuditEvent } from './types'
import { useOrgTarget } from './useOrgTarget'

const styles = stylex.create({
  // 过滤控件组:Toolbar 内的 search landmark,保持与 toolbar 相同的横向排布
  filterRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    gap: '0.75rem',
    flex: '1 1 auto',
    minWidth: 0,
  },
  // mono 时间戳 / 序号
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
  // 事件类型 chip:用 span 而非 code ---- 全局 :not(pre) > code 在 <=48rem 降级 white-space:normal
  // 会把 token 从词中断开;表格自带横向滚动,不需要 prose 式断行。
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
  // actor/target 的裸 ID 列宽有限:单行截断 + title 留全文,不折成多行 UUID。
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

function afterStart(occurredAt: string, fromDate: string): boolean {
  if (!fromDate) return true
  return new Date(occurredAt).getTime() >= new Date(fromDate).getTime()
}

function beforeEnd(occurredAt: string, toDate: string): boolean {
  if (!toDate) return true
  // toDate 是日期(无时分),取当天结束(+1 天)作上界。
  return new Date(occurredAt).getTime() < new Date(toDate).getTime() + 86_400_000
}

export default function OrgAuditEvents(): ReactNode {
  const { t } = useLingui()
  const { orgId } = useOrgTarget()

  const [cursor, setCursor] = useState<string | undefined>()
  const [eventTypeFilter, setEventTypeFilter] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')

  const { data, isLoading, isError } = useAuditEventsQuery(orgId, cursor)

  const rows = useMemo(() => {
    const all = data?.data ?? []
    const needle = eventTypeFilter.trim().toLowerCase()
    return all.filter((event) => {
      if (needle && !event.eventType.toLowerCase().includes(needle)) return false
      if (!afterStart(event.occurredAt, fromDate)) return false
      if (!beforeEnd(event.occurredAt, toDate)) return false
      return true
    })
  }, [data, eventTypeFilter, fromDate, toDate])

  if (!orgId) {
    return (
      <ConsolePage title={<Trans>Audit events</Trans>}>
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
      title={<Trans>Audit events</Trans>}
      lead={<Trans>Read-only event log for this organization.</Trans>}
    >
      {isError ? (
        <ConsolePageNotice>
          <Alert tone="error">
            <Trans>Failed to load audit events.</Trans>
          </Alert>
        </ConsolePageNotice>
      ) : null}

      <ConsolePageToolbar>
        <div role="search" aria-label={t`Filter audit events`} {...stylex.props(styles.filterRow)}>
          <div {...stylex.props(consoleShell.toolbarField)}>
            <Field label={<Trans>Event type</Trans>}>
              <Input
                value={eventTypeFilter}
                onChange={(event) => setEventTypeFilter(event.target.value)}
                placeholder={t`user.created`}
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
          data={rows}
          getRowId={(row) => row.id}
          isLoading={isLoading}
          emptyMessage={<Trans>No audit events match the current filters.</Trans>}
        />
        {data ? (
          <Pagination
            nextCursor={data.nextCursor}
            loadMoreLabel={<Trans>Load more events</Trans>}
            onLoadMore={setCursor}
          />
        ) : null}
      </ConsolePageSection>
    </ConsolePage>
  )
}
