// platform console 计费总览页:所有 organization MAU/DAU/seat 使用/欠费状态。
// 调 GET /v1/platform/billing?cursor=&limit=20(TanStack Query + DataTable)。
// 版式走 ConsolePage 骨架(web-ui):display 页头 + hairline 分节;表格横贯 section。
// 状态 Badge 统一 statusToneFor(status) + useBillingStatusLabel(enum-labels)。

import { Trans } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { Alert, Badge } from '@xid-kit/web-ui/ui'
import { ConsolePage, ConsolePageNotice, ConsolePageSection } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { organizationDisplayName } from '@xid-kit/web-ui/display-names'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { statusToneFor, useBillingStatusLabel } from '@xid-kit/web-ui/enum-labels'
import { useBillingOverviewQuery } from './queries'
import type { BillingOverview } from './types'

const styles = stylex.create({
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

export default function PlatformBilling(): ReactNode {
  const billingStatusLabel = useBillingStatusLabel()
  const [cursor, setCursor] = useState<string | undefined>()
  const { data, isLoading, isError } = useBillingOverviewQuery(cursor)

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
        <Badge tone={statusToneFor(row.original.status)}>
          {billingStatusLabel(row.original.status)}
        </Badge>
      ),
      meta: { width: '100px' },
    },
  ]

  return (
    <ConsolePage
      title={<Trans>Billing overview</Trans>}
      lead={<Trans>Usage, seats, and billing status for every organization.</Trans>}
    >
      {isError ? (
        <ConsolePageNotice>
          <Alert tone="error">
            <Trans>Failed to load billing overview. Please try again.</Trans>
          </Alert>
        </ConsolePageNotice>
      ) : null}

      <ConsolePageSection>
        <h2 {...stylex.props(page.visuallyHidden)}>
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
          <Pagination
            nextCursor={data.nextCursor}
            loadMoreLabel={<Trans>Load more</Trans>}
            onLoadMore={setCursor}
          />
        ) : null}
      </ConsolePageSection>
    </ConsolePage>
  )
}
