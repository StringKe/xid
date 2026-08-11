// 空 query 不拉取;impersonation 选定目标 org 后 POST 启动只读会话。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { Alert, Badge, Button, EmptyState, Field, Input, Select } from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageToolbar,
} from '@xid-kit/web-ui/ui'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { organizationDisplayName } from '@xid-kit/web-ui/display-names'
import { useAuth } from '@xid-kit/web-ui/session'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { statusToneFor, useGlobalUserStatusLabel } from '@xid-kit/web-ui/enum-labels'
import {
  submitImpersonationHandoff,
  type ImpersonationStartResponse,
} from '../../lib/impersonation-handoff'
import { useGlobalUsersQuery } from './queries'
import type { GlobalUser } from './types'

const styles = stylex.create({
  searchForm: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    gap: '0.75rem',
    width: '100%',
  },
  searchInputWrap: {
    flex: '1 1 320px',
    maxWidth: '32rem',
  },
  userEmail: {
    fontWeight: 500,
    color: tokens['--xid-fg'],
  },
  userName: {
    fontSize: '0.75rem',
    color: tokens['--xid-muted-foreground'],
  },
  organizationList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
  },
})

export default function PlatformUsers(): ReactNode {
  const { t } = useLingui()
  const { api } = useAuth()
  const globalUserStatusLabel = useGlobalUserStatusLabel()
  const [search, setSearch] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [cursor, setCursor] = useState<string | undefined>()
  const [pendingUser, setPendingUser] = useState<GlobalUser | null>(null)
  const [targetOrganizationId, setTargetOrganizationId] = useState('')
  const [organizationSelectionError, setOrganizationSelectionError] = useState(false)
  const [startingUserId, setStartingUserId] = useState<string | null>(null)
  const [impersonationError, setImpersonationError] = useState(false)
  const { data, isLoading, isError } = useGlobalUsersQuery(submitted, cursor)
  const columns: ColumnDef<GlobalUser>[] = [
    {
      id: 'email',
      header: () => <Trans>Email</Trans>,
      cell: ({ row }) => (
        <div>
          <div {...stylex.props(styles.userEmail)}>{row.original.email}</div>
          {row.original.name ? (
            <div {...stylex.props(styles.userName)}>{row.original.name}</div>
          ) : null}
        </div>
      ),
    },
    {
      id: 'organization',
      header: () => <Trans>Organization</Trans>,
      cell: ({ row }) =>
        row.original.organizations.length > 0 ? (
          <div {...stylex.props(styles.organizationList)}>
            {row.original.organizations.map((organization) => (
              <span key={organization.id}>{organizationDisplayName(organization)}</span>
            ))}
          </div>
        ) : (
          <span {...stylex.props(consoleShell.muted)}>{t`No organizations`}</span>
        ),
      meta: { width: '160px' },
    },
    {
      id: 'status',
      header: () => <Trans>Status</Trans>,
      cell: ({ row }) => (
        <Badge tone={statusToneFor(row.original.status)}>
          {globalUserStatusLabel(row.original.status)}
        </Badge>
      ),
      meta: { width: '100px' },
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
      cell: ({ row }) =>
        row.original.status === 'active' && row.original.organizations.length > 0 ? (
          <Button
            variant="secondary"
            isLoading={startingUserId === row.original.id}
            onClick={() => {
              setImpersonationError(false)
              setTargetOrganizationId('')
              setOrganizationSelectionError(false)
              setPendingUser(row.original)
            }}
            {...stylex.props(consoleShell.actionButton)}
          >
            <Trans>Impersonate</Trans>
          </Button>
        ) : null,
      meta: { width: '140px' },
    },
  ]

  function handleSearch(e: React.FormEvent): void {
    e.preventDefault()
    setCursor(undefined)
    setSubmitted(search)
  }

  async function startImpersonation(): Promise<void> {
    if (!pendingUser || startingUserId) return
    const targetOrganization = pendingUser.organizations.find(
      (organization) => organization.id === targetOrganizationId,
    )
    if (!targetOrganization) {
      setOrganizationSelectionError(true)
      return
    }
    setStartingUserId(pendingUser.id)
    setImpersonationError(false)
    const result = await api.post<ImpersonationStartResponse>('/v1/platform/impersonation/start', {
      userId: pendingUser.id,
      organizationId: targetOrganization.id,
    })
    if (!result.ok || !submitImpersonationHandoff(result.value.handoff)) {
      setStartingUserId(null)
      setImpersonationError(true)
    }
  }

  return (
    <ConsolePage
      title={<Trans>Global user search</Trans>}
      lead={
        <Trans>
          Search users across all organizations. Access is logged for GDPR compliance. Results are
          limited to authenticated platform admins.
        </Trans>
      }
    >
      {isError ? (
        <ConsolePageNotice>
          <Alert tone="error">
            <Trans>Failed to search users. Please try again.</Trans>
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
              placeholder={t`Search by email or name`}
              aria-label={t`Search users across all organizations`}
            />
          </div>
          <Button type="submit" variant="secondary">
            <Trans>Search</Trans>
          </Button>
        </form>
      </ConsolePageToolbar>

      {!submitted ? (
        <ConsolePageSection>
          <EmptyState title={<Trans>Enter a search query to find users.</Trans>} />
        </ConsolePageSection>
      ) : (
        <ConsolePageSection title={<Trans>Users</Trans>}>
          {data ? (
            <p {...stylex.props(consoleShell.selectorSummary)}>
              <Trans>{data.total} users found</Trans>
            </p>
          ) : null}
          <DataTable
            columns={columns}
            data={data?.data ?? []}
            getRowId={(row) => row.id}
            isLoading={isLoading}
            emptyMessage={<Trans>No users found matching your query.</Trans>}
          />
          {data ? (
            <Pagination
              nextCursor={data.nextCursor}
              loadMoreLabel={<Trans>Load more</Trans>}
              onLoadMore={setCursor}
            />
          ) : null}
        </ConsolePageSection>
      )}

      {pendingUser ? (
        <ConfirmDialog
          title={<Trans>Start impersonation session?</Trans>}
          description={
            <Trans>
              Open a 15-minute read-only session as {pendingUser.email}. The target organization is
              fixed, and management changes are blocked.
            </Trans>
          }
          confirmLabel={<Trans>Open read-only session</Trans>}
          confirmVariant="primary"
          isLoading={startingUserId === pendingUser.id}
          onConfirm={() => void startImpersonation()}
          onCancel={() => {
            if (startingUserId) return
            setPendingUser(null)
            setTargetOrganizationId('')
            setOrganizationSelectionError(false)
            setImpersonationError(false)
          }}
        >
          <Field
            label={t`Organization`}
            required
            error={organizationSelectionError ? t`Select organization` : undefined}
          >
            <Select
              value={targetOrganizationId}
              onChange={(event) => {
                setTargetOrganizationId(event.currentTarget.value)
                setOrganizationSelectionError(false)
              }}
            >
              <option disabled value="">
                <Trans>Select organization</Trans>
              </option>
              {pendingUser.organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organizationDisplayName(organization)}
                </option>
              ))}
            </Select>
          </Field>
          {impersonationError ? (
            <Alert tone="error">
              <Trans>The impersonation session could not be started. Try again.</Trans>
            </Alert>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </ConsolePage>
  )
}
