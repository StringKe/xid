import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { Alert, Badge, Button, Field, Input } from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageSplitSection,
} from '@xid-kit/web-ui/ui'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { useAuth } from '@xid-kit/web-ui/session'
import { statusToneFor } from '@xid-kit/web-ui/enum-labels'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import {
  useCreateInstanceManagerAssignment,
  useDeleteInstanceManagerAssignment,
  useGlobalUsersQuery,
  useInstanceManagerAssignmentsQuery,
} from './queries'
import type { GlobalUser, InstanceManagerAssignment } from './types'

function userStatusLabel(status: GlobalUser['status']): ReactNode {
  if (status === 'active') return <Trans>Active</Trans>
  if (status === 'inactive') return <Trans>Inactive</Trans>
  return <Trans>Banned</Trans>
}

export default function PlatformInstanceManagers(): ReactNode {
  const { t } = useLingui()
  const { user } = useAuth()
  const [cursor, setCursor] = useState<string | undefined>()
  const assignments = useInstanceManagerAssignmentsQuery(cursor)
  const createAssignment = useCreateInstanceManagerAssignment()
  const deleteAssignment = useDeleteInstanceManagerAssignment()

  const [userId, setUserId] = useState('')
  const [search, setSearch] = useState('')
  const [submittedSearch, setSubmittedSearch] = useState('')
  const users = useGlobalUsersQuery(submittedSearch)
  const [pendingRevoke, setPendingRevoke] = useState<InstanceManagerAssignment | null>(null)

  const assignmentColumns: ColumnDef<InstanceManagerAssignment>[] = [
    {
      id: 'user',
      header: () => <Trans>User ID</Trans>,
      cell: ({ row }) => (
        <div>
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
      id: 'tenant',
      header: () => <Trans>Tenant ID</Trans>,
      cell: ({ row }) => <code {...stylex.props(consoleShell.mono)}>{row.original.tenantId}</code>,
    },
    {
      id: 'granted',
      header: () => <Trans>Granted</Trans>,
      cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString(),
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
            onClick={() => setPendingRevoke(row.original)}
            aria-label={t`Revoke instance manager ${row.original.userId}`}
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

  async function handleGrant(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!userId.trim() || userId.trim() === user?.id) return
    await createAssignment.mutateAsync({ user_id: userId.trim() })
    setUserId('')
  }

  function handleSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    setSubmittedSearch(search.trim())
  }

  const isSelfSelection = userId.trim() === user?.id

  return (
    <ConsolePage
      title={<Trans>Instance managers</Trans>}
      lead={
        <Trans>
          Instance managers administer platform-wide settings and cross-tenant operations. The
          current user cannot revoke their own assignment, and the server always preserves at least
          one instance manager.
        </Trans>
      }
    >
      {createAssignment.error || deleteAssignment.error ? (
        <ConsolePageNotice>
          <Alert tone="error">
            <Trans>Failed to update instance managers. Try again.</Trans>
          </Alert>
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
            {assignments.data ? (
              <Pagination
                nextCursor={assignments.data.nextCursor}
                loadMoreLabel={<Trans>Load more instance managers</Trans>}
                onLoadMore={setCursor}
              />
            ) : null}
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
            <DataTable
              columns={userColumns}
              data={users.data?.data ?? []}
              getRowId={(candidate) => candidate.id}
              isLoading={users.isLoading}
              emptyMessage={<Trans>No users found.</Trans>}
            />
          )
        ) : null}

        <form
          onSubmit={(event) => void handleGrant(event)}
          {...stylex.props(consoleShell.formActions)}
        >
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
              User {pendingRevoke.userId} will lose platform-wide management access. The server
              rejects this operation if it would remove the final instance manager.
            </Trans>
          }
          confirmLabel={<Trans>Revoke manager</Trans>}
          isLoading={deleteAssignment.isPending}
          onConfirm={() => {
            void deleteAssignment.mutateAsync(pendingRevoke.id).then(() => setPendingRevoke(null))
          }}
          onCancel={() => setPendingRevoke(null)}
        />
      ) : null}
    </ConsolePage>
  )
}
