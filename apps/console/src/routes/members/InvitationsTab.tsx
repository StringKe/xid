// 待接受的邀请:邮箱、角色、状态(已过期由有效期判断)、邀请人与日期、有效期、重发与撤销。
// 重发会换新链接,旧链接立即失效,并计入每小时 50 封的邀请限额。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { UseQueryResult } from '@tanstack/react-query'
import type { OrganizationMembershipRole, XidError } from '@xid-kit/types'
import { useRoleLabel } from '@xid-kit/web-ui/enum-labels'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { page } from '@xid-kit/web-ui/styles/product-surface.stylex'
import { Alert, Badge, Button, Dropdown, EmptyState, Icon, useToast } from '@xid-kit/web-ui/ui'
import type { DataTableColumnDef } from '@xid-kit/web-ui/ui/DataTable'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { list } from '../../components/page/list-styles'
import { formatDate } from '../../lib/date-format'
import type { InvitationRow, InvitationsPage } from './member-api'
import { useResendInvitation, useRevokeInvitation } from './member-api'

const ROLES: readonly OrganizationMembershipRole[] = ['owner', 'admin', 'member']

function isExpired(row: InvitationRow, now: number): boolean {
  return row.status === 'expired' || new Date(row.expiresAt).getTime() <= now
}

function Expiry({ row, now }: { row: InvitationRow; now: number }): ReactNode {
  const { i18n } = useLingui()
  const date = formatDate(i18n, row.expiresAt)
  if (isExpired(row, now)) return <Trans>Expired {date}</Trans>
  const days = Math.max(1, Math.ceil((new Date(row.expiresAt).getTime() - now) / 86_400_000))
  return <>{new Intl.RelativeTimeFormat(i18n.locale, { numeric: 'auto' }).format(days, 'day')}</>
}

export function InvitationsTab({
  orgId,
  invitations,
  action,
}: {
  orgId: string
  invitations: UseQueryResult<InvitationsPage, XidError>
  action: ReactNode
}): ReactNode {
  const { t, i18n } = useLingui()
  const { notify } = useToast()
  const roleLabel = useRoleLabel()
  const errorMessage = useManagementErrorMessage()
  const resend = useResendInvitation(orgId)
  const revoke = useRevokeInvitation(orgId)
  const [query, setQuery] = useState('')
  const [role, setRole] = useState<OrganizationMembershipRole | null>(null)
  const [revoking, setRevoking] = useState<InvitationRow | null>(null)
  const now = Date.now()
  const rows = (invitations.data?.data ?? []).filter(
    (row) =>
      (role === null || row.role === role) &&
      (query.trim() === '' || row.email.includes(query.trim().toLowerCase())),
  )

  const columns: DataTableColumnDef<InvitationRow>[] = [
    {
      id: 'email',
      header: () => t`Invited email`,
      cell: ({ row }) => <span {...stylex.props(list.breakable)}>{row.original.email}</span>,
      meta: { priority: 'primary' },
    },
    {
      id: 'role',
      header: () => t`Role`,
      cell: ({ row }) => roleLabel(row.original.role),
      meta: { hidden: { narrow: true, regular: false } },
    },
    {
      id: 'status',
      header: () => t`Status`,
      cell: ({ row }) =>
        isExpired(row.original, now) ? (
          <Badge tone="warning">
            <Trans>Expired</Trans>
          </Badge>
        ) : (
          <Badge tone="neutral">
            <Trans>Pending</Trans>
          </Badge>
        ),
      meta: { priority: 'primary' },
    },
    {
      id: 'by',
      header: () => t`Invited by`,
      cell: ({ row }) => {
        const date = formatDate(i18n, row.original.createdAt)
        const inviter = row.original.invitedByName
        return (
          <span {...stylex.props(list.muted)}>
            {inviter ? (
              <Trans>
                {inviter} on {date}
              </Trans>
            ) : (
              <Trans>Through the Management API on {date}</Trans>
            )}
          </span>
        )
      },
      meta: { hidden: { narrow: true, regular: true, sidebar: false } },
    },
    {
      id: 'expires',
      header: () => t`Expires`,
      cell: ({ row }) => (
        <span {...stylex.props(list.numeric)}>
          <Expiry row={row.original} now={now} />
        </span>
      ),
      meta: { align: 'end', hidden: { narrow: true, regular: false } },
    },
    {
      id: 'actions',
      header: () => <span {...stylex.props(page.visuallyHidden)}>{t`Actions`}</span>,
      cell: ({ row }) => {
        const email = row.original.email
        return (
          <Dropdown
            ariaLabel={t`Actions for ${email}`}
            align="end"
            triggerStyle={list.iconButton}
            trigger={<Icon name="more-horizontal" size={16} />}
            items={[
              {
                key: 'resend',
                label: <Trans>Resend invitation</Trans>,
                onSelect: () =>
                  resend.mutate(row.original.id, {
                    onSuccess: () => notify({ title: t`New invitation sent to ${email}` }),
                  }),
              },
              {
                key: 'revoke',
                label: <Trans>Revoke invitation…</Trans>,
                tone: 'danger',
                separatorBefore: true,
                onSelect: () => setRevoking(row.original),
              },
            ]}
          />
        )
      },
      meta: { priority: 'primary', align: 'end', width: '3rem' },
    },
  ]

  const revokingEmail = revoking?.email ?? ''
  return (
    <>
      <div {...stylex.props(list.bar)}>
        <label {...stylex.props(list.search)}>
          <span aria-hidden="true" {...stylex.props(list.searchIcon)}>
            <Icon name="search" size={16} />
          </span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={t`Email address`}
            aria-label={t`Search invitations`}
            {...stylex.props(list.searchInput)}
          />
        </label>
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
              onSelect: () => setRole(candidate),
            })),
          ]}
        />
        <div {...stylex.props(list.barEnd)}>{action}</div>
      </div>
      {resend.error ? <Alert tone="error">{errorMessage(resend.error)}</Alert> : null}
      {invitations.isError && !invitations.data ? (
        <EmptyState
          variant="load-failure"
          title={<Trans>Invitations could not be loaded</Trans>}
          action={
            <Button variant="secondary" onClick={() => void invitations.refetch()}>
              <Trans>Try again</Trans>
            </Button>
          }
        />
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          getRowId={(row) => row.id}
          isLoading={invitations.isLoading}
          density="comfortable"
          narrowMode="priority"
          caption={t`Invitations`}
          captionDisplay="hidden"
          emptyMessage={<Trans>No pending invitations.</Trans>}
        />
      )}
      <p {...stylex.props(list.footnote)}>
        <Trans>
          Resending replaces the link, so the earlier email stops working. You can send up to 50
          invitations an hour.
        </Trans>
      </p>
      {revoking ? (
        <ConfirmDialog
          title={<Trans>Revoke the invitation for {revokingEmail}?</Trans>}
          description={
            <Trans>
              The link stops working right away. You can invite {revokingEmail} again later.
            </Trans>
          }
          confirmLabel={<Trans>Revoke invitation</Trans>}
          isLoading={revoke.isPending}
          error={errorMessage(revoke.error)}
          onConfirm={() => revoke.mutate(revoking.id, { onSuccess: () => setRevoking(null) })}
          onCancel={() => setRevoking(null)}
        />
      ) : null}
    </>
  )
}
