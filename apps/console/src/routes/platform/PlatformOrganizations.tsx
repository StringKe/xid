import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { Alert, Badge, Button, Input } from '@xid-kit/web-ui/ui'
import type { BadgeTone } from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageToolbar,
} from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { organizationDisplayName } from '@xid-kit/web-ui/display-names'
import { Link } from '@xid-kit/web-ui/tanstack-router'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { statusToneFor, useOrganizationStatusLabel } from '@xid-kit/web-ui/enum-labels'
import { usePlatformOrganizationsQuery, useUpdatePlatformOrganizationStatus } from './queries'
import type { PlatformOrganization } from './types'

const PLAN_TONE: Record<PlatformOrganization['plan'], BadgeTone> = {
  free: 'neutral',
  starter: 'warning',
  pro: 'info',
  enterprise: 'success',
}

const styles = stylex.create({
  searchForm: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    gap: '0.75rem',
    width: '100%',
  },
  searchInputWrap: {
    flex: '1 1 280px',
    maxWidth: '24rem',
  },
  organizationName: {
    fontWeight: 500,
    color: tokens['--xid-fg'],
  },
  organizationSlug: {
    fontSize: '0.75rem',
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font-mono'],
  },
  actionStack: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
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

type PendingStatusChange = {
  organization: PlatformOrganization
  status: PlatformOrganization['status']
}

export default function PlatformOrganizations(): ReactNode {
  const { t } = useLingui()
  const organizationStatusLabel = useOrganizationStatusLabel()
  const [search, setSearch] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [cursor, setCursor] = useState<string | undefined>()
  const { data, isLoading, isError } = usePlatformOrganizationsQuery(cursor, submitted)
  const updateStatus = useUpdatePlatformOrganizationStatus()
  const [pendingStatus, setPendingStatus] = useState<PendingStatusChange | null>(null)

  function handleSearch(e: React.FormEvent): void {
    e.preventDefault()
    setCursor(undefined)
    setSubmitted(search)
  }

  async function confirmStatusChange(): Promise<void> {
    if (!pendingStatus) return
    await updateStatus.mutateAsync({
      organizationId: pendingStatus.organization.id,
      status: pendingStatus.status,
    })
    setPendingStatus(null)
  }

  const columns: ColumnDef<PlatformOrganization>[] = [
    {
      id: 'name',
      header: () => <Trans>Name</Trans>,
      cell: ({ row }) => (
        <div>
          <div {...stylex.props(styles.organizationName)}>
            {organizationDisplayName(row.original)}
          </div>
          <div {...stylex.props(styles.organizationSlug)}>{row.original.slug}</div>
        </div>
      ),
    },
    {
      id: 'plan',
      header: () => <Trans>Plan</Trans>,
      cell: ({ row }) => <Badge tone={PLAN_TONE[row.original.plan]}>{row.original.plan}</Badge>,
      meta: { width: '100px' },
    },
    {
      id: 'status',
      header: () => <Trans>Status</Trans>,
      cell: ({ row }) => (
        <Badge tone={statusToneFor(row.original.status)}>
          {organizationStatusLabel(row.original.status)}
        </Badge>
      ),
      meta: { width: '110px' },
    },
    {
      id: 'users',
      header: () => <Trans>Users</Trans>,
      cell: ({ row }) => row.original.userCount.toLocaleString(),
      meta: { width: '80px' },
    },
    {
      id: 'orgs',
      header: () => <Trans>Organizations</Trans>,
      cell: ({ row }) => row.original.orgCount.toLocaleString(),
      meta: { width: '80px' },
    },
    {
      id: 'created',
      header: () => <Trans>Created</Trans>,
      cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString(),
      meta: { width: '120px' },
    },
    {
      id: 'actions',
      header: () => <Trans>Actions</Trans>,
      cell: ({ row }) => (
        <div {...stylex.props(styles.actionStack)}>
          {row.original.status === 'active' ? (
            <Button
              variant="danger"
              onClick={() => setPendingStatus({ organization: row.original, status: 'suspended' })}
              aria-label={t`Suspend ${row.original.name}`}
              {...stylex.props(consoleShell.actionButton)}
            >
              <Trans>Suspend</Trans>
            </Button>
          ) : null}
          {row.original.status === 'suspended' ? (
            <Button
              variant="secondary"
              onClick={() => setPendingStatus({ organization: row.original, status: 'active' })}
              aria-label={t`Reactivate ${row.original.name}`}
              {...stylex.props(consoleShell.actionButton)}
            >
              <Trans>Reactivate</Trans>
            </Button>
          ) : null}
          <Link
            to={`/console/platform/plans?tenantId=${encodeURIComponent(row.original.id)}`}
            {...stylex.props(styles.actionLink)}
          >
            <Trans>Plans and quotas</Trans>
          </Link>
        </div>
      ),
      meta: { width: '190px' },
    },
  ]

  return (
    <ConsolePage
      wide
      title={<Trans>Organizations</Trans>}
      lead={<Trans>Every organization on this instance, with plan and lifecycle status.</Trans>}
    >
      {isError || updateStatus.isError ? (
        <ConsolePageNotice>
          {isError ? (
            <Alert tone="error">
              <Trans>Failed to load organizations.</Trans>
            </Alert>
          ) : null}
          {updateStatus.isError ? (
            <Alert tone="error">
              <Trans>Failed to update organization status. Try again.</Trans>
            </Alert>
          ) : null}
        </ConsolePageNotice>
      ) : null}

      <ConsolePageToolbar>
        <form onSubmit={handleSearch} role="search" {...stylex.props(styles.searchForm)}>
          <div {...stylex.props(styles.searchInputWrap)}>
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t`Search by name or slug`}
              aria-label={t`Search organizations`}
            />
          </div>
          <Button type="submit" variant="secondary">
            <Trans>Search</Trans>
          </Button>
        </form>
      </ConsolePageToolbar>

      <ConsolePageSection title={<Trans>Organizations</Trans>}>
        {data ? (
          <p {...stylex.props(consoleShell.selectorSummary)}>
            <Trans>{data.total} organizations found</Trans>
          </p>
        ) : null}
        <DataTable
          columns={columns}
          data={data?.data ?? []}
          getRowId={(row) => row.id}
          isLoading={isLoading}
          emptyMessage={<Trans>No organizations found.</Trans>}
        />
        {data ? (
          <Pagination
            nextCursor={data.nextCursor}
            loadMoreLabel={<Trans>Load more organizations</Trans>}
            onLoadMore={setCursor}
          />
        ) : null}
      </ConsolePageSection>

      {pendingStatus ? (
        <ConfirmDialog
          title={
            pendingStatus.status === 'suspended' ? (
              <Trans>Suspend organization?</Trans>
            ) : (
              <Trans>Reactivate organization?</Trans>
            )
          }
          description={
            pendingStatus.status === 'suspended' ? (
              <Trans>
                {organizationDisplayName(pendingStatus.organization)} will be suspended. Members
                lose access until it is reactivated.
              </Trans>
            ) : (
              <Trans>
                {organizationDisplayName(pendingStatus.organization)} will be reactivated and
                members regain access.
              </Trans>
            )
          }
          confirmLabel={
            pendingStatus.status === 'suspended' ? (
              <Trans>Suspend</Trans>
            ) : (
              <Trans>Reactivate</Trans>
            )
          }
          confirmVariant={pendingStatus.status === 'suspended' ? 'danger' : 'primary'}
          isLoading={updateStatus.isPending}
          onConfirm={() => void confirmStatusChange()}
          onCancel={() => setPendingStatus(null)}
        />
      ) : null}
    </ConsolePage>
  )
}
