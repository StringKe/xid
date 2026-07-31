import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { ColumnDef } from '@tanstack/react-table'
import { Alert, Badge, Button, Field, Input } from '@xid-kit/web-ui/ui'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { useAuth } from '@xid-kit/web-ui/session'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { controlPlaneStyles as styles } from '../control-plane.styles'
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
          <code {...stylex.props(styles.mono)}>{row.original.userId}</code>
          {row.original.userId === user?.id ? (
            <div {...stylex.props(styles.muted)}>
              <Trans>Current user</Trans>
            </div>
          ) : null}
        </div>
      ),
    },
    {
      id: 'tenant',
      header: () => <Trans>Tenant ID</Trans>,
      cell: ({ row }) => <code {...stylex.props(styles.mono)}>{row.original.tenantId}</code>,
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
            {...stylex.props(styles.actionButton)}
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
          <code {...stylex.props(styles.mono)}>{row.original.id}</code>
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
      cell: ({ row }) => <Badge tone="neutral">{userStatusLabel(row.original.status)}</Badge>,
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
          {...stylex.props(styles.actionButton)}
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
    <div {...stylex.props(styles.root)}>
      <header {...stylex.props(styles.header)}>
        <h1 {...stylex.props(styles.title)}>
          <Trans>Instance managers</Trans>
        </h1>
        <p {...stylex.props(styles.lead)}>
          <Trans>
            Instance managers administer platform-wide settings and cross-tenant operations. The
            current user cannot revoke their own assignment, and the server always preserves at
            least one instance manager.
          </Trans>
        </p>
      </header>

      {createAssignment.error || deleteAssignment.error ? (
        <div {...stylex.props(styles.message)}>
          <Alert tone="error">{(createAssignment.error ?? deleteAssignment.error)?.message}</Alert>
        </div>
      ) : null}

      <section aria-labelledby="instance-managers-heading" {...stylex.props(styles.section)}>
        <div {...stylex.props(styles.sectionStack)}>
          <div {...stylex.props(styles.sectionHeadingRow)}>
            <h2 id="instance-managers-heading" {...stylex.props(page.sectionLabel)}>
              <Trans>Active instance managers</Trans>
            </h2>
            {assignments.data ? (
              <p {...stylex.props(styles.selectorSummary)}>
                <Trans>{assignments.data.total} instance managers</Trans>
              </p>
            ) : null}
          </div>
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
        </div>
      </section>

      <section aria-labelledby="find-manager-heading" {...stylex.props(styles.createSection)}>
        <div {...stylex.props(styles.sectionMeta)}>
          <h2 id="find-manager-heading" {...stylex.props(page.sectionLabel)}>
            <Trans>Grant instance access</Trans>
          </h2>
          <p {...stylex.props(styles.sectionDescription)}>
            <Trans>
              Search active users first, then select a result. You can also enter an exact user ID
              when the user is not in the current result page.
            </Trans>
          </p>
        </div>
        <div {...stylex.props(styles.controls)}>
          <form onSubmit={handleSearch} role="search" {...stylex.props(styles.formActions)}>
            <div {...stylex.props(styles.toolbarField)}>
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

          <form onSubmit={(event) => void handleGrant(event)} {...stylex.props(styles.formActions)}>
            <div {...stylex.props(styles.toolbarField)}>
              <Field
                label={<Trans>User ID</Trans>}
                required
                error={
                  isSelfSelection ? t`You cannot grant instance access to yourself.` : undefined
                }
                hint={
                  <Trans>Select a search result or enter the exact ID of an active user.</Trans>
                }
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
        </div>
      </section>

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
    </div>
  )
}
