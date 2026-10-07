import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import { FormattedDate } from '../../components/FormattedDate'
import type { DataTableColumnDef as ColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import type { GlobalUser, InstanceManagerAssignment, XidError } from '@xid-kit/types'
import { Alert, Badge, Button, Field, Input } from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageSplitSection,
} from '@xid-kit/web-ui/ui'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { LoadMore } from '@xid-kit/web-ui/ui/LoadMore'
import { useAuth } from '@xid-kit/web-ui/session'
import { statusToneFor, useGlobalUserStatusLabel } from '@xid-kit/web-ui/enum-labels'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import {
  useCreateInstanceManagerAssignment,
  useDeleteInstanceManagerAssignment,
  useGlobalUsersList,
  useInstanceManagerAssignmentsList,
} from './queries'

function managerLabel(assignment: InstanceManagerAssignment): string {
  return assignment.email ?? assignment.displayName ?? assignment.userId
}

export default function PlatformInstanceManagers(): ReactNode {
  const { t } = useLingui()
  const { user } = useAuth()
  const userStatusLabel = useGlobalUserStatusLabel()
  const errorMessage = useApiErrorMessage()
  const assignments = useInstanceManagerAssignmentsList()
  const createAssignment = useCreateInstanceManagerAssignment()
  const deleteAssignment = useDeleteInstanceManagerAssignment()

  const [userId, setUserId] = useState('')
  const [search, setSearch] = useState('')
  const [submittedSearch, setSubmittedSearch] = useState('')
  const users = useGlobalUsersList(submittedSearch)
  const [pendingRevoke, setPendingRevoke] = useState<InstanceManagerAssignment | null>(null)

  function revokeError(error: XidError | null): string | undefined {
    if (!error) return undefined
    if (error.code === 'conflict') {
      return t`At least one instance manager must remain. The list was refreshed.`
    }
    return errorMessage(error, { surface: 'general' })
  }

  const assignmentColumns: ColumnDef<InstanceManagerAssignment>[] = [
    {
      id: 'user',
      header: () => <Trans>User</Trans>,
      cell: ({ row }) => (
        <div>
          <div>{managerLabel(row.original)}</div>
          {row.original.email && row.original.displayName ? (
            <div {...stylex.props(consoleShell.muted)}>{row.original.displayName}</div>
          ) : null}
          <code {...stylex.props(consoleShell.mono)}>{row.original.userId}</code>
          {row.original.userId === user?.id ? (
            <div {...stylex.props(consoleShell.muted)}>
              <Trans>Current user</Trans>
            </div>
          ) : null}
        </div>
      ),
    },
    {
      id: 'organization',
      header: () => <Trans>Organization</Trans>,
      cell: ({ row }) => (
        <div>
          {row.original.organizationName ? <div>{row.original.organizationName}</div> : null}
          <code {...stylex.props(consoleShell.mono)}>{row.original.tenantId}</code>
        </div>
      ),
    },
    {
      id: 'status',
      header: () => <Trans>Status</Trans>,
      cell: ({ row }) =>
        row.original.userStatus ? (
          <Badge tone={statusToneFor(row.original.userStatus)}>
            {userStatusLabel(row.original.userStatus)}
          </Badge>
        ) : null,
      meta: { width: '100px' },
    },
    {
      id: 'granted',
      header: () => <Trans>Granted</Trans>,
      cell: ({ row }) => <FormattedDate value={row.original.createdAt} />,
      meta: { width: '120px' },
    },
    {
      id: 'actions',
      header: () => <Trans>Actions</Trans>,
      cell: ({ row }) => {
        const isSelf = row.original.userId === user?.id
        const isLastManager = (assignments.data?.total ?? 0) <= 1
        return (
          <Button
            variant="danger"
            disabled={isSelf || isLastManager}
            onClick={() => {
              deleteAssignment.reset()
              setPendingRevoke(row.original)
            }}
            aria-label={t`Revoke instance manager ${managerLabel(row.original)}`}
            {...stylex.props(consoleShell.actionButton)}
          >
            <Trans>Revoke</Trans>
          </Button>
        )
      },
      meta: { width: '110px' },
    },
  ]

  const userColumns: ColumnDef<GlobalUser>[] = [
    {
      id: 'user',
      header: () => <Trans>User</Trans>,
      cell: ({ row }) => (
        <div>
          <div>{row.original.email}</div>
          <code {...stylex.props(consoleShell.mono)}>{row.original.id}</code>
        </div>
      ),
    },
    {
      id: 'organizations',
      header: () => <Trans>Organizations</Trans>,
      cell: ({ row }) => row.original.organizations.length,
      meta: { width: '120px' },
    },
    {
      id: 'status',
      header: () => <Trans>Status</Trans>,
      cell: ({ row }) => (
        <Badge tone={statusToneFor(row.original.status)}>
          {userStatusLabel(row.original.status)}
        </Badge>
      ),
      meta: { width: '100px' },
    },
    {
      id: 'actions',
      header: () => <Trans>Actions</Trans>,
      cell: ({ row }) => (
        <Button
          variant={row.original.id === userId ? 'primary' : 'secondary'}
          disabled={row.original.id === user?.id || row.original.status !== 'active'}
          onClick={() => setUserId(row.original.id)}
          {...stylex.props(consoleShell.actionButton)}
        >
          {row.original.id === userId ? <Trans>Selected</Trans> : <Trans>Select</Trans>}
        </Button>
      ),
      meta: { width: '110px' },
    },
  ]

  function handleGrant(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!userId.trim() || userId.trim() === user?.id) return
    createAssignment.mutate({ user_id: userId.trim() }, { onSuccess: () => setUserId('') })
  }

  function handleSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    setSubmittedSearch(search.trim())
  }

  function confirmRevoke(): void {
    if (!pendingRevoke) return
    deleteAssignment.mutate(pendingRevoke.id, { onSuccess: () => setPendingRevoke(null) })
  }

  const isSelfSelection = userId.trim() === user?.id

  return (
    <ConsolePage
      wide
      title={<Trans>Instance managers</Trans>}
      lead={
        <Trans>
          Instance managers administer platform-wide settings and cross-tenant operations. The
          current user cannot revoke their own assignment, and the server always preserves at least
          one instance manager.
        </Trans>
      }
    >
      {createAssignment.error ? (
        <ConsolePageNotice>
          <Alert tone="error">{errorMessage(createAssignment.error, { surface: 'general' })}</Alert>
        </ConsolePageNotice>
      ) : null}

      <ConsolePageSection
        title={<Trans>Active instance managers</Trans>}
        actions={
          assignments.data ? (
            <p {...stylex.props(consoleShell.selectorSummary)}>
              <Trans>{assignments.data.total} instance managers</Trans>
            </p>
          ) : null
        }
      >
        {assignments.isError ? (
          <Alert tone="error">
            <Trans>Failed to load instance managers.</Trans>
          </Alert>
        ) : (
          <>
            <DataTable
              columns={assignmentColumns}
              data={assignments.data?.data ?? []}
              getRowId={(assignment) => assignment.id}
              isLoading={assignments.isLoading}
              emptyMessage={<Trans>No instance managers found.</Trans>}
            />
            <LoadMore
              query={assignments}
              loadMoreLabel={<Trans>Load more instance managers</Trans>}
            />
          </>
        )}
      </ConsolePageSection>

      <ConsolePageSplitSection
        title={<Trans>Grant instance access</Trans>}
        description={
          <Trans>
            Search active users first, then select a result. You can also enter an exact user ID
            when the user is not in the current result page.
          </Trans>
        }
      >
        <form onSubmit={handleSearch} role="search" {...stylex.props(consoleShell.formActions)}>
          <div {...stylex.props(consoleShell.toolbarField)}>
            <Field label={<Trans>Search users</Trans>}>
              <Input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
                placeholder={t`Search by email or name`}
              />
            </Field>
          </div>
          <Button type="submit" variant="secondary" disabled={!search.trim()}>
            <Trans>Search</Trans>
          </Button>
        </form>

        {submittedSearch ? (
          users.isError ? (
            <Alert tone="error">
              <Trans>Failed to search users.</Trans>
            </Alert>
          ) : (
            <>
              <DataTable
                columns={userColumns}
                data={users.data?.data ?? []}
                getRowId={(candidate) => candidate.id}
                isLoading={users.isLoading}
                emptyMessage={<Trans>No users found.</Trans>}
              />
              <LoadMore query={users} loadMoreLabel={<Trans>Load more users</Trans>} />
            </>
          )
        ) : null}

        <form onSubmit={handleGrant} {...stylex.props(consoleShell.formActions)}>
          <div {...stylex.props(consoleShell.toolbarField)}>
            <Field
              label={<Trans>User ID</Trans>}
              required
              error={isSelfSelection ? t`You cannot grant instance access to yourself.` : undefined}
              hint={<Trans>Select a search result or enter the exact ID of an active user.</Trans>}
            >
              <Input
                value={userId}
                onChange={(event) => setUserId(event.currentTarget.value)}
                placeholder={t`user_...`}
              />
            </Field>
          </div>
          <Button
            type="submit"
            isLoading={createAssignment.isPending}
            disabled={!userId.trim() || isSelfSelection}
          >
            <Trans>Grant instance manager</Trans>
          </Button>
        </form>
      </ConsolePageSplitSection>

      {pendingRevoke ? (
        <ConfirmDialog
          title={<Trans>Revoke instance manager?</Trans>}
          description={
            <Trans>
              {managerLabel(pendingRevoke)} ({pendingRevoke.userId}) will lose platform-wide
              management access. The server rejects this operation if it would remove the final
              instance manager.
            </Trans>
          }
          confirmLabel={<Trans>Revoke manager</Trans>}
          isLoading={deleteAssignment.isPending}
          error={revokeError(deleteAssignment.error)}
          onConfirm={confirmRevoke}
          onCancel={() => setPendingRevoke(null)}
        />
      ) : null}
    </ConsolePage>
  )
}
