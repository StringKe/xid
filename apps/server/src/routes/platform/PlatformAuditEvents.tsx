// platform console 全局事件流页:汇聚所有 organization 审计事件 + cursor 分页。
// 调 GET /v1/platform/audit-events?cursor=&limit=30(TanStack Query + DataTable)。
// 全宽锚定版式:零 padding 壳,各节自持 gutter;hairline 分节;mono tabular-nums 时间戳。

import { Trans } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { ColumnDef } from '@tanstack/react-table'
import { Alert } from '../../components/ui'
import { DataTable } from '../../components/ui/DataTable'
import { Pagination } from '../../components/ui/Pagination'
import { organizationDisplayName } from '../../lib/display-names'
import { page } from '../../styles/product-surface.stylex'
import { tokens } from '../../styles/tokens.stylex'
import { useGlobalAuditEventsQuery } from './queries'
import type { AuditEvent } from './types'

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
  // 事件类型 chip:用 span 而非 code —— 全局 :not(pre) > code 在 <=48rem 降级 white-space:normal
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
    meta: { width: '160px' },
  },
  {
    id: 'organization',
    header: () => <Trans>Organization</Trans>,
    cell: ({ row }) =>
      row.original.organizationName
        ? organizationDisplayName({ name: row.original.organizationName })
        : row.original.organizationId,
    meta: { width: '140px' },
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
        {row.original.actorId ? (
          <span {...stylex.props(styles.actorId)} title={row.original.actorId}>
            {row.original.actorId}
          </span>
        ) : (
          <Trans>system</Trans>
        )}
        {row.original.actorIp ? (
          <span {...stylex.props(styles.actorIp)}>{row.original.actorIp}</span>
        ) : null}
      </span>
    ),
    meta: { width: '160px' },
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
    meta: { width: '160px' },
  },
]

export default function PlatformAuditEvents(): ReactNode {
  const [cursor, setCursor] = useState<string | undefined>()
  const { data, isLoading, isError } = useGlobalAuditEventsQuery(cursor)

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.headerZone)}>
        <h1 {...stylex.props(styles.title)}>
          <Trans>Global event stream</Trans>
        </h1>
      </div>

      {isError ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="error">
            <Trans>Failed to load audit events. Please try again.</Trans>
          </Alert>
        </div>
      ) : (
        <section aria-labelledby="global-audit-heading" {...stylex.props(styles.tableSection)}>
          <h2 id="global-audit-heading" {...stylex.props(page.visuallyHidden)}>
            <Trans>Global audit event list</Trans>
          </h2>
          <DataTable
            columns={columns}
            data={data?.data ?? []}
            getRowId={(row) => row.id}
            isLoading={isLoading}
            emptyMessage={<Trans>No audit events found.</Trans>}
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
