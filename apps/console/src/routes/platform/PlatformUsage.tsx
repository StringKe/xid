import { Trans } from '@lingui/react/macro'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { DataTableColumnDef as ColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import type { UsageOverview } from '@xid-kit/types'
import { Alert, Badge } from '@xid-kit/web-ui/ui'
import { Link } from '@xid-kit/web-ui/tanstack-router'
import { ConsolePage, ConsolePageNotice, ConsolePageSection } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { LoadMore } from '@xid-kit/web-ui/ui/LoadMore'
import { organizationDisplayName } from '@xid-kit/web-ui/display-names'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { statusToneFor, useBillingStatusLabel } from '@xid-kit/web-ui/enum-labels'
import { useBillingConfigQuery, useUsageOverviewList } from './queries'

const styles = stylex.create({
  organizationName: {
    fontWeight: weight.medium,
    color: tokens['--xid-fg'],
  },
  numericCell: {
    fontFamily: tokens['--xid-font-mono'],
    fontVariantNumeric: 'tabular-nums',
    fontSize: text.base,
  },
  actionLink: {
    color: tokens['--xid-primary'],
    fontWeight: weight.medium,
    fontSize: text.xs,
    textDecoration: {
      default: 'none',
      ':hover': 'underline',
    },
  },
})

function numericColumn(
  id: 'mau' | 'dau' | 'seatUsed',
  header: ReactNode,
  width: string,
): ColumnDef<UsageOverview> {
  return {
    id,
    header: () => header,
    cell: ({ row }) => (
      <span {...stylex.props(styles.numericCell)}>{row.original[id].toLocaleString()}</span>
    ),
    meta: { width },
  }
}

export default function PlatformUsage(): ReactNode {
  const billingStatusLabel = useBillingStatusLabel()
  const usage = useUsageOverviewList()
  const isBillingEnabled = useBillingConfigQuery().data?.enabled === true

  const billingColumn: ColumnDef<UsageOverview> = {
    id: 'billingStatus',
    header: () => <Trans>Billing status</Trans>,
    cell: ({ row }) =>
      row.original.billingStatus ? (
        <Badge tone={statusToneFor(row.original.billingStatus)}>
          {billingStatusLabel(row.original.billingStatus)}
        </Badge>
      ) : null,
    meta: { width: '120px' },
  }

  const columns: ColumnDef<UsageOverview>[] = [
    {
      id: 'organization',
      header: () => <Trans>Organization</Trans>,
      cell: ({ row }) => (
        <div {...stylex.props(styles.organizationName)}>
          {organizationDisplayName({ name: row.original.organizationName })}
        </div>
      ),
    },
    numericColumn('mau', <Trans>MAU</Trans>, '80px'),
    numericColumn('dau', <Trans>DAU</Trans>, '80px'),
    numericColumn('seatUsed', <Trans>Seats</Trans>, '100px'),
    ...(isBillingEnabled ? [billingColumn] : []),
    {
      id: 'actions',
      header: () => <Trans>Actions</Trans>,
      cell: ({ row }) => (
        <Link
          to={`/console/platform/quotas?tenantId=${encodeURIComponent(row.original.organizationId)}`}
          {...stylex.props(styles.actionLink)}
        >
          <Trans>Resource quotas</Trans>
        </Link>
      ),
      meta: { width: '130px' },
    },
  ]

  return (
    <ConsolePage
      wide
      title={isBillingEnabled ? <Trans>Usage and billing</Trans> : <Trans>Usage overview</Trans>}
      lead={
        isBillingEnabled ? (
          <Trans>Metered usage and billing status for every organization.</Trans>
        ) : (
          <Trans>Metered usage for every organization.</Trans>
        )
      }
    >
      {usage.isError ? (
        <ConsolePageNotice>
          <Alert tone="error">
            <Trans>Failed to load usage overview. Reload the page to try again.</Trans>
          </Alert>
        </ConsolePageNotice>
      ) : null}

      <ConsolePageSection>
        <h2 {...stylex.props(page.visuallyHidden)}>
          <Trans>Usage overview table</Trans>
        </h2>
        <DataTable
          columns={columns}
          data={usage.data?.data ?? []}
          getRowId={(row) => row.organizationId}
          isLoading={usage.isLoading}
          emptyMessage={<Trans>No usage data available.</Trans>}
        />
        <LoadMore query={usage} loadMoreLabel={<Trans>Load more</Trans>} />
      </ConsolePageSection>
    </ConsolePage>
  )
}
