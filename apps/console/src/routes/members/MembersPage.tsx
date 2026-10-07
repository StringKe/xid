// Members:成员与邀请两个标签(写进 URL)。成员可按姓名、邮箱与角色筛选,行菜单改角色或移出组织;
// 邀请可重发(旧链接失效)或撤销。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { OrganizationMembershipRole } from '@xid-kit/types'
import { useAuth } from '@xid-kit/web-ui/session'
import { organizationDisplayName } from '@xid-kit/web-ui/display-names'
import { useLocation, useNavigate, useSearchParams } from '@xid-kit/web-ui/tanstack-router'
import { Alert, Button, Icon, Tabs } from '@xid-kit/web-ui/ui'
import { PageFrame } from '../../components/page/PageFrame'
import { useCanManageOwners, useOrgTarget } from '../org/useOrgTarget'
import { InviteMembersDialog } from './InviteMembersDialog'
import { InvitationsTab } from './InvitationsTab'
import { MembersTab } from './MembersTab'
import { useInvitations, useMembers } from './member-api'
import { organizationNameText } from '../users/user-format'

export default function MembersPage(): ReactNode {
  const { t, i18n } = useLingui()
  const { orgId } = useOrgTarget()
  const { activeOrg } = useAuth()
  const canManageOwners = useCanManageOwners()
  const [params] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const tab = params.get('tab') === 'invitations' ? 'invitations' : 'members'
  const [inviting, setInviting] = useState(false)
  const totals = useMembers(orgId, { role: null, search: '', cursor: null })
  const invitations = useInvitations(orgId)
  const orgName = activeOrg ? organizationDisplayName(activeOrg) : ''
  const topLevel = activeOrg?.parentOrgId === null

  function selectTab(value: string): void {
    const next = new URLSearchParams(params)
    if (value === 'members') next.delete('tab')
    else next.set('tab', value)
    const search = next.toString()
    navigate(`${location.pathname}${search ? `?${search}` : ''}`, { replace: true })
  }

  if (!orgId) {
    return (
      <PageFrame title={<Trans>Members</Trans>}>
        <Alert tone="info">
          <Trans>No organization selected.</Trans>
        </Alert>
      </PageFrame>
    )
  }

  const inviteButton = (
    <Button onClick={() => setInviting(true)}>
      <Icon name="plus" size={16} />
      <Trans>Invite members…</Trans>
    </Button>
  )

  return (
    <PageFrame
      title={<Trans>Members</Trans>}
      lead={
        topLevel ? (
          <Trans>
            People who belong to {orgName} and what they can manage here. People who only use your
            apps are listed under Users.
          </Trans>
        ) : (
          <Trans>People who belong to {orgName} and what they can manage here.</Trans>
        )
      }
    >
      <Tabs
        ariaLabel={t`Member sections`}
        value={tab}
        onValueChange={selectTab}
        items={[
          { value: 'members', label: <Trans>Members</Trans>, count: totals.data?.total },
          {
            value: 'invitations',
            label: <Trans>Invitations</Trans>,
            count: invitations.data?.total,
          },
        ]}
      />
      {tab === 'members' ? (
        <MembersTab
          orgId={orgId}
          orgName={organizationNameText(i18n, activeOrg?.name)}
          action={inviteButton}
        />
      ) : (
        <InvitationsTab orgId={orgId} invitations={invitations} action={inviteButton} />
      )}
      {inviting ? (
        <InviteMembersDialog
          orgId={orgId}
          orgName={organizationNameText(i18n, activeOrg?.name)}
          canInviteOwners={canManageOwners}
          onClose={() => setInviting(false)}
        />
      ) : null}
    </PageFrame>
  )
}

export type RoleFilter = OrganizationMembershipRole | null
