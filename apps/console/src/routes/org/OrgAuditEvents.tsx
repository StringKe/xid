// org 审计事件页(只读):时间/actor/event_type/target,支持 event_type 与时间范围过滤。
// 数据来自 GET /v1/organizations/:orgId/audit-events;后端按 org 归属过滤,前端仅做展示层筛选。
// 全宽锚定版式:零 padding 壳,过滤栏与表格节各自持有 gutter;全宽 1px hairline 分节。
// 时间/序号 mono tabular-nums。

import { Trans, useLingui } from '@lingui/react/macro'
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { ColumnDef } from '@tanstack/react-table'
import { Alert, Field, Input } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useAuditEventsQuery } from './queries'
import type { AuditEvent } from './types'
import { useOrgTarget } from './useOrgTarget'

const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'
const SECTION_PAD = 'clamp(1.5rem, 1.6vw, 2.5rem)'

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    paddingBottom: 'clamp(2rem, 3vw, 4rem)',
  },
  headerZone: {
    paddingInline: GUTTER,
    paddingTop: 'clamp(1.75rem, 2vw, 3rem)',
    paddingBottom: 'clamp(1.25rem, 1.5vw, 2rem)',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  title: {
    margin: 0,
    fontSize: 'clamp(1.75rem, 1.05rem + 1.5vw, 2.75rem)',
    fontWeight: 620,
    lineHeight: 1.05,
    letterSpacing: '-0.03em',
    color: tokens['--xid-fg'],
    textWrap: 'balance',
  },
  titleLead: {
    margin: '0.375rem 0 0',
    fontSize: '0.875rem',
    lineHeight: 1.55,
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
  },
  // 过滤栏:横贯全宽 hairline 下分节 + gutter
  filterZone: {
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    display: 'flex',
    flexWrap: 'wrap',
    gap: '1rem',
    alignItems: 'flex-end',
  },
  filterField: {
    flex: '1 1 200px',
    maxWidth: '20rem',
  },
  // 表格区节
  tableSection: {
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
  },
  paginationWrap: {
    marginTop: '0.75rem',
  },
  messageZone: {
    paddingInline: GUTTER,
    paddingBlock: '1.5rem',
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
      <div {...stylex.props(styles.messageZone)}>
        <Alert tone="info">
          <Trans>No organization selected.</Trans>
        </Alert>
      </div>
    )
  }

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.headerZone)}>
        <h1 {...stylex.props(styles.title)}>
          <Trans>Audit events</Trans>
        </h1>
        <p {...stylex.props(styles.titleLead)}>
          <Trans>Read-only event log for this organization.</Trans>
        </p>
      </div>

      <div {...stylex.props(styles.filterZone)} role="search" aria-label={t`Filter audit events`}>
        <div {...stylex.props(styles.filterField)}>
          <Field label={<Trans>Event type</Trans>}>
            <Input
              value={eventTypeFilter}
              onChange={(event) => setEventTypeFilter(event.target.value)}
              placeholder={t`user.created`}
            />
          </Field>
        </div>
        <div {...stylex.props(styles.filterField)}>
          <Field label={<Trans>From</Trans>}>
            <Input
              type="date"
              value={fromDate}
              onChange={(event) => setFromDate(event.target.value)}
              aria-label={t`Filter events from date`}
            />
          </Field>
        </div>
        <div {...stylex.props(styles.filterField)}>
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

      {isError ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="error">
            <Trans>Failed to load audit events. Please try again.</Trans>
          </Alert>
        </div>
      ) : (
        <section aria-labelledby="audit-table-heading" {...stylex.props(styles.tableSection)}>
          <h2 id="audit-table-heading" {...stylex.props(page.visuallyHidden)}>
            <Trans>Audit event list</Trans>
          </h2>
          <DataTable
            columns={columns}
            data={rows}
            getRowId={(row) => row.id}
            isLoading={isLoading}
            emptyMessage={<Trans>No audit events match the current filters.</Trans>}
          />
          {data ? (
            <div {...stylex.props(styles.paginationWrap)}>
              <Pagination
                nextCursor={data.nextCursor}
                loadMoreLabel={<Trans>Load more events</Trans>}
                onLoadMore={setCursor}
              />
            </div>
          ) : null}
        </section>
      )}
    </div>
  )
}
