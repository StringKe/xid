// platform console organization 列表页:搜索/过滤/状态 + cursor 分页。
// 调 GET /v1/platform/organizations?q=&cursor=&limit=20(TanStack Query + DataTable)。
// 全宽锚定版式:零 padding 壳,搜索栏与表格节各自持 gutter;hairline 分节。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { ColumnDef } from '@tanstack/react-table'
import { Alert, Badge, Button, Input } from '../../components/ui'
import type { BadgeTone } from '../../components/ui'
import { DataTable } from '../../components/ui/DataTable'
import { Pagination } from '../../components/ui/Pagination'
import { organizationDisplayName } from '../../lib/display-names'
import { Link } from '../../lib/router'
import { page } from '../../styles/product-surface.stylex'
import { tokens } from '../../styles/tokens.stylex'
import { usePlatformOrganizationsQuery } from './queries'
import type { PlatformOrganization } from './types'

const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'
const SECTION_PAD = 'clamp(1.5rem, 1.6vw, 2.5rem)'

const PLAN_TONE: Record<PlatformOrganization['plan'], BadgeTone> = {
  free: 'neutral',
  pro: 'info',
  enterprise: 'success',
}

const STATUS_TONE: Record<PlatformOrganization['status'], BadgeTone> = {
  active: 'success',
  suspended: 'warning',
  deleted: 'danger',
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
  // 搜索栏:全宽 hairline 下 + gutter
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
    flex: '1 1 280px',
    maxWidth: '24rem',
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
  paginationWrap: {
    marginTop: '0.75rem',
  },
  messageZone: {
    paddingInline: GUTTER,
    paddingBlock: '1.5rem',
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
  actionLink: {
    color: tokens['--xid-primary'],
    fontWeight: 600,
    textDecoration: {
      default: 'none',
      ':hover': 'underline',
    },
  },
  actionStack: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '0.375rem',
  },
})

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
    cell: ({ row }) => <Badge tone={STATUS_TONE[row.original.status]}>{row.original.status}</Badge>,
    meta: { width: '100px' },
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
    cell: ({ row }) => {
      const params = new URLSearchParams({
        orgId: row.original.id,
        orgName: row.original.name,
      })
      return (
        <div {...stylex.props(styles.actionStack)}>
          <Link
            to={`/console/org/auth-policy?${params.toString()}`}
            {...stylex.props(styles.actionLink)}
          >
            <Trans>Auth policy</Trans>
          </Link>
          <Link
            to={`/console/org/social-providers?${params.toString()}`}
            {...stylex.props(styles.actionLink)}
          >
            <Trans>Social providers</Trans>
          </Link>
        </div>
      )
    },
    meta: { width: '160px' },
  },
]

export default function PlatformOrganizations(): ReactNode {
  const { t } = useLingui()
  const [search, setSearch] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [cursor, setCursor] = useState<string | undefined>()
  const { data, isLoading, isError } = usePlatformOrganizationsQuery(cursor, submitted)

  function handleSearch(e: React.FormEvent): void {
    e.preventDefault()
    setCursor(undefined)
    setSubmitted(search)
  }

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.headerZone)}>
        <h1 {...stylex.props(styles.title)}>
          <Trans>Organizations</Trans>
        </h1>
      </div>

      <form onSubmit={handleSearch} role="search" {...stylex.props(styles.searchZone)}>
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

      {isError ? (
        <div {...stylex.props(styles.messageZone)}>
          <Alert tone="error">
            <Trans>Failed to load organizations. Please try again.</Trans>
          </Alert>
        </div>
      ) : (
        <section aria-labelledby="orgs-table-heading" {...stylex.props(styles.tableSection)}>
          <h2 id="orgs-table-heading" {...stylex.props(page.visuallyHidden)}>
            <Trans>Organizations table</Trans>
          </h2>
          {data ? (
            <p {...stylex.props(styles.summaryText)}>
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
            <div {...stylex.props(styles.paginationWrap)}>
              <Pagination
                nextCursor={data.nextCursor}
                loadMoreLabel={<Trans>Load more organizations</Trans>}
                onLoadMore={setCursor}
              />
            </div>
          ) : null}
        </section>
      )}
    </div>
  )
}
