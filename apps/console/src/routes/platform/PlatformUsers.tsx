// 平台用户:不输入也按最近登录倒序浏览全部账户,检索、组织与状态筛选写进 URL,游标分页上一页 / 下一页。
// 行菜单:模拟登录(只读 15 分钟,目标组织固定)、查看所属组织、复制用户 ID。

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { GlobalUserStatus } from '@xid-kit/types'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { organizationDisplayName } from '@xid-kit/web-ui/display-names'
import { useAuth } from '@xid-kit/web-ui/session'
import { useLocation, useNavigate, useSearchParams } from '@xid-kit/web-ui/tanstack-router'
import {
  Alert,
  Badge,
  Button,
  Dropdown,
  Field,
  Icon,
  IdentityCell,
  Select,
  useToast,
} from '@xid-kit/web-ui/ui'
import type { BadgeTone, DropdownItem } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import type { DataTableColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import { page as pageStyles } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { leading, text } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { PageFrame } from '../../components/page/PageFrame'
import { list } from '../../components/page/list-styles'
import { detail } from '../../components/page/detail-styles'
import {
  submitImpersonationHandoff,
  type ImpersonationStartResponse,
} from '../../lib/impersonation-handoff'
import { formatRelative } from '../users/user-format'
import { usePlatformOrganizationsList } from './queries'
import { usePlatformOrganizationDetail, usePlatformUsersPage } from './orgs-users-queries'
import type { PlatformUserListItem, UserListFilters } from './orgs-users-queries'

const STATUS_OPTIONS: readonly GlobalUserStatus[] = ['active', 'banned', 'inactive']
const SEARCH_DEBOUNCE_MS = 300

const STATUS_LABELS: Record<GlobalUserStatus, MessageDescriptor> = {
  active: msg`Active`,
  banned: msg`Suspended`,
  inactive: msg`Inactive`,
}

const STATUS_TONES: Record<GlobalUserStatus, BadgeTone> = {
  active: 'success',
  banned: 'danger',
  inactive: 'neutral',
}

const styles = stylex.create({
  danger: {
    color: tokens['--xid-danger'],
  },
  separator: {
    width: '1px',
    height: '0.875rem',
    backgroundColor: tokens['--xid-border'],
  },
  facts: {
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  fact: {
    display: 'grid',
    gridTemplateColumns: { default: '1fr', '@media (min-width: 48rem)': '7rem minmax(0, 1fr)' },
    gap: '0.25rem 1rem',
    paddingBlock: '0.75rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  factLabel: {
    fontSize: text.sm,
    color: tokens['--xid-muted-foreground'],
  },
  factValue: {
    margin: 0,
    fontSize: text.base,
    lineHeight: leading.body,
  },
})

function readFilters(params: URLSearchParams): UserListFilters {
  const status = params.get('status')
  return {
    q: params.get('q') ?? '',
    organizationId: params.get('organizationId'),
    status: STATUS_OPTIONS.includes(status as GlobalUserStatus)
      ? (status as GlobalUserStatus)
      : null,
  }
}

function writeFilters(filters: UserListFilters): string {
  const next = new URLSearchParams()
  if (filters.q) next.set('q', filters.q)
  if (filters.organizationId) next.set('organizationId', filters.organizationId)
  if (filters.status) next.set('status', filters.status)
  const query = next.toString()
  return query ? `?${query}` : ''
}

function displayName(user: PlatformUserListItem): string {
  return user.name ?? (user.email || user.id)
}

function canImpersonate(user: PlatformUserListItem): boolean {
  return (
    user.status === 'active' &&
    user.organizationStatus === 'active' &&
    user.organizations.length > 0
  )
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
        placeholder={t`Email, phone, external ID or user ID`}
        aria-label={t`Search users across all organizations`}
        {...stylex.props(list.searchInput)}
      />
    </label>
  )
}

function OrganizationFilter({
  value,
  onChange,
}: {
  value: string | null
  onChange: (value: string | null) => void
}): ReactNode {
  const { t } = useLingui()
  const organizations = usePlatformOrganizationsList('')
  const selected = usePlatformOrganizationDetail(value ?? '')
  const options = organizations.data?.data ?? []
  return (
    <Dropdown
      ariaLabel={t`Organization`}
      align="start"
      triggerStyle={list.filterButton}
      trigger={
        <>
          <span>{t`Organization`}</span>
          {value ? (
            <span {...stylex.props(list.filterValue)}>
              {selected.data ? organizationDisplayName(selected.data) : value}
            </span>
          ) : null}
          <Icon name="caret-down" size={12} />
        </>
      }
      items={[
        { key: 'any', label: t`Any`, checked: value === null, onSelect: () => onChange(null) },
        ...options.map((organization) => ({
          key: organization.id,
          label: organizationDisplayName(organization),
          checked: value === organization.id,
          onSelect: () => onChange(organization.id),
        })),
      ]}
    />
  )
}

function StatusFilter({
  value,
  onChange,
}: {
  value: GlobalUserStatus | null
  onChange: (value: GlobalUserStatus | null) => void
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
            <span {...stylex.props(list.filterValue)}>{i18n._(STATUS_LABELS[value])}</span>
          ) : null}
          <Icon name="caret-down" size={12} />
        </>
      }
      items={[
        { key: 'any', label: t`Any`, checked: value === null, onSelect: () => onChange(null) },
        ...STATUS_OPTIONS.map((status) => ({
          key: status,
          label: i18n._(STATUS_LABELS[status]),
          checked: value === status,
          onSelect: () => onChange(status),
        })),
      ]}
    />
  )
}

function OrganizationCell({ user }: { user: PlatformUserListItem }): ReactNode {
  const name = user.organizationName ?? user.tenantId
  if (user.organizationStatus === 'active') return name
  return (
    <span {...stylex.props(list.cellStack)}>
      <span>{name}</span>
      <span {...stylex.props(list.cellSub, styles.danger)}>
        {user.organizationStatus === 'suspended' ? (
          <Trans>Organization suspended</Trans>
        ) : (
          <Trans>Organization deleted</Trans>
        )}
      </span>
    </span>
  )
}

function IdentitySecondary({ user }: { user: PlatformUserListItem }): ReactNode {
  const organization = user.organizationName ?? user.tenantId
  return (
    <>
      <span {...stylex.props(list.hideNarrow)}>{user.email || user.id}</span>
      <span
        {...stylex.props(list.onlyNarrow, user.organizationStatus !== 'active' && styles.danger)}
      >
        {user.organizationStatus === 'suspended' ? (
          <Trans>{organization}, suspended</Trans>
        ) : (
          organization
        )}
      </span>
    </>
  )
}

function useColumns(
  onImpersonate: (user: PlatformUserListItem) => void,
  onOpenOrganization: (user: PlatformUserListItem) => void,
  onCopyId: (user: PlatformUserListItem) => void,
): DataTableColumnDef<PlatformUserListItem>[] {
  const { t, i18n } = useLingui()
  return [
    {
      id: 'user',
      header: () => t`User`,
      cell: ({ row }) => (
        <IdentityCell
          name={displayName(row.original)}
          secondary={<IdentitySecondary user={row.original} />}
          avatarName={displayName(row.original)}
        />
      ),
      meta: { priority: 'primary', width: '34%' },
    },
    {
      id: 'organization',
      header: () => t`Organization`,
      cell: ({ row }) => <OrganizationCell user={row.original} />,
      meta: { hidden: { narrow: true, regular: false } },
    },
    {
      id: 'status',
      header: () => t`Status`,
      cell: ({ row }) => (
        <Badge tone={STATUS_TONES[row.original.status]}>
          {i18n._(STATUS_LABELS[row.original.status])}
        </Badge>
      ),
      meta: { priority: 'primary', width: '8rem' },
    },
    {
      id: 'last',
      header: () => (
        <span>
          <Trans>Last sign-in</Trans> <Icon name="caret-down" size={12} />
        </span>
      ),
      cell: ({ row }) => (
        <span {...stylex.props(list.numeric)}>
          {formatRelative(i18n, row.original.lastSignInAt) ?? (
            <span {...stylex.props(list.muted)}>{t`Never`}</span>
          )}
        </span>
      ),
      meta: { align: 'end', hidden: { narrow: true, regular: false } },
    },
    {
      id: 'menu',
      header: () => <span {...stylex.props(pageStyles.visuallyHidden)}>{t`Actions`}</span>,
      cell: ({ row }) => {
        const user = row.original
        const name = displayName(user)
        const organization = user.organizationName ?? user.tenantId
        const items: DropdownItem[] = [
          ...(canImpersonate(user)
            ? [
                {
                  key: 'impersonate',
                  label: t`Impersonate ${name}…`,
                  onSelect: () => onImpersonate(user),
                },
              ]
            : []),
          {
            key: 'organization',
            label: t`View ${organization} details`,
            onSelect: () => onOpenOrganization(user),
          },
          { key: 'copy', label: t`Copy user ID`, onSelect: () => onCopyId(user) },
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

function ImpersonationDialog({
  user,
  onClose,
}: {
  user: PlatformUserListItem
  onClose: () => void
}): ReactNode {
  const { t } = useLingui()
  const { api } = useAuth()
  const [organizationId, setOrganizationId] = useState(
    user.organizations.length === 1 ? (user.organizations[0]?.id ?? '') : '',
  )
  const [selectionError, setSelectionError] = useState(false)
  const [starting, setStarting] = useState(false)
  const [failed, setFailed] = useState(false)
  const name = displayName(user)
  const firstName = user.name?.split(' ')[0] ?? name
  const email = user.email || user.id
  const tenantName = user.organizationName ?? user.tenantId
  const target = user.organizations.find((organization) => organization.id === organizationId)
  const targetName = target ? organizationDisplayName(target) : tenantName

  async function start(): Promise<void> {
    if (starting) return
    if (!target) {
      setSelectionError(true)
      return
    }
    setStarting(true)
    setFailed(false)
    const result = await api.post<ImpersonationStartResponse>('/v1/platform/impersonation/start', {
      userId: user.id,
      organizationId: target.id,
    })
    if (!result.ok || !submitImpersonationHandoff(result.value.handoff)) {
      setStarting(false)
      setFailed(true)
    }
  }

  const facts: { key: string; label: ReactNode; value: ReactNode }[] = [
    {
      key: 'access',
      label: <Trans>Access</Trans>,
      value: (
        <Trans>
          Read-only. You can open pages; saving, signing in elsewhere and token exchange are
          refused.
        </Trans>
      ),
    },
    {
      key: 'duration',
      label: <Trans>Duration</Trans>,
      value: (
        <Trans>15 minutes, then it ends on its own. You can end it sooner from the banner.</Trans>
      ),
    },
    {
      key: 'scope',
      label: <Trans>Scope</Trans>,
      value: <Trans>{targetName} only. Other organizations stay out of reach.</Trans>,
    },
    {
      key: 'visibility',
      label: <Trans>Visibility</Trans>,
      value: (
        <Trans>
          {firstName} sees an Impersonation session on their Devices page. Start and end are
          recorded in the platform audit log.
        </Trans>
      ),
    },
  ]

  return (
    <ConfirmDialog
      title={<Trans>Impersonate {name}</Trans>}
      description={
        <Trans>
          {email} in {tenantName}
        </Trans>
      }
      confirmLabel={<Trans>Start impersonation</Trans>}
      confirmVariant="primary"
      position={{ narrow: 'fullscreen', regular: 'center' }}
      isLoading={starting}
      error={
        failed ? (
          <Trans>The impersonation session could not be started. Try again.</Trans>
        ) : undefined
      }
      onConfirm={() => void start()}
      onCancel={() => {
        if (!starting) onClose()
      }}
    >
      {user.organizations.length > 1 ? (
        <Field
          label={t`Organization`}
          required
          error={selectionError ? t`Select the organization to open` : undefined}
        >
          <Select
            value={organizationId}
            onChange={(event) => {
              setOrganizationId(event.currentTarget.value)
              setSelectionError(false)
            }}
          >
            <option disabled value="">
              {t`Select organization`}
            </option>
            {user.organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>
                {organizationDisplayName(organization)}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <dl {...stylex.props(styles.facts)}>
        {facts.map((fact) => (
          <div key={fact.key} {...stylex.props(styles.fact)}>
            <dt {...stylex.props(styles.factLabel)}>{fact.label}</dt>
            <dd {...stylex.props(styles.factValue)}>{fact.value}</dd>
          </div>
        ))}
      </dl>
    </ConfirmDialog>
  )
}

export default function PlatformUsers(): ReactNode {
  const { t } = useLingui()
  const [params] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const filters = readFilters(params)
  const handoffFailed = params.get('impersonation') === 'failed'
  const [cursors, setCursors] = useState<(string | null)[]>([null])
  const users = usePlatformUsersPage(filters, cursors.at(-1) ?? null)
  const [pendingUser, setPendingUser] = useState<PlatformUserListItem | null>(null)
  const { notify } = useToast()

  function updateFilters(next: UserListFilters): void {
    setCursors([null])
    navigate(`${location.pathname}${writeFilters(next)}`, { replace: true })
  }
  const columns = useColumns(
    setPendingUser,
    (user) =>
      navigate(
        `/console/platform/organizations?organizationId=${encodeURIComponent(user.tenantId)}`,
      ),
    (user) => void copyUserId(user.id),
  )

  async function copyUserId(userId: string): Promise<void> {
    try {
      await globalThis.navigator.clipboard.writeText(userId)
      notify({ title: t`User ID copied` })
    } catch (error) {
      console.error('Clipboard write failed', error)
      notify({ title: t`The browser blocked copying. The user ID is ${userId}` })
    }
  }
  const page = users.data
  const filtered = filters.q !== '' || filters.organizationId !== null || filters.status !== null

  return (
    <PageFrame
      title={<Trans>Users</Trans>}
      lead={
        <Trans>
          Accounts across every organization on this instance. The same email can belong to separate
          accounts in different organizations.
        </Trans>
      }
    >
      {handoffFailed ? (
        <Alert tone="error">
          <Trans>
            The impersonation link expired or was already used. Start a new impersonation session
            from this page.
          </Trans>
        </Alert>
      ) : null}
      <div {...stylex.props(list.bar)}>
        <SearchBox value={filters.q} onChange={(q) => updateFilters({ ...filters, q })} />
        <span {...stylex.props(list.hideNarrow)}>
          <OrganizationFilter
            value={filters.organizationId}
            onChange={(organizationId) => updateFilters({ ...filters, organizationId })}
          />
        </span>
        <StatusFilter
          value={filters.status}
          onChange={(status) => updateFilters({ ...filters, status })}
        />
      </div>
      {page ? (
        <div {...stylex.props(list.summaryRow)}>
          <span {...stylex.props(list.summary)}>
            <Plural value={page.total} one="# user" other="# users" />
          </span>
          <span aria-hidden="true" {...stylex.props(styles.separator, list.hideNarrow)} />
          <span {...stylex.props(list.footnote, list.hideNarrow)}>
            <Trans>Impersonation is read-only and lasts 15 minutes</Trans>
          </span>
        </div>
      ) : null}
      {users.isError && !page ? (
        <section {...stylex.props(detail.section)}>
          <Alert tone="error" title={<Trans>Users could not be loaded</Trans>}>
            <Trans>Your search and filters are kept and nothing was changed.</Trans>
          </Alert>
          <div>
            <Button variant="secondary" onClick={() => void users.refetch()}>
              <Trans>Try again</Trans>
            </Button>
          </div>
        </section>
      ) : (
        <>
          <DataTable
            columns={columns}
            data={page?.data ?? []}
            getRowId={(row) => row.id}
            isLoading={users.isLoading}
            density="comfortable"
            narrowMode="priority"
            caption={t`Users`}
            captionDisplay="hidden"
            emptyMessage={
              filtered ? (
                <span {...stylex.props(list.footnote)}>
                  <Trans>No users match these filters.</Trans>{' '}
                  <button
                    type="button"
                    onClick={() => updateFilters({ q: '', organizationId: null, status: null })}
                    {...stylex.props(list.textButton)}
                  >
                    <Trans>Clear filters</Trans>
                  </button>
                </span>
              ) : (
                <Trans>No users yet.</Trans>
              )
            }
          />
          {page && (cursors.length > 1 || page.nextCursor) ? (
            <div {...stylex.props(list.footer)}>
              <p {...stylex.props(list.footnote)}>
                <Trans>Showing 50 per page, most recent sign-in first</Trans>
              </p>
              <div {...stylex.props(list.pager)}>
                <Button
                  variant="secondary"
                  disabled={cursors.length <= 1 || users.isFetching}
                  onClick={() => setCursors(cursors.slice(0, -1))}
                  {...stylex.props(list.pagerButton)}
                >
                  <Trans>Previous</Trans>
                </Button>
                <Button
                  variant="secondary"
                  disabled={!page.nextCursor || users.isFetching}
                  onClick={() => setCursors([...cursors, page.nextCursor])}
                  {...stylex.props(list.pagerButton)}
                >
                  <Trans>Next</Trans>
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
      {pendingUser ? (
        <ImpersonationDialog user={pendingUser} onClose={() => setPendingUser(null)} />
      ) : null}
    </PageFrame>
  )
}
