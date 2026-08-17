import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { Alert, Badge, Button, Field, Input, Select } from '@xid-kit/web-ui/ui'
import {
  ConsolePage,
  ConsolePageNotice,
  ConsolePageSection,
  ConsolePageSplitSection,
} from '@xid-kit/web-ui/ui'
import { DataTable } from '@xid-kit/web-ui/ui/DataTable'
import { Pagination } from '@xid-kit/web-ui/ui/Pagination'
import { consoleShell } from '@xid-kit/web-ui/styles/product-surface.stylex'
import {
  statusToneFor,
  useInvitationStatusLabel,
  useMemberStatusLabel,
  useRoleLabel,
} from '@xid-kit/web-ui/enum-labels'
import { ConfirmDialog } from '@xid-kit/web-ui/ConfirmDialog'
import {
  useOrgMembersQuery,
  useOrgInvitationsQuery,
  useCreateOrgInvitation,
  useRevokeOrgInvitation,
  useRemoveOrgMember,
} from './queries'
import type { OrgInvitation, OrgMember } from './types'
import { useOrgTarget } from './useOrgTarget'
import type { OrganizationMembershipRole } from '@xid-kit/types'

const styles = stylex.create({
  inviteForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  inviteRow: {
    display: 'flex',
    gap: '0.75rem',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
  },
  inviteEmailWrap: {
    flex: '1 1 240px',
    maxWidth: '36rem',
  },
  inviteRoleWrap: {
    flex: '0 0 160px',
  },
})

function StatusBadge({
  status,
  label,
}: {
  status: OrgMember['status'] | OrgInvitation['status']
  label: string
}): ReactNode {
  return <Badge tone={statusToneFor(status)}>{label}</Badge>
}

export default function OrgMembers(): ReactNode {
  const { t } = useLingui()
  const { orgId } = useOrgTarget()
  const memberStatusLabel = useMemberStatusLabel()
  const invitationStatusLabel = useInvitationStatusLabel()
  const roleLabel = useRoleLabel()

  const [memberCursor, setMemberCursor] = useState<string | undefined>()
  const [inviteCursor, setInviteCursor] = useState<string | undefined>()

  const {
    data: membersPage,
    isLoading: membersLoading,
    isError: membersError,
  } = useOrgMembersQuery(orgId, memberCursor)

  const {
    data: invitationsPage,
    isLoading: invitationsLoading,
    isError: invitationsError,
  } = useOrgInvitationsQuery(orgId, inviteCursor)

  const createInvitation = useCreateOrgInvitation(orgId)
  const revokeInvitation = useRevokeOrgInvitation(orgId)
  const removeMember = useRemoveOrgMember(orgId)

  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<OrganizationMembershipRole>('member')
  const [inviteSuccess, setInviteSuccess] = useState(false)

  const [pendingRemoveMember, setPendingRemoveMember] = useState<OrgMember | null>(null)
  const [pendingRevokeInvitation, setPendingRevokeInvitation] = useState<OrgInvitation | null>(null)

  const memberColumns: ColumnDef<OrgMember>[] = [
    {
      id: 'name',
      header: () => <Trans>Name</Trans>,
      cell: ({ row }) => row.original.name ?? row.original.email,
    },
    {
      id: 'email',
      header: () => <Trans>Email</Trans>,
      cell: ({ row }) => row.original.email,
    },
    {
      id: 'role',
      header: () => <Trans>Role</Trans>,
      cell: ({ row }) => roleLabel(row.original.role),
      meta: { width: '100px' },
    },
    {
      id: 'status',
      header: () => <Trans>Status</Trans>,
      cell: ({ row }) => (
        <StatusBadge status={row.original.status} label={memberStatusLabel(row.original.status)} />
      ),
      meta: { width: '100px' },
    },
    {
      id: 'actions',
      header: () => <Trans>Actions</Trans>,
      cell: ({ row }) => (
        <Button
          variant="danger"
          isLoading={removeMember.isPending && pendingRemoveMember?.id === row.original.id}
          onClick={() => setPendingRemoveMember(row.original)}
          aria-label={t`Remove ${row.original.email} from organization`}
          {...stylex.props(consoleShell.actionButton)}
        >
          <Trans>Remove</Trans>
        </Button>
      ),
      meta: { width: '100px' },
    },
  ]

  const invitationColumns: ColumnDef<OrgInvitation>[] = [
    {
      id: 'email',
      header: () => <Trans>Email</Trans>,
      cell: ({ row }) => row.original.email,
    },
    {
      id: 'role',
      header: () => <Trans>Role</Trans>,
      cell: ({ row }) => roleLabel(row.original.role),
      meta: { width: '100px' },
    },
    {
      id: 'status',
      header: () => <Trans>Status</Trans>,
      cell: ({ row }) => (
        <StatusBadge
          status={row.original.status}
          label={invitationStatusLabel(row.original.status)}
        />
      ),
      meta: { width: '100px' },
    },
    {
      id: 'expires',
      header: () => <Trans>Expires</Trans>,
      cell: ({ row }) => new Date(row.original.expiresAt).toLocaleDateString(),
      meta: { width: '120px' },
    },
    {
      id: 'actions',
      header: () => <Trans>Actions</Trans>,
      cell: ({ row }) =>
        row.original.status === 'pending' ? (
          <Button
            variant="ghost"
            onClick={() => setPendingRevokeInvitation(row.original)}
            aria-label={t`Revoke invitation for ${row.original.email}`}
            {...stylex.props(consoleShell.actionButton)}
          >
            <Trans>Revoke</Trans>
          </Button>
        ) : null,
      meta: { width: '100px' },
    },
  ]

  async function handleInvite(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!orgId || !inviteEmail.trim()) return
    setInviteSuccess(false)
    await createInvitation.mutateAsync({ email: inviteEmail.trim(), role: inviteRole })
    setInviteSuccess(true)
    setInviteEmail('')
  }

  async function confirmRemove(): Promise<void> {
    if (!orgId || !pendingRemoveMember) return
    await removeMember.mutateAsync(pendingRemoveMember.id)
    setPendingRemoveMember(null)
  }

  async function confirmRevokeInvitation(): Promise<void> {
    if (!orgId || !pendingRevokeInvitation) return
    await revokeInvitation.mutateAsync(pendingRevokeInvitation.id)
    setPendingRevokeInvitation(null)
  }

  if (!orgId) {
    return (
      <ConsolePage wide title={<Trans>Members</Trans>}>
        <ConsolePageNotice>
          <Alert tone="info">
            <Trans>No organization selected.</Trans>
          </Alert>
        </ConsolePageNotice>
      </ConsolePage>
    )
  }

  return (
    <ConsolePage
      wide
      title={<Trans>Members</Trans>}
      lead={<Trans>Manage organization members and pending invitations.</Trans>}
    >
      {removeMember.error ? (
        <ConsolePageNotice>
          <Alert tone="error">
            <Trans>Failed to remove member. Try again.</Trans>
          </Alert>
        </ConsolePageNotice>
      ) : null}

      <ConsolePageSection title={<Trans>Active members</Trans>}>
        {membersError ? (
          <Alert tone="error">
            <Trans>Failed to load members.</Trans>
          </Alert>
        ) : (
          <>
            <DataTable
              columns={memberColumns}
              data={membersPage?.data ?? []}
              getRowId={(row) => row.id}
              isLoading={membersLoading}
              emptyMessage={<Trans>No members found.</Trans>}
            />
            {membersPage ? (
              <Pagination
                nextCursor={membersPage.nextCursor}
                loadMoreLabel={<Trans>Load more members</Trans>}
                onLoadMore={setMemberCursor}
              />
            ) : null}
          </>
        )}
      </ConsolePageSection>

      <ConsolePageSection title={<Trans>Pending invitations</Trans>}>
        {invitationsError ? (
          <Alert tone="error">
            <Trans>Failed to load invitations.</Trans>
          </Alert>
        ) : (
          <>
            <DataTable
              columns={invitationColumns}
              data={invitationsPage?.data ?? []}
              getRowId={(row) => row.id}
              isLoading={invitationsLoading}
              emptyMessage={<Trans>No pending invitations.</Trans>}
            />
            {invitationsPage ? (
              <Pagination
                nextCursor={invitationsPage.nextCursor}
                loadMoreLabel={<Trans>Load more invitations</Trans>}
                onLoadMore={setInviteCursor}
              />
            ) : null}
          </>
        )}
      </ConsolePageSection>

      <ConsolePageSplitSection
        title={<Trans>Invite member</Trans>}
        description={
          <Trans>The recipient will receive an email with a link to join this organization.</Trans>
        }
      >
        <form
          onSubmit={(e) => void handleInvite(e)}
          noValidate
          {...stylex.props(styles.inviteForm)}
        >
          <div {...stylex.props(styles.inviteRow)}>
            <div {...stylex.props(styles.inviteEmailWrap)}>
              <Field
                label={<Trans>Email address</Trans>}
                error={
                  createInvitation.error ? t`Failed to send invitation. Try again.` : undefined
                }
                required
              >
                <Input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder={t`colleague@example.com`}
                  autoComplete="email"
                  required
                />
              </Field>
            </div>
            <div {...stylex.props(styles.inviteRoleWrap)}>
              <Field label={<Trans>Role</Trans>}>
                <Select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as OrganizationMembershipRole)}
                  aria-label={t`Select role for new member`}
                >
                  <option value="member">{roleLabel('member')}</option>
                  <option value="admin">{roleLabel('admin')}</option>
                </Select>
              </Field>
            </div>
            <Button type="submit" isLoading={createInvitation.isPending}>
              <Trans>Send invitation</Trans>
            </Button>
          </div>
          {inviteSuccess ? (
            <Alert tone="success">
              <Trans>Invitation sent successfully.</Trans>
            </Alert>
          ) : null}
        </form>
      </ConsolePageSplitSection>

      {pendingRemoveMember ? (
        <ConfirmDialog
          title={<Trans>Remove member?</Trans>}
          description={
            <Trans>
              {pendingRemoveMember.email} will be removed from this organization immediately.
            </Trans>
          }
          confirmLabel={<Trans>Remove</Trans>}
          isLoading={removeMember.isPending}
          onConfirm={() => void confirmRemove()}
          onCancel={() => setPendingRemoveMember(null)}
        />
      ) : null}

      {pendingRevokeInvitation ? (
        <ConfirmDialog
          title={<Trans>Revoke invitation?</Trans>}
          description={
            <Trans>
              The invitation sent to {pendingRevokeInvitation.email} will be revoked and can no
              longer be accepted.
            </Trans>
          }
          confirmLabel={<Trans>Revoke</Trans>}
          isLoading={revokeInvitation.isPending}
          onConfirm={() => void confirmRevokeInvitation()}
          onCancel={() => setPendingRevokeInvitation(null)}
        />
      ) : null}
    </ConsolePage>
  )
}
