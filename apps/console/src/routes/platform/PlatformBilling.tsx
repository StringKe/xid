// platform console 计费总览页:所有 organization MAU/DAU/seat 使用/欠费状态。
// 调 GET /v1/platform/billing?cursor=&limit=20(TanStack Query + DataTable)。
// 全宽锚定版式:零 padding 壳,节自持 gutter;表格横贯全宽;hairline 分节。

import { Trans } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { ColumnDef } from '@tanstack/react-table'
import { Alert, Badge } from '@xid-kit/web-ui/ui'
import type { BadgeTone } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { organizationDisplayName } from '@xid-kit/web-ui/display-names'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { useBillingOverviewQuery } from './queries'
import type { BillingOverview } from './types'

const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'
const SECTION_PAD = 'clamp(1.5rem, 1.6vw, 2.5rem)'

const BILLING_STATUS_TONE: Record<BillingOverview['status'], BadgeTone> = {
  ok: 'success',
  overdue: 'danger',
  exceeded: 'warning',
}

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
  organizationName: {
    fontWeight: 500,
    color: tokens['--xid-fg'],
  },
  organizationPlan: {
    fontSize: '0.75rem',
    color: tokens['--xid-muted-foreground'],
    textTransform: 'capitalize',
  },
  seatLimit: {
    color: tokens['--xid-muted-foreground'],
  },
  numericCell: {
    fontFamily: tokens['--xid-font-mono'],
    fontVariantNumeric: 'tabular-nums',
    fontSize: '0.875rem',
  },
})

const columns: ColumnDef<BillingOverview>[] = [
  {
    id: 'organization',
    header: () => <Trans>Organization</Trans>,
    cell: ({ row }) => (
      <div>
        <div {...stylex.props(styles.organizationName)}>
          {organizationDisplayName({ name: row.original.organizationName })}
        </div>
        <div {...stylex.props(styles.organizationPlan)}>{row.original.plan}</div>
      </div>
    ),
  },
  {
    id: 'mau',
    header: () => <Trans>MAU</Trans>,
    cell: ({ row }) => (
      <span {...stylex.props(styles.numericCell)}>{row.original.mau.toLocaleString()}</span>
    ),
    meta: { width: '80px' },
  },
  {
    id: 'dau',
    header: () => <Trans>DAU</Trans>,
    cell: ({ row }) => (
      <span {...stylex.props(styles.numericCell)}>{row.original.dau.toLocaleString()}</span>
    ),
    meta: { width: '80px' },
  },
  {
    id: 'seats',
    header: () => <Trans>Seats</Trans>,
    cell: ({ row }) => (
      <span {...stylex.props(styles.numericCell)}>
        {row.original.seatUsed.toLocaleString()}
        {row.original.seatLimit !== null ? (
          <span {...stylex.props(styles.seatLimit)}>
            {' '}
            / {row.original.seatLimit.toLocaleString()}
          </span>
        ) : null}
      </span>
    ),
    meta: { width: '100px' },
  },
  {
    id: 'status',
    header: () => <Trans>Status</Trans>,
    cell: ({ row }) => (
      <Badge tone={BILLING_STATUS_TONE[row.original.status]}>{row.original.status}</Badge>
    ),
    meta: { width: '100px' },
  },
]

export default function PlatformBilling(): ReactNode {
  const [cursor, setCursor] = useState<string | undefined>()
  const { data, isLoading, isError } = useBillingOverviewQuery(cursor)

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.headerZone)}>
        <h1 {...stylex.props(styles.title)}>
          <Trans>Billing overview</Trans>
        </h1>
      </div>

      {isError ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="error">
            <Trans>Failed to load billing overview. Please try again.</Trans>
          </Alert>
        </div>
      ) : (
        <section aria-labelledby="billing-table-heading" {...stylex.props(styles.tableSection)}>
          <h2 id="billing-table-heading" {...stylex.props(page.visuallyHidden)}>
            <Trans>Billing overview table</Trans>
          </h2>
          <DataTable
            columns={columns}
            data={data?.data ?? []}
            getRowId={(row) => row.organizationId}
            isLoading={isLoading}
            emptyMessage={<Trans>No billing data available.</Trans>}
          />
          {data ? (
            <div {...stylex.props(styles.paginationWrap)}>
              <Pagination
                nextCursor={data.nextCursor}
                loadMoreLabel={<Trans>Load more</Trans>}
                onLoadMore={setCursor}
              />
            </div>
          ) : null}
        </section>
      )}
    </div>
  )
}
