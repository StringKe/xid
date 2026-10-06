import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { DataTableColumnDef as ColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import type { BillingOverview } from '@xid-kit/types'
import { Alert, Badge } from '@xid-kit/web-ui/ui'
import { Link } from '@xid-kit/web-ui/tanstack-router'
import { ConsolePage, ConsolePageNotice, ConsolePageSection } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { LoadMore } from '@xid-kit/web-ui/ui/LoadMore'
import { organizationDisplayName } from '@xid-kit/web-ui/display-names'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { statusToneFor, useBillingStatusLabel } from '@xid-kit/web-ui/enum-labels'
import { useBillingOverviewList } from './queries'

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
  actionLink: {
    color: tokens['--xid-primary'],
    fontWeight: 600,
    fontSize: '0.75rem',
    textDecoration: {
      default: 'none',
      ':hover': 'underline',
    },
  },
})

export default function PlatformBilling(): ReactNode {
  const billingStatusLabel = useBillingStatusLabel()
  const billing = useBillingOverviewList()

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
    {
      id: 'actions',
      header: () => <Trans>Actions</Trans>,
      cell: ({ row }) => (
        <Link
          to={`/console/platform/plans?tenantId=${encodeURIComponent(row.original.organizationId)}`}
          {...stylex.props(styles.actionLink)}
        >
          <Trans>Plans and quotas</Trans>
        </Link>
      ),
      meta: { width: '130px' },
    },
  ]

  return (
    <ConsolePage
      wide
      title={<Trans>Billing overview</Trans>}
      lead={<Trans>Usage, seats, and billing status for every organization.</Trans>}
    >
      {billing.isError ? (
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
          data={billing.data?.data ?? []}
          getRowId={(row) => row.organizationId}
          isLoading={billing.isLoading}
          emptyMessage={<Trans>No billing data available.</Trans>}
        />
        <LoadMore query={billing} loadMoreLabel={<Trans>Load more</Trans>} />
      </ConsolePageSection>
    </ConsolePage>
  )
}
