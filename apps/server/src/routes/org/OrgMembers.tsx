// org 成员管理页:成员列表(cursor 分页)+ 邀请列表 + 邀请表单。
// 成员状态徽章、角色显示、移除成员操作。调 /v1/organizations/:orgId/members 与 /invitations。
// 全宽锚定版式:零 padding 壳,各节自持 gutter;全宽 1px hairline 分节;
// 邀请表单 5/7 双列(左节题+说明,右控件),窄屏堆叠。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import * as stylex from '@stylexjs/stylex'
import type { ColumnDef } from '@tanstack/react-table'
import { Alert, Badge, Button, Field, Input } from '../../components/ui'
import type { BadgeTone } from '../../components/ui'
import { DataTable } from '../../components/ui/DataTable'
import { Pagination } from '../../components/ui/Pagination'
import { page } from '../../styles/product-surface.stylex'
import { tokens } from '../../styles/tokens.stylex'
import { useInvitationStatusLabel, useMemberStatusLabel, useRoleLabel } from '../../lib/enum-labels'
import { ConfirmDialog } from '../account/ConfirmDialog'
import {
  useOrgMembersQuery,
  useOrgInvitationsQuery,
  useCreateOrgInvitation,
  useRevokeOrgInvitation,
  useRemoveOrgMember,
} from './queries'
import type { OrgInvitation, OrgMember } from './types'
import { useOrgTarget } from './useOrgTarget'

const GUTTER = 'clamp(1rem, 2.5vw, 4rem)'
const SECTION_PAD = 'clamp(1.5rem, 1.6vw, 2.5rem)'
const CROSS_GAP = 'clamp(1.75rem, 2vw, 3.5rem)'

const STATUS_TONE: Record<string, BadgeTone> = {
  active: 'success',
  inactive: 'neutral',
  pending: 'warning',
  expired: 'danger',
  accepted: 'success',
  revoked: 'danger',
}

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    paddingBottom: 'clamp(2rem, 3vw, 4rem)',
  },
  // 页头区:持有 gutter + 纵向呼吸
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
  // 各内容节:全宽 hairline 上分隔 + gutter 内距
  section: {
    paddingInline: GUTTER,
    paddingBlock: SECTION_PAD,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  sectionLabelRow: {
    marginBottom: '1rem',
  },
  // 消息区域独立 gutter
  messageZone: {
    paddingInline: GUTTER,
    paddingBlock: '1.5rem',
  },
  // 表格全宽贯穿:表头和首尾列与 gutter 对齐靠 DataTable 内部 paddingInline
  tableWrap: {
    marginInline: `calc(${GUTTER} * -1)`,
    paddingInline: GUTTER,
  },
  // 邀请表单 5/7 双列
  inviteGrid: {
    display: 'grid',
    gridTemplateColumns: {
      default: '1fr',
      '@media (min-width: 64rem)': 'minmax(0, 5fr) minmax(0, 7fr)',
    },
    gap: '0',
  },
  inviteLeft: {
    paddingInlineEnd: {
      default: '0',
      '@media (min-width: 64rem)': CROSS_GAP,
    },
    paddingBottom: {
      default: SECTION_PAD,
      '@media (min-width: 64rem)': '0',
    },
    borderInlineEndWidth: {
      default: '0',
      '@media (min-width: 64rem)': '1px',
    },
    borderInlineEndStyle: 'solid',
    borderInlineEndColor: tokens['--xid-border'],
    borderBottomWidth: {
      default: '1px',
      '@media (min-width: 64rem)': '0',
    },
    borderBottomStyle: 'solid',
    borderBottomColor: tokens['--xid-border'],
  },
  inviteRight: {
    paddingInlineStart: {
      default: '0',
      '@media (min-width: 64rem)': CROSS_GAP,
    },
    paddingTop: {
      default: SECTION_PAD,
      '@media (min-width: 64rem)': '0',
    },
  },
  inviteLeftTitle: {
    margin: '0 0 0.375rem',
    fontSize: '0.9375rem',
    fontWeight: 600,
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
  },
  inviteLeftDesc: {
    margin: 0,
    fontSize: '0.8125rem',
    lineHeight: 1.55,
    color: tokens['--xid-muted-foreground'],
    fontFamily: tokens['--xid-font'],
  },
  // 表单控件行(email 拉伸 + role 固宽 + 按钮)
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
  select: {
    width: '100%',
    minHeight: '2.5rem',
    paddingBlock: 0,
    paddingInline: '0.75rem',
    borderRadius: tokens['--xid-radius'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: tokens['--xid-border'],
    background: tokens['--xid-bg'],
    color: tokens['--xid-fg'],
    fontFamily: tokens['--xid-font'],
    fontSize: '0.875rem',
  },
  // 表格内操作按钮紧凑
  actionBtn: {
    minHeight: '1.75rem',
    paddingBlock: 0,
    paddingInline: '0.625rem',
    fontSize: '0.75rem',
  },
  successAlert: {
    marginTop: '0.75rem',
  },
  paginationWrap: {
    marginTop: '0.75rem',
  },
  errorAlert: {
    marginBottom: '0.75rem',
  },
})

function StatusBadge({
  status,
  label,
}: {
  status: OrgMember['status'] | OrgInvitation['status']
  label: string
}): ReactNode {
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{label}</Badge>
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
  const [inviteRole, setInviteRole] = useState('member')
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
          {...stylex.props(styles.actionBtn)}
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
            {...stylex.props(styles.actionBtn)}
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
      <div {...stylex.props(styles.messageZone)}>
        <Alert tone="info">
          <Trans>No organization selected.</Trans>
        </Alert>
      </div>
    )
  }

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.headerZone)}>
        <h1 {...stylex.props(styles.title)}>
          <Trans>Members</Trans>
        </h1>
      </div>

      {removeMember.error ? (
        <div {...stylex.props(styles.messageZone, styles.errorAlert)}>
          <Alert tone="error">{removeMember.error.message}</Alert>
        </div>
      ) : null}

      <section aria-labelledby="members-heading" {...stylex.props(styles.section)}>
        <h2 id="members-heading" {...stylex.props(page.sectionLabel, styles.sectionLabelRow)}>
          <Trans>Active members</Trans>
        </h2>
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
              <div {...stylex.props(styles.paginationWrap)}>
                <Pagination
                  nextCursor={membersPage.nextCursor}
                  loadMoreLabel={<Trans>Load more members</Trans>}
                  onLoadMore={setMemberCursor}
                />
              </div>
            ) : null}
          </>
        )}
      </section>

      <section aria-labelledby="invitations-heading" {...stylex.props(styles.section)}>
        <h2 id="invitations-heading" {...stylex.props(page.sectionLabel, styles.sectionLabelRow)}>
          <Trans>Pending invitations</Trans>
        </h2>
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
              <div {...stylex.props(styles.paginationWrap)}>
                <Pagination
                  nextCursor={invitationsPage.nextCursor}
                  loadMoreLabel={<Trans>Load more invitations</Trans>}
                  onLoadMore={setInviteCursor}
                />
              </div>
            ) : null}
          </>
        )}
      </section>

      <section aria-labelledby="invite-heading" {...stylex.props(styles.section)}>
        <h2 id="invite-heading" {...stylex.props(page.sectionLabel, styles.sectionLabelRow)}>
          <Trans>Invite member</Trans>
        </h2>
        <div {...stylex.props(styles.inviteGrid)}>
          <div {...stylex.props(styles.inviteLeft)}>
            <p {...stylex.props(styles.inviteLeftTitle)}>
              <Trans>Send an invitation</Trans>
            </p>
            <p {...stylex.props(styles.inviteLeftDesc)}>
              <Trans>
                The recipient will receive an email with a link to join this organization.
              </Trans>
            </p>
          </div>
          <div {...stylex.props(styles.inviteRight)}>
            <form onSubmit={(e) => void handleInvite(e)} noValidate>
              <div {...stylex.props(styles.inviteRow)}>
                <div {...stylex.props(styles.inviteEmailWrap)}>
                  <Field
                    label={<Trans>Email address</Trans>}
                    error={createInvitation.error?.message ?? undefined}
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
                    <select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value)}
                      aria-label={t`Select role for new member`}
                      {...stylex.props(styles.select)}
                    >
                      <option value="member">{roleLabel('member')}</option>
                      <option value="admin">{roleLabel('admin')}</option>
                      <option value="viewer">{roleLabel('viewer')}</option>
                    </select>
                  </Field>
                </div>
                <Button type="submit" isLoading={createInvitation.isPending}>
                  <Trans>Send invitation</Trans>
                </Button>
              </div>
              {inviteSuccess ? (
                <div {...stylex.props(styles.successAlert)}>
                  <Alert tone="success">
                    <Trans>Invitation sent successfully.</Trans>
                  </Alert>
                </div>
              ) : null}
            </form>
          </div>
        </div>
      </section>

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
    </div>
  )
}
