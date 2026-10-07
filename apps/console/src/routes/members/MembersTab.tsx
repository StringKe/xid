// 成员表:成员(你)、角色、加入方式、加入时间、最后活跃、行菜单(改角色、移出组织)。手机只留成员、角色与菜单。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { OrganizationMembershipRole } from '@xid-kit/types'
import { useAuth } from '@xid-kit/web-ui/session'
import { useRoleLabel } from '@xid-kit/web-ui/enum-labels'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { Button, Dropdown, EmptyState, Icon, IdentityCell, useToast } from '@xid-kit/web-ui/ui'
import type { DataTableColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { list } from '../../components/page/list-styles'
import { formatRelative } from '../users/user-format'
import { formatDate } from '../../lib/date-format'
import { ChangeRoleDialog } from './ChangeRoleDialog'
import type { MemberRow } from './member-api'
import { useMembers, useRemoveMember } from './member-api'

const ROLES: readonly OrganizationMembershipRole[] = ['owner', 'admin', 'member']

function SearchInput({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}): ReactNode {
  const { t } = useLingui()
  return (
    <label {...stylex.props(list.search)}>
      <span aria-hidden="true" {...stylex.props(list.searchIcon)}>
        <Icon name="search" size={16} />
      </span>
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={t`Name or email`}
        aria-label={t`Search members`}
        {...stylex.props(list.searchInput)}
      />
    </label>
  )
}

function JoinedThrough({ row }: { row: MemberRow }): ReactNode {
  const inviter = row.invitedByName
  if (row.joinedThrough === 'directory_sync') return <Trans>Directory sync</Trans>
  if (row.joinedThrough === 'invitation') {
    return inviter ? <Trans>Invited by {inviter}</Trans> : <Trans>Invitation</Trans>
  }
  return <Trans>Added directly</Trans>
}

export function MembersTab({
  orgId,
  orgName,
  action,
}: {
  orgId: string
  orgName: string
  action: ReactNode
}): ReactNode {
  const { t, i18n } = useLingui()
  const { notify } = useToast()
  const { user } = useAuth()
  const roleLabel = useRoleLabel()
  const errorMessage = useManagementErrorMessage()
  const [search, setSearch] = useState('')
  const [role, setRole] = useState<OrganizationMembershipRole | null>(null)
  const [cursors, setCursors] = useState<(string | null)[]>([null])
  const members = useMembers(orgId, { role, search, cursor: cursors[cursors.length - 1] ?? null })
  const remove = useRemoveMember(orgId)
  const [changing, setChanging] = useState<MemberRow | null>(null)
  const [removing, setRemoving] = useState<MemberRow | null>(null)
  const pageData = members.data
  const orgLabel = orgName

  const columns: DataTableColumnDef<MemberRow>[] = [
    {
      id: 'member',
      header: () => t`Member`,
      cell: ({ row }) => {
        const self = row.original.userId === user?.id
        const name = row.original.name ?? row.original.email
        return (
          <IdentityCell
            name={self ? t`${name} (you)` : name}
            secondary={row.original.name ? row.original.email : undefined}
            avatarName={name}
          />
        )
      },
      meta: { priority: 'primary', width: '30%' },
    },
    {
      id: 'role',
      header: () => t`Role`,
      cell: ({ row }) => roleLabel(row.original.role),
      meta: { priority: 'primary' },
    },
    {
      id: 'through',
      header: () => t`Joined through`,
      cell: ({ row }) => (
        <span {...stylex.props(list.muted)}>
          <JoinedThrough row={row.original} />
        </span>
      ),
      meta: { hidden: { narrow: true, regular: true, sidebar: false } },
    },
    {
      id: 'joined',
      header: () => t`Joined`,
      cell: ({ row }) => (
        <span {...stylex.props(list.numeric)}>{formatDate(i18n, row.original.joinedAt)}</span>
      ),
      meta: { align: 'end', hidden: { narrow: true, regular: false } },
    },
    {
      id: 'active',
      header: () => t`Last active`,
      cell: ({ row }) => (
        <span {...stylex.props(list.numeric)}>
          {formatRelative(i18n, row.original.lastSignInAt) ?? t`Never signed in`}
        </span>
      ),
      meta: { align: 'end', hidden: { narrow: true, regular: false } },
    },
    {
      id: 'menu',
      header: () => <span {...stylex.props(page.visuallyHidden)}>{t`Actions`}</span>,
      cell: ({ row }) => {
        const name = row.original.name ?? row.original.email
        return (
          <Dropdown
            ariaLabel={t`Actions for ${name}`}
            align="end"
            triggerStyle={list.iconButton}
            trigger={<Icon name="more-horizontal" size={16} />}
            items={[
              {
                key: 'role',
                label: <Trans>Change role…</Trans>,
                onSelect: () => setChanging(row.original),
              },
              {
                key: 'remove',
                label: <Trans>Remove from organization…</Trans>,
                tone: 'danger',
                separatorBefore: true,
                onSelect: () => setRemoving(row.original),
              },
            ]}
          />
        )
      },
      meta: { priority: 'primary', align: 'end', width: '3rem' },
    },
  ]

  const shown = pageData?.data.length ?? 0
  const total = pageData?.total ?? 0
  const owners = pageData?.counts.owner ?? 0
  const admins = pageData?.counts.admin ?? 0
  const removingName = removing ? (removing.name ?? removing.email) : ''

  return (
    <>
      <div {...stylex.props(list.bar)}>
        <SearchInput
          value={search}
          onChange={(value) => {
            setCursors([null])
            setSearch(value)
          }}
        />
        <Dropdown
          ariaLabel={t`Role`}
          align="start"
          triggerStyle={list.filterButton}
          trigger={
            <>
              <span>{t`Role`}</span>
              {role ? <span {...stylex.props(list.filterValue)}>{roleLabel(role)}</span> : null}
              <Icon name="caret-down" size={12} />
            </>
          }
          items={[
            { key: 'any', label: t`Any`, checked: role === null, onSelect: () => setRole(null) },
            ...ROLES.map((candidate) => ({
              key: candidate,
              label: roleLabel(candidate),
              checked: role === candidate,
              onSelect: () => {
                setCursors([null])
                setRole(candidate)
              },
            })),
          ]}
        />
        <div {...stylex.props(list.barEnd)}>{action}</div>
      </div>
      {members.isError && !pageData ? (
        <EmptyState
          variant="load-failure"
          title={<Trans>Members could not be loaded</Trans>}
          action={
            <Button variant="secondary" onClick={() => void members.refetch()}>
              <Trans>Try again</Trans>
            </Button>
          }
        />
      ) : (
        <>
          <DataTable
            columns={columns}
            data={pageData?.data ?? []}
            getRowId={(row) => row.id}
            isLoading={members.isLoading}
            density="comfortable"
            narrowMode="priority"
            caption={t`Members`}
            captionDisplay="hidden"
            emptyMessage={<Trans>No members match.</Trans>}
          />
          {pageData ? (
            <div {...stylex.props(list.footer)}>
              <p {...stylex.props(list.footnote)}>
                <Trans>
                  Showing {shown} of {total} members. Owners: {owners}. Admins: {admins}.
                </Trans>
              </p>
              {cursors.length > 1 || pageData.has_more ? (
                <div {...stylex.props(list.pager)}>
                  <Button
                    variant="secondary"
                    disabled={cursors.length <= 1}
                    onClick={() => setCursors(cursors.slice(0, -1))}
                    {...stylex.props(list.pagerButton)}
                  >
                    <Trans>Previous</Trans>
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!pageData.has_more}
                    onClick={() => setCursors([...cursors, pageData.next_cursor])}
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
      {changing ? (
        <ChangeRoleDialog
          orgId={orgId}
          orgName={orgLabel}
          membershipId={changing.id}
          memberName={changing.name ?? changing.email}
          currentRole={changing.role}
          isSelf={changing.userId === user?.id}
          onClose={() => setChanging(null)}
        />
      ) : null}
      {removing ? (
        <ConfirmDialog
          title={
            <Trans>
              Remove {removingName} from {orgLabel}?
            </Trans>
          }
          description={
            <Trans>
              {removingName} loses access to {orgLabel} and its apps right away. The account itself
              stays and can be invited again.
            </Trans>
          }
          confirmLabel={<Trans>Remove member</Trans>}
          isLoading={remove.isPending}
          error={
            remove.error?.code === 'last_owner' ? (
              <Trans>
                {orgLabel} must always have an owner. Make another member an owner first.
              </Trans>
            ) : (
              errorMessage(remove.error)
            )
          }
          onConfirm={() =>
            remove.mutate(removing.id, {
              onSuccess: () => {
                notify({ title: t`${removingName} was removed` })
                setRemoving(null)
              },
            })
          }
          onCancel={() => setRemoving(null)}
        />
      ) : null}
    </>
  )
}
