// 平台组织列表:检索、状态筛选、创建组织;按本月 MAU 从高到低,游标分页只有上一页 / 下一页。
// 带 ?organizationId= 时显示该组织详情。状态:加载、加载失败(保留检索与筛选)、筛选无结果。

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { PlatformOrganizationStatus } from '@xid-kit/types'
import { statusToneFor, useOrganizationStatusLabel } from '@xid-kit/web-ui/enum-labels'
import { useLocation, useNavigate, useSearchParams } from '@xid-kit/web-ui/tanstack-router'
import { Badge, Button, Dropdown, EmptyState, Icon, IdentityCell } from '@xid-kit/web-ui/ui'
import type { DropdownItem } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import type { DataTableColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import { page as pageStyles } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { PageFrame } from '../../components/page/PageFrame'
import { list } from '../../components/page/list-styles'
import { formatDate } from '../../lib/date-format'
import { CreateOrganizationDialog } from './CreateOrganizationDialog'
import {
  isQuotaHigh,
  OrganizationStatusDialog,
  PLATFORM_ORGANIZATIONS_PATH,
  PlatformOrganizationDetail,
  statusActionItems,
} from './PlatformOrganizationDetail'
import type { OrganizationStatusAction } from './PlatformOrganizationDetail'
import { ORGANIZATIONS_PAGE_SIZE, usePlatformOrganizationsPage } from './orgs-users-queries'
import type { OrganizationListFilters, PlatformOrganizationListItem } from './orgs-users-queries'

const STATUS_OPTIONS: readonly PlatformOrganizationStatus[] = ['active', 'suspended', 'deleted']
const SEARCH_DEBOUNCE_MS = 300

const STATUS_FILTER_LABELS: Record<PlatformOrganizationStatus, MessageDescriptor> = {
  active: msg`Active`,
  suspended: msg`Suspended`,
  deleted: msg`Deleted`,
}

const styles = stylex.create({
  warning: {
    color: tokens['--xid-warning'],
  },
  separator: {
    width: '1px',
    height: '0.875rem',
    backgroundColor: tokens['--xid-border'],
  },
})

function readFilters(params: URLSearchParams): OrganizationListFilters {
  const status = params.get('status')
  return {
    q: params.get('q') ?? '',
    status: STATUS_OPTIONS.includes(status as PlatformOrganizationStatus)
      ? (status as PlatformOrganizationStatus)
      : null,
  }
}

function writeFilters(filters: OrganizationListFilters): string {
  const next = new URLSearchParams()
  if (filters.q) next.set('q', filters.q)
  if (filters.status) next.set('status', filters.status)
  const query = next.toString()
  return query ? `?${query}` : ''
}

function SearchBox({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}): ReactNode {
  const { t } = useLingui()
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  useEffect(() => {
    if (draft === value) return
    const timer = setTimeout(() => onChange(draft.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft, value, onChange])
  return (
    <label {...stylex.props(list.search)}>
      <span aria-hidden="true" {...stylex.props(list.searchIcon)}>
        <Icon name="search" size={16} />
      </span>
      <input
        type="search"
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        placeholder={t`Name, slug or organization ID`}
        aria-label={t`Search organizations`}
        {...stylex.props(list.searchInput)}
      />
    </label>
  )
}

function StatusFilter({
  value,
  onChange,
}: {
  value: PlatformOrganizationStatus | null
  onChange: (value: PlatformOrganizationStatus | null) => void
}): ReactNode {
  const { t, i18n } = useLingui()
  return (
    <Dropdown
      ariaLabel={t`Status`}
      align="start"
      triggerStyle={list.filterButton}
      trigger={
        <>
          <span>{t`Status`}</span>
          {value ? (
            <span {...stylex.props(list.filterValue)}>{i18n._(STATUS_FILTER_LABELS[value])}</span>
          ) : null}
          <Icon name="caret-down" size={12} />
        </>
      }
      items={[
        { key: 'any', label: t`Any`, checked: value === null, onSelect: () => onChange(null) },
        ...STATUS_OPTIONS.map((status) => ({
          key: status,
          label: i18n._(STATUS_FILTER_LABELS[status]),
          checked: value === status,
          onSelect: () => onChange(status),
        })),
      ]}
    />
  )
}

function MauCell({ organization }: { organization: PlatformOrganizationListItem }): ReactNode {
  const { i18n } = useLingui()
  const mau = i18n.number(organization.mauThisMonth)
  if (organization.status !== 'active') {
    const since = i18n.date(new Date(organization.statusChangedAt ?? organization.createdAt), {
      month: 'short',
      day: 'numeric',
    })
    return (
      <span {...stylex.props(list.cellStack)}>
        <span {...stylex.props(list.numeric)}>{mau}</span>
        <span {...stylex.props(list.cellSub)}>
          <Trans>Sign-in blocked since {since}</Trans>
        </span>
      </span>
    )
  }
  const quota = organization.mauQuota
  if (quota === null || quota <= 0) {
    return <span {...stylex.props(list.numeric)}>{mau}</span>
  }
  const percent = i18n.number(Math.round((organization.mauThisMonth / quota) * 100))
  const limit = i18n.number(quota)
  return (
    <span {...stylex.props(list.cellStack)}>
      <span {...stylex.props(list.numeric)}>{mau}</span>
      <span {...stylex.props(list.cellSub, isQuotaHigh(organization) && styles.warning)}>
        <Trans>
          {percent}% of {limit}
        </Trans>
      </span>
    </span>
  )
}

function IdentitySecondary({
  organization,
}: {
  organization: PlatformOrganizationListItem
}): ReactNode {
  const { i18n } = useLingui()
  const host = organization.primaryHost ?? organization.slug
  if (!isQuotaHigh(organization) || organization.mauQuota === null) return host
  const percent = i18n.number(Math.round((organization.mauThisMonth / organization.mauQuota) * 100))
  return (
    <>
      <span {...stylex.props(list.hideNarrow)}>{host}</span>
      <span {...stylex.props(list.onlyNarrow, styles.warning)}>
        <Trans>{percent}% of MAU quota</Trans>
      </span>
    </>
  )
}

function useColumns(
  onAction: (organization: PlatformOrganizationListItem, action: OrganizationStatusAction) => void,
  onOpen: (organization: PlatformOrganizationListItem) => void,
): DataTableColumnDef<PlatformOrganizationListItem>[] {
  const { t, i18n } = useLingui()
  const statusLabel = useOrganizationStatusLabel()
  const month = i18n.date(new Date(), { month: 'long' })
  return [
    {
      id: 'organization',
      header: () => t`Organization`,
      cell: ({ row }) => (
        <IdentityCell
          name={row.original.name}
          secondary={<IdentitySecondary organization={row.original} />}
          avatarName={row.original.name}
        />
      ),
      meta: { priority: 'primary', width: '34%' },
    },
    {
      id: 'status',
      header: () => t`Status`,
      cell: ({ row }) => (
        <Badge tone={statusToneFor(row.original.status)}>{statusLabel(row.original.status)}</Badge>
      ),
      meta: { priority: 'primary', width: '9rem' },
    },
    {
      id: 'users',
      header: () => t`Users`,
      cell: ({ row }) => (
        <span {...stylex.props(list.numeric)}>{i18n.number(row.original.userCount)}</span>
      ),
      meta: { align: 'end', hidden: { narrow: true, regular: true, sidebar: false } },
    },
    {
      id: 'mau',
      header: () => (
        <span>
          <Trans>MAU in {month}</Trans> <Icon name="caret-down" size={12} />
        </span>
      ),
      cell: ({ row }) => <MauCell organization={row.original} />,
      meta: { align: 'end', hidden: { narrow: true, regular: false } },
    },
    {
      id: 'created',
      header: () => t`Created`,
      cell: ({ row }) => (
        <span {...stylex.props(list.numeric)}>{formatDate(i18n, row.original.createdAt)}</span>
      ),
      meta: { align: 'end', hidden: { narrow: true, regular: true, sidebar: false } },
    },
    {
      id: 'menu',
      header: () => <span {...stylex.props(pageStyles.visuallyHidden)}>{t`Actions`}</span>,
      cell: ({ row }) => {
        const name = row.original.name
        const items: DropdownItem[] = [
          { key: 'open', label: t`View details`, onSelect: () => onOpen(row.original) },
          ...statusActionItems(row.original, (action) => onAction(row.original, action)).map(
            (item, index) => (index === 0 ? { ...item, separatorBefore: true } : item),
          ),
        ]
        return (
          <span
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            {...stylex.props(list.rowMenu)}
          >
            <Dropdown
              ariaLabel={t`Actions for ${name}`}
              align="end"
              triggerStyle={list.iconButton}
              trigger={<Icon name="more-horizontal" size={16} />}
              items={items}
            />
          </span>
        )
      },
      meta: { priority: 'primary', width: '3rem', align: 'end' },
    },
  ]
}

function OrganizationsList(): ReactNode {
  const { t, i18n } = useLingui()
  const [params] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const filters = readFilters(params)
  const [cursors, setCursors] = useState<(string | null)[]>([null])
  const organizations = usePlatformOrganizationsPage(filters, cursors.at(-1) ?? null)
  const [creating, setCreating] = useState(false)
  const [pending, setPending] = useState<{
    organization: PlatformOrganizationListItem
    action: OrganizationStatusAction
  } | null>(null)

  function updateFilters(next: OrganizationListFilters): void {
    setCursors([null])
    navigate(`${location.pathname}${writeFilters(next)}`, { replace: true })
  }
  function openOrganization(organization: { id: string }): void {
    navigate(`${PLATFORM_ORGANIZATIONS_PATH}?organizationId=${encodeURIComponent(organization.id)}`)
  }
  const columns = useColumns(
    (organization, action) => setPending({ organization, action }),
    openOrganization,
  )

  const page = organizations.data
  const filtered = filters.q !== '' || filters.status !== null
  const shown = i18n.number(
    (cursors.length - 1) * ORGANIZATIONS_PAGE_SIZE + (page?.data.length ?? 0),
  )
  const total = i18n.number(page?.total ?? 0)
  const suspended = page?.counts.suspended ?? 0
  const deleted = page?.counts.deleted ?? 0

  return (
    <PageFrame
      title={<Trans>Organizations</Trans>}
      lead={
        <Trans>
          Every organization on this instance, with lifecycle status. Quotas never block sign-in.
        </Trans>
      }
    >
      <div {...stylex.props(list.bar)}>
        <SearchBox value={filters.q} onChange={(q) => updateFilters({ ...filters, q })} />
        <StatusFilter
          value={filters.status}
          onChange={(status) => updateFilters({ ...filters, status })}
        />
        <div {...stylex.props(list.barEnd)}>
          <Button onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} />
            <Trans>Create organization…</Trans>
          </Button>
        </div>
      </div>
      {page ? (
        <div {...stylex.props(list.summaryRow)}>
          <span {...stylex.props(list.summary)}>
            {filtered ? (
              <Plural
                value={page.total}
                one="# organization matches"
                other="# organizations match"
              />
            ) : (
              <Plural value={page.counts.total} one="# organization" other="# organizations" />
            )}
          </span>
          {suspended + deleted > 0 ? (
            <>
              <span aria-hidden="true" {...stylex.props(styles.separator, list.hideNarrow)} />
              <span {...stylex.props(list.footnote, list.hideNarrow)}>
                <Trans>
                  {suspended} suspended, {deleted} deleted and restorable
                </Trans>
              </span>
            </>
          ) : null}
        </div>
      ) : null}
      {organizations.isError && !page ? (
        <EmptyState
          variant="load-failure"
          title={<Trans>Organizations could not be loaded</Trans>}
          description={
            <Trans>
              Your search and filters are kept and nothing was changed. Sign-in for every
              organization is not affected.
            </Trans>
          }
          action={
            <Button variant="secondary" onClick={() => void organizations.refetch()}>
              <Trans>Try again</Trans>
            </Button>
          }
        />
      ) : (
        <>
          <DataTable
            columns={columns}
            data={page?.data ?? []}
            getRowId={(row) => row.id}
            isLoading={organizations.isLoading}
            onRowClick={openOrganization}
            density="comfortable"
            narrowMode="priority"
            caption={t`Organizations`}
            captionDisplay="hidden"
            emptyMessage={
              filtered ? (
                <span {...stylex.props(list.footnote)}>
                  <Trans>No organizations match these filters.</Trans>{' '}
                  <button
                    type="button"
                    onClick={() => updateFilters({ q: '', status: null })}
                    {...stylex.props(list.textButton)}
                  >
                    <Trans>Clear filters</Trans>
                  </button>
                </span>
              ) : (
                <Trans>No organizations yet.</Trans>
              )
            }
          />
          {page && page.data.length > 0 ? (
            <div {...stylex.props(list.footer)}>
              <p {...stylex.props(list.footnote)}>
                <Trans>
                  {shown} of {total}, highest MAU first
                </Trans>
              </p>
              {cursors.length > 1 || page.nextCursor ? (
                <div {...stylex.props(list.pager)}>
                  <Button
                    variant="secondary"
                    disabled={cursors.length <= 1 || organizations.isFetching}
                    onClick={() => setCursors(cursors.slice(0, -1))}
                    {...stylex.props(list.pagerButton)}
                  >
                    <Trans>Previous</Trans>
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!page.nextCursor || organizations.isFetching}
                    onClick={() => setCursors([...cursors, page.nextCursor])}
                    {...stylex.props(list.pagerButton)}
                  >
                    <Trans>Next</Trans>
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      )}
      {creating ? (
        <CreateOrganizationDialog
          open
          onClose={() => setCreating(false)}
          onCreated={(organization) => {
            setCreating(false)
            openOrganization(organization)
          }}
        />
      ) : null}
      {pending ? (
        <OrganizationStatusDialog
          target={pending.organization}
          action={pending.action}
          onClose={() => setPending(null)}
        />
      ) : null}
    </PageFrame>
  )
}

export default function PlatformOrganizations(): ReactNode {
  const [params] = useSearchParams()
  const organizationId = params.get('organizationId')
  if (organizationId) return <PlatformOrganizationDetail organizationId={organizationId} />
  return <OrganizationsList />
}
