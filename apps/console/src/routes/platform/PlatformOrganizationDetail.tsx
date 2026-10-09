// 平台组织详情(/console/platform/organizations?organizationId=):头部 + Actions + 模拟登录入口,
// 五个标签写进 URL。概览左侧关键属性,右侧资源配额与暂停、删除;成员、域名只读。
// 暂停、恢复、删除、还原的确认框列表页同样使用。

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { OrganizationQuota } from '@xid-kit/types'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { useApiErrorMessage } from '@xid-kit/web-ui/api-error-message'
import {
  statusToneFor,
  useOrganizationStatusLabel,
  useRoleLabel,
} from '@xid-kit/web-ui/enum-labels'
import { useAuth } from '@xid-kit/web-ui/session'
import { Link, useLocation, useNavigate, useSearchParams } from '@xid-kit/web-ui/tanstack-router'
import {
  Badge,
  Button,
  CopyButton,
  Dropdown,
  EmptyState,
  Field,
  Icon,
  IdentityCell,
  Input,
  Skeleton,
  Tabs,
} from '@xid-kit/web-ui/ui'
import type { DropdownItem } from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import type { DataTableColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import { leading, text, weight } from '@xid-kit/web-ui/styles/scale.stylex'
import { tokens } from '@xid-kit/web-ui/styles/tokens.stylex'
import { frame, PageFrame } from '../../components/page/PageFrame'
import { detail } from '../../components/page/detail-styles'
import { list } from '../../components/page/list-styles'
import { initials } from '../../components/layout/nav-model'
import { formatDate } from '../../lib/date-format'
import { useOrganizationQuotaQuery } from './queries'
import {
  useChangePlatformOrganizationStatus,
  usePlatformOrganizationDetail,
  usePlatformOrganizationDomains,
  usePlatformOrganizationMembers,
} from './orgs-users-queries'
import type {
  PlatformOrganizationDetail as OrganizationDetail,
  PlatformOrganizationListItem,
  PlatformOrganizationMember,
} from './orgs-users-queries'

export const PLATFORM_ORGANIZATIONS_PATH = '/console/platform/organizations'
const PLATFORM_USERS_PATH = '/console/platform/users'
const QUOTA_WARNING_RATIO = 0.9

export type OrganizationStatusAction = 'suspend' | 'resume' | 'delete' | 'restore'

export type StatusTarget = Pick<
  PlatformOrganizationListItem,
  'id' | 'name' | 'slug' | 'userCount' | 'status'
> & { customHostname?: string | null }

const styles = stylex.create({
  mark: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '3rem',
    height: '3rem',
    borderRadius: tokens['--xid-radius'],
    backgroundColor: tokens['--xid-muted'],
    color: tokens['--xid-muted-foreground'],
    fontSize: text.md,
    fontWeight: weight.medium,
  },
  headerActions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
    width: { default: '100%', '@media (min-width: 48rem)': 'auto' },
  },
  headerButton: {
    flex: { default: '1 1 100%', '@media (min-width: 48rem)': '0 0 auto' },
  },
  bullets: {
    margin: 0,
    paddingInlineStart: '1.25rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    fontSize: text.base,
    lineHeight: leading.body,
  },
  quotaRow: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1fr) auto',
      '@media (min-width: 48rem)': 'minmax(0, 15rem) minmax(0, 1fr) auto',
    },
    alignItems: 'center',
    gap: '0.5rem 1.5rem',
    paddingBlock: '0.75rem',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  meter: {
    gridColumn: { default: '1 / -1', '@media (min-width: 48rem)': 'auto' },
    gridRow: { default: 2, '@media (min-width: 48rem)': 'auto' },
    height: '0.375rem',
    maxWidth: { default: 'none', '@media (min-width: 48rem)': '16rem' },
    borderRadius: tokens['--xid-radius-full'],
    backgroundColor: tokens['--xid-muted'],
    overflow: 'hidden',
  },
  meterFill: {
    height: '100%',
    borderRadius: tokens['--xid-radius-full'],
    backgroundColor: tokens['--xid-muted-foreground'],
  },
  meterWarning: {
    backgroundColor: tokens['--xid-warning'],
  },
  quotaValue: {
    textAlign: 'end',
    fontVariantNumeric: 'tabular-nums',
  },
  warning: {
    fontSize: text.xs,
    color: tokens['--xid-warning'],
  },
  dangerButton: {
    color: tokens['--xid-danger'],
  },
  settingsLinks: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    marginTop: '1.25rem',
    paddingTop: '1rem',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens['--xid-border'],
  },
  wideOnly: { display: { default: 'none', '@media (min-width: 90rem)': 'block' } },
  belowWide: { display: { default: 'block', '@media (min-width: 90rem)': 'none' } },
})

function percentOf(value: number, limit: number | null): number | null {
  if (limit === null || limit <= 0) return null
  return value / limit
}

export function isQuotaHigh(
  item: Pick<PlatformOrganizationListItem, 'mauThisMonth' | 'mauQuota'>,
): boolean {
  const ratio = percentOf(item.mauThisMonth, item.mauQuota)
  return ratio !== null && ratio >= QUOTA_WARNING_RATIO
}

export function OrganizationStatusDialog({
  target,
  action,
  onClose,
}: {
  target: StatusTarget
  action: OrganizationStatusAction
  onClose: () => void
}): ReactNode {
  const { t } = useLingui()
  const errorMessage = useApiErrorMessage()
  const mutation = useChangePlatformOrganizationStatus()
  const [slug, setSlug] = useState('')
  const [slugMismatch, setSlugMismatch] = useState(false)
  const name = target.name
  const users = target.userCount
  const host = target.customHostname ?? null

  function confirm(): void {
    if (action === 'delete' && slug.trim() !== target.slug) {
      setSlugMismatch(true)
      return
    }
    const status = action === 'suspend' ? 'suspended' : action === 'delete' ? 'deleted' : 'active'
    mutation.mutate(
      {
        organizationId: target.id,
        status,
        ...(action === 'delete' ? { confirmSlug: slug.trim() } : {}),
      },
      { onSuccess: onClose },
    )
  }

  const error =
    mutation.error?.code === 'conflict'
      ? t`This organization's status changed or cannot be changed. Reload and try again.`
      : mutation.error
        ? errorMessage(mutation.error, { surface: 'general' })
        : undefined

  if (action === 'suspend') {
    return (
      <ConfirmDialog
        title={<Trans>Suspend {name}</Trans>}
        description={<Trans>Here is what changes as soon as you suspend:</Trans>}
        confirmLabel={<Trans>Suspend organization</Trans>}
        isLoading={mutation.isPending}
        error={error}
        onConfirm={confirm}
        onCancel={onClose}
      >
        <ul {...stylex.props(styles.bullets)}>
          <li>
            {host ? (
              <Plural
                value={users}
                one={`# user can no longer sign in to any ${name} app, including ${host}.`}
                other={`# users can no longer sign in to any ${name} app, including ${host}.`}
              />
            ) : (
              <Plural
                value={users}
                one={`# user can no longer sign in to any ${name} app.`}
                other={`# users can no longer sign in to any ${name} app.`}
              />
            )}
          </li>
          <li>
            <Trans>
              Session tokens stop refreshing within 60 seconds. Access tokens already issued stay
              valid until they expire.
            </Trans>
          </li>
          <li>
            <Trans>
              Users, settings and audit history are kept. Resume restores sign-in right away.
            </Trans>
          </li>
        </ul>
      </ConfirmDialog>
    )
  }

  if (action === 'delete') {
    return (
      <ConfirmDialog
        title={<Trans>Delete {name}</Trans>}
        description={
          <Trans>
            Marks the organization deleted and blocks sign-in. Audit history is kept and you can
            restore it later.
          </Trans>
        }
        confirmLabel={<Trans>Delete organization</Trans>}
        isLoading={mutation.isPending}
        error={error}
        onConfirm={confirm}
        onCancel={onClose}
      >
        <Field
          label={<Trans>Type {target.slug} to confirm</Trans>}
          error={slugMismatch ? t`The slug does not match.` : undefined}
        >
          <Input
            value={slug}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setSlug(event.currentTarget.value)
              setSlugMismatch(false)
            }}
          />
        </Field>
      </ConfirmDialog>
    )
  }

  return (
    <ConfirmDialog
      title={action === 'resume' ? <Trans>Resume {name}</Trans> : <Trans>Restore {name}</Trans>}
      description={
        <Trans>
          Members can sign in again with the methods already set up. Data and settings were kept.
        </Trans>
      }
      confirmLabel={
        action === 'resume' ? (
          <Trans>Resume organization</Trans>
        ) : (
          <Trans>Restore organization</Trans>
        )
      }
      confirmVariant="primary"
      isLoading={mutation.isPending}
      error={error}
      onConfirm={confirm}
      onCancel={onClose}
    />
  )
}

export function statusActionItems(
  organization: Pick<PlatformOrganizationListItem, 'status' | 'canChangeStatus'>,
  onSelect: (action: OrganizationStatusAction) => void,
): DropdownItem[] {
  if (!organization.canChangeStatus) return []
  if (organization.status === 'deleted') {
    return [
      {
        key: 'restore',
        label: <Trans>Restore organization…</Trans>,
        onSelect: () => onSelect('restore'),
      },
    ]
  }
  return [
    organization.status === 'suspended'
      ? {
          key: 'resume',
          label: <Trans>Resume organization…</Trans>,
          onSelect: () => onSelect('resume'),
        }
      : {
          key: 'suspend',
          label: <Trans>Suspend organization…</Trans>,
          onSelect: () => onSelect('suspend'),
        },
    {
      key: 'delete',
      label: <Trans>Delete organization…</Trans>,
      tone: 'danger',
      separatorBefore: true,
      onSelect: () => onSelect('delete'),
    },
  ]
}

function KeyAttributes({ organization }: { organization: OrganizationDetail }): ReactNode {
  const { t, i18n } = useLingui()
  const { organizations } = useAuth()
  const created = formatDate(i18n, organization.createdAt)
  const creator = organization.createdBy?.name ?? organization.createdBy?.email ?? null
  const users = i18n.number(organization.userCount)
  const subOrganizations = organization.subOrganizationCount
  const entries = i18n.number(organization.auditEntryCount)
  const canOpenSettings = organizations.some((org) => org.id === organization.id)
  const orgQuery = `?orgId=${encodeURIComponent(organization.id)}`
  const none = <span {...stylex.props(detail.muted)}>{t`None`}</span>
  const items: { key: string; label: string; value: ReactNode }[] = [
    {
      key: 'slug',
      label: t`Slug`,
      value: <span {...stylex.props(detail.mono)}>{organization.slug}</span>,
    },
    {
      key: 'domain',
      label: t`Custom sign-in domain`,
      value: organization.customHostname ? (
        <>
          {organization.customHostname.hostname}
          <br />
          <span
            {...stylex.props(
              organization.customHostname.status === 'active' ? detail.positive : detail.caution,
            )}
          >
            {organization.customHostname.status === 'active' ? (
              <Trans>Certificate active</Trans>
            ) : (
              <Trans>Setup in progress</Trans>
            )}
          </span>
        </>
      ) : (
        none
      ),
    },
    {
      key: 'owner',
      label: t`Owner`,
      value: organization.owner ? (
        <>
          {organization.owner.name ?? organization.owner.email}
          {organization.owner.name && organization.owner.email ? (
            <>
              <br />
              <span {...stylex.props(detail.muted)}>{organization.owner.email}</span>
            </>
          ) : null}
        </>
      ) : (
        <span {...stylex.props(detail.muted)}>{t`Invitation not accepted yet`}</span>
      ),
    },
    {
      key: 'users',
      label: t`Users`,
      value:
        subOrganizations === 0 ? (
          <Plural value={organization.userCount} one="# user" other="# users" />
        ) : (
          <Plural
            value={subOrganizations}
            one={`${users} in # sub-organization`}
            other={`${users} in # sub-organizations`}
          />
        ),
    },
    {
      key: 'self-service',
      label: t`Self-service settings`,
      value: organization.selfServiceAllowed ? (
        <Trans>Allowed for organization admins</Trans>
      ) : (
        <Trans>Locked; only instance managers can change them</Trans>
      ),
    },
    {
      key: 'created',
      label: t`Created`,
      value: creator ? (
        <Trans>
          {created} by {creator}
        </Trans>
      ) : (
        created
      ),
    },
    {
      key: 'audit',
      label: t`Audit chain`,
      value: (
        <Trans>
          {entries} entries,{' '}
          <Link to="/console/platform/events" {...stylex.props(detail.link)}>
            verify in Audit log
          </Link>
        </Trans>
      ),
    },
  ]
  return (
    <>
      <dl {...stylex.props(detail.attrsList)}>
        {items.map((item) => (
          <div key={item.key} {...stylex.props(detail.attr)}>
            <dt {...stylex.props(detail.attrLabel)}>{item.label}</dt>
            <dd {...stylex.props(detail.attrValue)}>{item.value}</dd>
          </div>
        ))}
      </dl>
      {canOpenSettings ? (
        <nav aria-label={t`Organization settings`} {...stylex.props(styles.settingsLinks)}>
          <span {...stylex.props(detail.attrLabel)}>
            <Trans>Organization settings</Trans>
          </span>
          <Link to={`/console/org/auth-policy${orgQuery}`} {...stylex.props(detail.link)}>
            <Trans>Sign-in & MFA</Trans>
          </Link>
          <Link to={`/console/org/delivery-channels${orgQuery}`} {...stylex.props(detail.link)}>
            <Trans>Messaging</Trans>
          </Link>
          <Link to={`/console/org/social-providers${orgQuery}`} {...stylex.props(detail.link)}>
            <Trans>Social login</Trans>
          </Link>
        </nav>
      ) : null}
    </>
  )
}

function QuotaMeter({
  label,
  hint,
  used,
  limit,
}: {
  label: ReactNode
  hint: ReactNode
  used: number
  limit: number | null
}): ReactNode {
  const { i18n } = useLingui()
  const ratio = percentOf(used, limit)
  const high = ratio !== null && ratio >= QUOTA_WARNING_RATIO
  const usedText = i18n.number(used)
  const limitText = limit === null ? '' : i18n.number(limit)
  const percent = ratio === null ? '' : i18n.number(Math.round(ratio * 100))
  return (
    <div {...stylex.props(styles.quotaRow)}>
      <div {...stylex.props(list.cellStack)}>
        <span>{label}</span>
        <span {...stylex.props(list.cellSub)}>{hint}</span>
      </div>
      {ratio === null ? (
        <span aria-hidden="true" />
      ) : (
        <div
          role="meter"
          aria-valuemin={0}
          aria-valuemax={limit ?? 0}
          aria-valuenow={used}
          {...stylex.props(styles.meter)}
        >
          <div
            style={{ width: `${Math.min(100, ratio * 100)}%` }}
            {...stylex.props(styles.meterFill, high && styles.meterWarning)}
          />
        </div>
      )}
      <div {...stylex.props(styles.quotaValue)}>
        {limit === null ? (
          <Trans>{usedText}, no limit</Trans>
        ) : (
          <Trans>
            {usedText} of {limitText}
          </Trans>
        )}
        {high ? (
          <div {...stylex.props(styles.warning)}>
            <Trans>{percent}% of quota</Trans>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function quotaLimit(
  quotas: readonly OrganizationQuota[] | undefined,
  key: OrganizationQuota['key'],
): OrganizationQuota | undefined {
  return quotas?.find((quota) => quota.key === key)
}

function QuotasSection({ organization }: { organization: OrganizationDetail }): ReactNode {
  const { i18n } = useLingui()
  const quota = useOrganizationQuotaQuery(organization.id)
  const now = new Date()
  const reset = i18n.date(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)), {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
  const creationLimits = [
    { key: 'organizations' as const, label: <Trans>Child organizations</Trans> },
    { key: 'sso_connections' as const, label: <Trans>SSO connections</Trans> },
  ]
  return (
    <section {...stylex.props(detail.section)}>
      <div {...stylex.props(detail.sectionHead)}>
        <div {...stylex.props(detail.sectionText)}>
          <h2 {...stylex.props(detail.sectionTitle)}>
            <Trans>Resource quotas</Trans>
          </h2>
          <p {...stylex.props(detail.sectionLead)}>
            <Trans>
              Quotas never disable authentication, token issuance, or configured protocols.
            </Trans>
          </p>
        </div>
        <Link
          to={`/console/platform/quotas?tenantId=${encodeURIComponent(organization.id)}`}
          {...stylex.props(list.filterButton)}
        >
          <Trans>Edit quotas</Trans>
        </Link>
      </div>
      <div {...stylex.props(detail.rows)}>
        <QuotaMeter
          label={<Trans>Monthly active users</Trans>}
          hint={<Trans>Observed only. Counts reset {reset}</Trans>}
          used={organization.mauThisMonth}
          limit={organization.mauQuota}
        />
        <QuotaMeter
          label={<Trans>Seats</Trans>}
          hint={<Trans>Observed only</Trans>}
          used={organization.seatsUsed}
          limit={quotaLimit(quota.data?.quotas, 'seats')?.limit ?? organization.seatLimit}
        />
      </div>
      <p {...stylex.props(detail.sectionLead)}>
        <Trans>Usage is not counted for these limits.</Trans>
      </p>
      <ul {...stylex.props(detail.rows)}>
        {creationLimits.map((item) => {
          const row = quotaLimit(quota.data?.quotas, item.key)
          const limit = row?.limit ?? null
          const limitText = limit === null ? '' : i18n.number(limit)
          return (
            <li key={item.key} {...stylex.props(detail.itemRow)}>
              <span {...stylex.props(detail.itemMain)}>{item.label}</span>
              <span {...stylex.props(detail.itemState)}>
                {row?.enforcement === 'block_creation' ? (
                  <Trans>Blocks creation</Trans>
                ) : (
                  <Trans>Observed only</Trans>
                )}
              </span>
              <span {...stylex.props(styles.quotaValue)}>
                {limit === null ? <Trans>No limit</Trans> : <Trans>Limit {limitText}</Trans>}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function LifecycleSection({
  organization,
  onAction,
}: {
  organization: OrganizationDetail
  onAction: (action: OrganizationStatusAction) => void
}): ReactNode {
  if (!organization.canChangeStatus) return null
  const name = organization.name
  const users = organization.userCount
  const suspended = organization.status === 'suspended'
  const deleted = organization.status === 'deleted'
  return (
    <section {...stylex.props(detail.section)}>
      <h2 {...stylex.props(detail.sectionTitle)}>
        <Trans>Suspend or delete</Trans>
      </h2>
      <ul {...stylex.props(detail.rows)}>
        {deleted ? null : (
          <li {...stylex.props(detail.itemRow)}>
            <div {...stylex.props(detail.itemMain)}>
              <span {...stylex.props(detail.itemTitle)}>
                {suspended ? <Trans>Resume {name}</Trans> : <Trans>Suspend {name}</Trans>}
              </span>
              <span {...stylex.props(detail.itemSub)}>
                {suspended ? (
                  <Trans>Members can sign in again right away.</Trans>
                ) : (
                  <Plural
                    value={users}
                    one="# user stops signing in. Data and settings stay, and you can resume at any time."
                    other="# users stop signing in. Data and settings stay, and you can resume at any time."
                  />
                )}
              </span>
            </div>
            <Button
              variant="secondary"
              onClick={() => onAction(suspended ? 'resume' : 'suspend')}
              {...stylex.props(!suspended && styles.dangerButton)}
            >
              {suspended ? (
                <Trans>Resume organization…</Trans>
              ) : (
                <Trans>Suspend organization…</Trans>
              )}
            </Button>
          </li>
        )}
        <li {...stylex.props(detail.itemRow)}>
          <div {...stylex.props(detail.itemMain)}>
            <span {...stylex.props(detail.itemTitle)}>
              {deleted ? <Trans>Restore {name}</Trans> : <Trans>Delete {name}</Trans>}
            </span>
            <span {...stylex.props(detail.itemSub)}>
              {deleted ? (
                <Trans>Sign-in works again for every member. Audit history was kept.</Trans>
              ) : (
                <Trans>
                  Marks the organization deleted and blocks sign-in. Audit history is kept. Requires
                  typing the slug.
                </Trans>
              )}
            </span>
          </div>
          <Button
            variant="secondary"
            onClick={() => onAction(deleted ? 'restore' : 'delete')}
            {...stylex.props(!deleted && styles.dangerButton)}
          >
            {deleted ? <Trans>Restore organization…</Trans> : <Trans>Delete organization…</Trans>}
          </Button>
        </li>
      </ul>
    </section>
  )
}

function MembersTab({ organizationId }: { organizationId: string }): ReactNode {
  const { t, i18n } = useLingui()
  const roleLabel = useRoleLabel()
  const [cursors, setCursors] = useState<(string | null)[]>([null])
  const members = usePlatformOrganizationMembers(organizationId, cursors.at(-1) ?? null, true)
  const page = members.data
  const columns: DataTableColumnDef<PlatformOrganizationMember>[] = [
    {
      id: 'user',
      header: () => t`User`,
      cell: ({ row }) => {
        const name = row.original.user.name ?? row.original.user.email ?? row.original.user.userId
        return (
          <IdentityCell
            name={name}
            secondary={row.original.user.email ?? row.original.user.userId}
            secondaryIsCode={!row.original.user.email}
            avatarName={name}
          />
        )
      },
      meta: { priority: 'primary' },
    },
    {
      id: 'organization',
      header: () => t`Organization`,
      cell: ({ row }) => row.original.organizationName,
      meta: { hidden: { narrow: true, regular: false } },
    },
    {
      id: 'role',
      header: () => t`Role`,
      cell: ({ row }) => roleLabel(row.original.role),
      meta: { priority: 'primary' },
    },
    {
      id: 'joined',
      header: () => t`Joined`,
      cell: ({ row }) => (
        <span {...stylex.props(list.numeric)}>
          {formatDate(i18n, row.original.joinedAt) ?? '-'}
        </span>
      ),
      meta: { align: 'end', hidden: { narrow: true, regular: false } },
    },
  ]
  if (members.isError && !page) {
    return (
      <EmptyState
        variant="load-failure"
        title={<Trans>Members could not be loaded</Trans>}
        action={
          <Button variant="secondary" onClick={() => void members.refetch()}>
            <Trans>Try again</Trans>
          </Button>
        }
      />
    )
  }
  return (
    <>
      <DataTable
        columns={columns}
        data={page?.data ?? []}
        getRowId={(row) => row.id}
        isLoading={members.isLoading}
        density="comfortable"
        narrowMode="priority"
        caption={t`Members`}
        captionDisplay="hidden"
        emptyMessage={
          <Trans>No members yet. The owner joins after accepting the invitation.</Trans>
        }
      />
      {page && (cursors.length > 1 || page.nextCursor) ? (
        <div {...stylex.props(list.pager)}>
          <Button
            variant="secondary"
            disabled={cursors.length <= 1 || members.isFetching}
            onClick={() => setCursors(cursors.slice(0, -1))}
            {...stylex.props(list.pagerButton)}
          >
            <Trans>Previous</Trans>
          </Button>
          <Button
            variant="secondary"
            disabled={!page.nextCursor || members.isFetching}
            onClick={() => setCursors([...cursors, page.nextCursor])}
            {...stylex.props(list.pagerButton)}
          >
            <Trans>Next</Trans>
          </Button>
        </div>
      ) : null}
    </>
  )
}

function DomainsTab({ organizationId }: { organizationId: string }): ReactNode {
  const { i18n } = useLingui()
  const domains = usePlatformOrganizationDomains(organizationId, true)
  if (domains.isLoading) return <Skeleton width="100%" height="3rem" />
  if (domains.isError) {
    return (
      <EmptyState
        variant="load-failure"
        title={<Trans>Domains could not be loaded</Trans>}
        action={
          <Button variant="secondary" onClick={() => void domains.refetch()}>
            <Trans>Try again</Trans>
          </Button>
        }
      />
    )
  }
  const rows = domains.data?.data ?? []
  if (rows.length === 0) {
    return <EmptyState title={<Trans>This organization has not added a domain.</Trans>} />
  }
  return (
    <ul {...stylex.props(detail.rows)}>
      {rows.map((row) => {
        const since = formatDate(i18n, row.verifiedAt ?? row.createdAt)
        return (
          <li key={row.id} {...stylex.props(detail.itemRow)}>
            <div {...stylex.props(detail.itemMain)}>
              <span {...stylex.props(detail.itemTitle)}>{row.domain}</span>
              <span {...stylex.props(detail.itemSub)}>
                {row.verified ? <Trans>Verified {since}</Trans> : <Trans>Added {since}</Trans>}
              </span>
            </div>
            <Badge tone={row.verified ? 'success' : 'warning'}>
              {row.verified ? <Trans>Verified</Trans> : <Trans>Not verified</Trans>}
            </Badge>
          </li>
        )
      })}
    </ul>
  )
}

function UsageTab({ organization }: { organization: OrganizationDetail }): ReactNode {
  const { i18n } = useLingui()
  const mau = i18n.number(organization.mauThisMonth)
  const seats = i18n.number(organization.seatsUsed)
  return (
    <section {...stylex.props(detail.section)}>
      <ul {...stylex.props(detail.rows)}>
        <li {...stylex.props(detail.row)}>
          <span {...stylex.props(detail.rowLabel)}>
            <Trans>Monthly active users</Trans>
          </span>
          <span {...stylex.props(detail.rowValue)}>{mau}</span>
        </li>
        <li {...stylex.props(detail.row)}>
          <span {...stylex.props(detail.rowLabel)}>
            <Trans>Seats in use</Trans>
          </span>
          <span {...stylex.props(detail.rowValue)}>{seats}</span>
        </li>
      </ul>
      <Link to="/console/platform/usage" {...stylex.props(detail.link)}>
        <Trans>Open usage for every organization</Trans>
      </Link>
    </section>
  )
}

function AuditTab({ organization }: { organization: OrganizationDetail }): ReactNode {
  const { i18n } = useLingui()
  const entries = i18n.number(organization.auditEntryCount)
  return (
    <section {...stylex.props(detail.section)}>
      <p {...stylex.props(detail.sectionLead)}>
        <Trans>
          {entries} audit entries are chained for this organization. Each entry stores the hash of
          the one before it, so a gap or an edit shows up when you verify the chain.
        </Trans>
      </p>
      <Link to="/console/platform/events" {...stylex.props(detail.link)}>
        <Trans>Open the event stream and verify the chain</Trans>
      </Link>
    </section>
  )
}

const TABS = ['overview', 'members', 'domains', 'usage', 'audit'] as const
type TabKey = (typeof TABS)[number]

function Header({
  organization,
  onAction,
}: {
  organization: OrganizationDetail
  onAction: (action: OrganizationStatusAction) => void
}): ReactNode {
  const { t } = useLingui()
  const navigate = useNavigate()
  const statusLabel = useOrganizationStatusLabel()
  const name = organization.name
  const items: DropdownItem[] = [
    ...statusActionItems(organization, onAction),
    {
      key: 'quotas',
      label: <Trans>Edit resource quotas</Trans>,
      separatorBefore: organization.canChangeStatus,
      onSelect: () =>
        navigate(`/console/platform/quotas?tenantId=${encodeURIComponent(organization.id)}`),
    },
  ]
  return (
    <div {...stylex.props(detail.header)}>
      <div {...stylex.props(detail.identity)}>
        <span aria-hidden="true" {...stylex.props(styles.mark, list.hideNarrow)}>
          {initials(name).charAt(0)}
        </span>
        <div {...stylex.props(detail.titleBlock)}>
          <div {...stylex.props(detail.titleRow)}>
            <h1 {...stylex.props(detail.title)}>{name}</h1>
            <Badge tone={statusToneFor(organization.status)}>
              {statusLabel(organization.status)}
            </Badge>
          </div>
          <div {...stylex.props(detail.subRow)}>
            {organization.primaryHost ? <span>{organization.primaryHost}</span> : null}
            <span {...stylex.props(detail.idRow)}>
              <span {...stylex.props(detail.mono)}>{organization.id}</span>
              <CopyButton value={organization.id} subject={t`organization ID`} />
            </span>
          </div>
        </div>
      </div>
      <div {...stylex.props(styles.headerActions)}>
        <span {...stylex.props(styles.headerButton)}>
          <Dropdown
            ariaLabel={t`Actions for ${name}`}
            align="end"
            triggerStyle={list.filterButton}
            trigger={({ open }) => (
              <>
                <Trans>Actions</Trans>
                <Icon name={open ? 'caret-up' : 'caret-down'} size={12} />
              </>
            )}
            items={items}
          />
        </span>
        {organization.status === 'active' ? (
          <Button
            onClick={() =>
              navigate(
                `${PLATFORM_USERS_PATH}?organizationId=${encodeURIComponent(organization.id)}`,
              )
            }
            {...stylex.props(styles.headerButton)}
          >
            <Trans>Impersonate a user</Trans>
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export function PlatformOrganizationDetail({
  organizationId,
}: {
  organizationId: string
}): ReactNode {
  const { t } = useLingui()
  const [params] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const organization = usePlatformOrganizationDetail(organizationId)
  const [pending, setPending] = useState<OrganizationStatusAction | null>(null)
  const tab: TabKey = (TABS as readonly string[]).includes(params.get('tab') ?? '')
    ? (params.get('tab') as TabKey)
    : 'overview'
  const record = organization.data

  function selectTab(value: string): void {
    const next = new URLSearchParams(params)
    if (value === 'overview') next.delete('tab')
    else next.set('tab', value)
    navigate(`${location.pathname}?${next.toString()}`, { replace: true })
  }

  const breadcrumb = (
    <ol {...stylex.props(frame.crumbs)}>
      <li>
        <Link to={PLATFORM_ORGANIZATIONS_PATH} {...stylex.props(frame.crumbLink)}>
          <Trans>Organizations</Trans>
        </Link>
      </li>
      <li aria-hidden="true" {...stylex.props(frame.crumbSep)}>
        /
      </li>
      <li aria-current="page">
        {record ? record.name : <Skeleton width="6rem" height="0.75rem" />}
      </li>
    </ol>
  )

  if (organization.isError && !record) {
    const missing = organization.error.httpStatus === 404
    return (
      <PageFrame title={<Trans>Organization</Trans>} breadcrumb={breadcrumb}>
        <EmptyState
          variant="load-failure"
          title={
            missing ? (
              <Trans>Organization not found</Trans>
            ) : (
              <Trans>Organization could not be loaded</Trans>
            )
          }
          description={
            missing ? (
              <Trans>No top-level organization on this instance has that ID.</Trans>
            ) : (
              <Trans>Nothing changed. Check your connection and try again.</Trans>
            )
          }
          action={
            missing ? null : (
              <Button variant="secondary" onClick={() => void organization.refetch()}>
                <Trans>Try again</Trans>
              </Button>
            )
          }
        />
      </PageFrame>
    )
  }

  return (
    <div {...stylex.props(frame.root)}>
      {breadcrumb}
      {record ? (
        <Header organization={record} onAction={setPending} />
      ) : (
        <Skeleton width="16rem" height="2rem" />
      )}
      <Tabs
        ariaLabel={t`Organization sections`}
        value={tab}
        onValueChange={selectTab}
        items={[
          { value: 'overview', label: <Trans>Overview</Trans> },
          { value: 'members', label: <Trans>Members</Trans> },
          { value: 'domains', label: <Trans>Domains</Trans> },
          { value: 'usage', label: <Trans>Usage</Trans> },
          { value: 'audit', label: <Trans>Audit log</Trans> },
        ]}
      />
      {record ? (
        <>
          {tab === 'overview' ? (
            <>
              <details {...stylex.props(styles.belowWide)}>
                <summary {...stylex.props(detail.attrsSummary)}>
                  <Trans>Key attributes</Trans>
                </summary>
                <KeyAttributes organization={record} />
              </details>
              <div {...stylex.props(detail.layout)}>
                <aside {...stylex.props(detail.attrs, styles.wideOnly)}>
                  <p {...stylex.props(detail.attrsTitle)}>
                    <Trans>Key attributes</Trans>
                  </p>
                  <KeyAttributes organization={record} />
                </aside>
                <div {...stylex.props(detail.content)}>
                  <QuotasSection organization={record} />
                  <LifecycleSection organization={record} onAction={setPending} />
                </div>
              </div>
            </>
          ) : null}
          {tab === 'members' ? <MembersTab organizationId={record.id} /> : null}
          {tab === 'domains' ? <DomainsTab organizationId={record.id} /> : null}
          {tab === 'usage' ? <UsageTab organization={record} /> : null}
          {tab === 'audit' ? <AuditTab organization={record} /> : null}
        </>
      ) : null}
      {record && pending ? (
        <OrganizationStatusDialog
          target={{ ...record, customHostname: record.customHostname?.hostname ?? null }}
          action={pending}
          onClose={() => setPending(null)}
        />
      ) : null}
    </div>
  )
}
