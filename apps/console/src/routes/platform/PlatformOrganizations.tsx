import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { FormattedDate } from '../../components/FormattedDate'
import type { DataTableColumnDef as ColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import { Alert, Badge, Button, Input } from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageToolbar,
} from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { LoadMore } from '@xid-kit/web-ui/ui/LoadMore'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { organizationDisplayName } from '@xid-kit/web-ui/display-names'
import { Link } from '@xid-kit/web-ui/tanstack-router'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { statusToneFor, useOrganizationStatusLabel } from '@xid-kit/web-ui/enum-labels'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import type { PlatformOrganization, XidError } from '@xid-kit/types'
import { usePlatformOrganizationsList, useUpdatePlatformOrganizationStatus } from './queries'

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
    fontWeight: weight.medium,
    color: tokens['--xid-fg'],
  },
  organizationSlug: {
    fontSize: text.xs,
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font-mono'],
  },
  organizationId: {
    fontSize: text.xs,
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font-mono'],
    userSelect: 'all',
  },
  actionStack: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
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

type PendingStatusChange = {
  organization: PlatformOrganization
  status: PlatformOrganization['status']
}

export default function PlatformOrganizations(): ReactNode {
  const { t } = useLingui()
  const organizationStatusLabel = useOrganizationStatusLabel()
  const errorMessage = useApiErrorMessage()
  const [search, setSearch] = useState('')
  const [submitted, setSubmitted] = useState('')
  const organizations = usePlatformOrganizationsList(submitted)
  const updateStatus = useUpdatePlatformOrganizationStatus()
  const [pendingStatus, setPendingStatus] = useState<PendingStatusChange | null>(null)

  function handleSearch(e: React.FormEvent): void {
    e.preventDefault()
    setSubmitted(search)
  }

  function openStatusChange(change: PendingStatusChange): void {
    updateStatus.reset()
    setPendingStatus(change)
  }

  function confirmStatusChange(): void {
    if (!pendingStatus) return
    updateStatus.mutate(
      { organizationId: pendingStatus.organization.id, status: pendingStatus.status },
      { onSuccess: () => setPendingStatus(null) },
    )
  }

  function statusChangeError(error: XidError | null): string | undefined {
    if (!error) return undefined
    if (error.code === 'conflict') {
      return t`This organization's status changed or cannot be changed. The list was refreshed.`
    }
    return errorMessage(error, { surface: 'general' })
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
          <div {...stylex.props(styles.organizationId)} title={t`Organization ID`}>
            {row.original.id}
          </div>
        </div>
      ),
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
      cell: ({ row }) => <FormattedDate value={row.original.createdAt} />,
      meta: { width: '120px' },
    },
    {
      id: 'actions',
      header: () => <Trans>Actions</Trans>,
      cell: ({ row }) => (
        <div {...stylex.props(styles.actionStack)}>
          {row.original.status === 'active' && row.original.canChangeStatus ? (
            <Button
              variant="danger"
              onClick={() => openStatusChange({ organization: row.original, status: 'suspended' })}
              aria-label={t`Suspend ${row.original.name}`}
              {...stylex.props(consoleShell.actionButton)}
            >
              <Trans>Suspend</Trans>
            </Button>
          ) : null}
          {row.original.status === 'suspended' ? (
            <Button
              variant="secondary"
              onClick={() => openStatusChange({ organization: row.original, status: 'active' })}
              aria-label={t`Reactivate ${row.original.name}`}
              {...stylex.props(consoleShell.actionButton)}
            >
              <Trans>Reactivate</Trans>
            </Button>
          ) : null}
          <Link
            to={`/console/platform/quotas?tenantId=${encodeURIComponent(row.original.id)}`}
            {...stylex.props(styles.actionLink)}
          >
            <Trans>Resource quotas</Trans>
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
      lead={<Trans>Every organization on this instance, with lifecycle status.</Trans>}
    >
      {organizations.isError ? (
        <ConsolePageNotice>
          <Alert tone="error">
            <Trans>Failed to load organizations.</Trans>
          </Alert>
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
        {organizations.data ? (
          <p {...stylex.props(consoleShell.selectorSummary)}>
            <Trans>{organizations.data.total} organizations found</Trans>
          </p>
        ) : null}
        <DataTable
          columns={columns}
          data={organizations.data?.data ?? []}
          getRowId={(row) => row.id}
          isLoading={organizations.isLoading}
          emptyMessage={<Trans>No organizations found.</Trans>}
        />
        <LoadMore query={organizations} loadMoreLabel={<Trans>Load more organizations</Trans>} />
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
          error={statusChangeError(updateStatus.error)}
          onConfirm={confirmStatusChange}
          onCancel={() => setPendingStatus(null)}
        />
      ) : null}
    </ConsolePage>
  )
}
