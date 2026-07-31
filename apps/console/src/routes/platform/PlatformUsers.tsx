// platform console 全局用户搜索页:跨 organization 搜索用户。调 GET /v1/platform/users?q=。
// 搜索触发才拉取(enabled:!query 防空查询);GDPR:仅 Instance Manager 可访问。
// 全宽锚定版式:零 padding 壳,搜索栏与结果节各自持 gutter;hairline 分节。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { ColumnDef } from '@tanstack/react-table'
import { Alert, Badge, Button, EmptyState, Input } from '@xid-kit/web-ui/ui'
import type { BadgeTone } from '@xid-kit/web-ui/ui'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { organizationDisplayName } from '@xid-kit/web-ui/display-names'
import { useAuth } from '@xid-kit/web-ui/session'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import {
  submitImpersonationHandoff,
  type ImpersonationStartResponse,
} from '../../lib/impersonation-handoff'
import { useGlobalUsersQuery } from './queries'
import type { GlobalUser } from './types'

const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'
const SECTION_PAD = 'clamp(1.5rem, 1.6vw, 2.5rem)'

const STATUS_TONE: Record<GlobalUser['status'], BadgeTone> = {
  active: 'success',
  inactive: 'neutral',
  banned: 'danger',
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
  titleLead: {
    margin: '0.375rem 0 0',
    fontSize: '0.875rem',
    lineHeight: 1.55,
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
  },
  searchZone: {
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.75rem',
  },
  searchInputWrap: {
    flex: '1 1 320px',
    maxWidth: '32rem',
  },
  tableSection: {
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
  },
  summaryText: {
    margin: '0 0 1rem',
    fontSize: '0.8125rem',
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font-mono'],
    letterSpacing: '0.04em',
  },
  messageZone: {
    paddingInline: GUTTER,
    paddingBlock: '1.5rem',
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
  dialogControl: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
    marginTop: '1rem',
    color: tokens['--xid-fg'],
  },
  dialogLabel: {
    fontSize: '0.8125rem',
    fontWeight: 600,
  },
  dialogSelect: {
    width: '100%',
    minHeight: '2.625rem',
    paddingInline: '0.75rem',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    borderRadius: tokens['--xid-radius-sm'],
    backgroundColor: tokens['--xid-bg'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: '0.9375rem',
  },
  dialogSelectError: {
    borderColor: tokens['--xid-danger'],
  },
  dialogError: {
    color: tokens['--xid-danger'],
    fontSize: '0.75rem',
  },
})

const baseColumns: ColumnDef<GlobalUser>[] = [
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
        '-'
      ),
    meta: { width: '160px' },
  },
  {
    id: 'status',
    header: () => <Trans>Status</Trans>,
    cell: ({ row }) => <Badge tone={STATUS_TONE[row.original.status]}>{row.original.status}</Badge>,
    meta: { width: '100px' },
  },
  {
    id: 'created',
    header: () => <Trans>Created</Trans>,
    cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString(),
    meta: { width: '120px' },
  },
]

export default function PlatformUsers(): ReactNode {
  const { t } = useLingui()
  const { api } = useAuth()
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
    ...baseColumns,
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
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.headerZone)}>
        <h1 {...stylex.props(styles.title)}>
          <Trans>Global user search</Trans>
        </h1>
        <p {...stylex.props(styles.titleLead)}>
          <Trans>
            Search users across all organizations. Access is logged for GDPR compliance. Results are
            limited to authenticated platform admins.
          </Trans>
        </p>
      </div>

      <form onSubmit={handleSearch} role="search" {...stylex.props(styles.searchZone)}>
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

      {!submitted ? (
        <div {...stylex.props(styles.messageZone)}>
          <EmptyState title={<Trans>Enter a search query to find users.</Trans>} />
        </div>
      ) : isError ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="error">
            <Trans>Failed to search users. Please try again.</Trans>
          </Alert>
        </div>
      ) : (
        <section aria-labelledby="users-table-heading" {...stylex.props(styles.tableSection)}>
          <h2 id="users-table-heading" {...stylex.props(page.visuallyHidden)}>
            <Trans>User search results</Trans>
          </h2>
          {data ? (
            <p {...stylex.props(styles.summaryText)}>
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
        </section>
      )}
      {pendingUser ? (
        <ConfirmDialog
          title={<Trans>Start impersonation session?</Trans>}
          description={
            <>
              <Trans>
                Open a 15-minute read-only session as {pendingUser.email}. The target organization
                is fixed, and management changes are blocked.
              </Trans>
              <span {...stylex.props(styles.dialogControl)}>
                <label htmlFor="impersonation-organization" {...stylex.props(styles.dialogLabel)}>
                  <Trans>Organization</Trans>
                </label>
                <select
                  id="impersonation-organization"
                  aria-invalid={organizationSelectionError}
                  value={targetOrganizationId}
                  onChange={(event) => {
                    setTargetOrganizationId(event.currentTarget.value)
                    setOrganizationSelectionError(false)
                  }}
                  {...stylex.props(
                    styles.dialogSelect,
                    organizationSelectionError && styles.dialogSelectError,
                  )}
                >
                  <option disabled value="">
                    <Trans>Select organization</Trans>
                  </option>
                  {pendingUser.organizations.map((organization) => (
                    <option key={organization.id} value={organization.id}>
                      {organizationDisplayName(organization)}
                    </option>
                  ))}
                </select>
                {organizationSelectionError ? (
                  <span role="alert" {...stylex.props(styles.dialogError)}>
                    <Trans>Select organization</Trans>
                  </span>
                ) : null}
              </span>
              {impersonationError ? (
                <>
                  {' '}
                  <Trans>The impersonation session could not be started. Try again.</Trans>
                </>
              ) : null}
            </>
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
        />
      ) : null}
    </div>
  )
}
