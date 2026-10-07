// 修改组织角色:三选一并写明每个角色能做什么。只有 owner / org_manager 能授予或降级 owner。
// 唯一 owner 降级时服务端返回 last_owner,这里说明原因与下一步。

import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { OrganizationMembershipRole } from '@xid-kit/types'
import { useAuth } from '@xid-kit/web-ui/session'
import { useRoleLabel } from '@xid-kit/web-ui/enum-labels'
import { useManagementErrorMessage } from '@xid-kit/web-ui/api-error-message'
import { Alert, Button, Dialog, RadioGroup, useToast } from '@xid-kit/web-ui/ui'
import { useChangeMemberRole } from './member-api'

const ROLES: readonly OrganizationMembershipRole[] = ['owner', 'admin', 'member']

export function ChangeRoleDialog({
  orgId,
  orgName,
  membershipId,
  memberName,
  currentRole,
  isSelf,
  onClose,
  invalidateKey,
}: {
  orgId: string
  orgName: string
  membershipId: string
  memberName: string
  currentRole: OrganizationMembershipRole
  isSelf: boolean
  onClose: () => void
  invalidateKey?: readonly unknown[]
}): ReactNode {
  const { t } = useLingui()
  const { notify } = useToast()
  const roleLabel = useRoleLabel()
  const errorMessage = useManagementErrorMessage()
  const { organizations } = useAuth()
  const canManageOwners = organizations.find((org) => org.id === orgId)?.canManageOwners === true
  const change = useChangeMemberRole(orgId, invalidateKey)
  const [role, setRole] = useState<OrganizationMembershipRole>(currentRole)
  const descriptions: Record<OrganizationMembershipRole, ReactNode> = {
    owner: <Trans>Everything an admin can do, plus giving and removing the owner role.</Trans>,
    admin: <Trans>Manage members, sign-in methods, SSO, applications and branding.</Trans>,
    member: <Trans>Sign in to {orgName} apps. No access to this console.</Trans>,
  }
  const ownerLocked = !canManageOwners && (currentRole === 'owner' || role === 'owner')
  const lastOwner = change.error?.code === 'last_owner'

  return (
    <Dialog
      open
      onOpenChange={(next) => (next || change.isPending ? undefined : onClose())}
      title={isSelf ? <Trans>Change your role</Trans> : <Trans>Change role of {memberName}</Trans>}
      description={
        <Trans>
          {memberName} in {orgName}
        </Trans>
      }
      position={{ narrow: 'fullscreen', regular: 'center' }}
      size="md"
      footer={
        <>
          <Button variant="secondary" disabled={change.isPending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            disabled={role === currentRole || ownerLocked}
            isLoading={change.isPending}
            onClick={() =>
              change.mutate(
                { membershipId, role },
                {
                  onSuccess: () => {
                    const newRole = roleLabel(role)
                    notify({ title: t`${memberName} is now ${newRole}` })
                    onClose()
                  },
                },
              )
            }
          >
            <Trans>Save role</Trans>
          </Button>
        </>
      }
    >
      <RadioGroup
        label={t`Role`}
        value={role}
        onValueChange={(value) => setRole(value as OrganizationMembershipRole)}
        options={ROLES.map((candidate) => ({
          value: candidate,
          label:
            candidate === currentRole ? (
              <>
                {roleLabel(candidate)} <Trans>(current)</Trans>
              </>
            ) : (
              roleLabel(candidate)
            ),
          description: descriptions[candidate],
          disabled: candidate === 'owner' && !canManageOwners && currentRole !== 'owner',
        }))}
      />
      {ownerLocked && currentRole === 'owner' ? (
        <Alert tone="info">
          <Trans>Only an owner can change the role of another owner.</Trans>
        </Alert>
      ) : null}
      {lastOwner ? (
        <Alert
          tone="error"
          title={
            isSelf ? (
              <Trans>You are the only owner, so your role can't change yet</Trans>
            ) : (
              <Trans>{memberName} is the only owner</Trans>
            )
          }
        >
          <Trans>
            {orgName} must always have an owner. Make another admin an owner first, then change this
            role.
          </Trans>
        </Alert>
      ) : change.error ? (
        <Alert tone="error">{errorMessage(change.error)}</Alert>
      ) : null}
    </Dialog>
  )
}
