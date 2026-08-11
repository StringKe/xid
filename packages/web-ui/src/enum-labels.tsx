// 机器枚举值经 lingui macro 映射为用户可见标签,禁止直接渲染机器字符串。

import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { OrganizationMembershipRole } from '@xid-kit/types'
import type { BadgeTone } from './components/ui/Badge'

type MemberStatus = 'active' | 'inactive' | 'pending'
type InvitationStatus = 'pending' | 'expired' | 'accepted' | 'revoked'

const MEMBER_STATUS_LABELS: Record<MemberStatus, MessageDescriptor> = {
  active: msg`Active`,
  inactive: msg`Inactive`,
  pending: msg`Pending`,
}

const INVITATION_STATUS_LABELS: Record<InvitationStatus, MessageDescriptor> = {
  pending: msg`Pending`,
  expired: msg`Expired`,
  accepted: msg`Accepted`,
  revoked: msg`Revoked`,
}

export function useMemberStatusLabel(): (status: MemberStatus) => string {
  const { i18n } = useLingui()
  return (status) => {
    const descriptor = MEMBER_STATUS_LABELS[status]
    return descriptor ? i18n._(descriptor) : status
  }
}

export function useInvitationStatusLabel(): (status: InvitationStatus) => string {
  const { i18n } = useLingui()
  return (status) => {
    const descriptor = INVITATION_STATUS_LABELS[status]
    return descriptor ? i18n._(descriptor) : status
  }
}

const ROLE_LABELS: Record<OrganizationMembershipRole, MessageDescriptor> = {
  member: msg`Member`,
  admin: msg`Admin`,
  owner: msg`Owner`,
}

export function useRoleLabel(): (role: OrganizationMembershipRole) => string {
  const { i18n } = useLingui()
  return (role) => {
    const descriptor = ROLE_LABELS[role]
    return descriptor ? i18n._(descriptor) : role
  }
}

type OrganizationStatus = 'active' | 'suspended' | 'deleted'

const ORGANIZATION_STATUS_LABELS: Record<OrganizationStatus, MessageDescriptor> = {
  active: msg`Active`,
  suspended: msg`Suspended`,
  deleted: msg`Deleted`,
}

export function useOrganizationStatusLabel(): (status: OrganizationStatus) => string {
  const { i18n } = useLingui()
  return (status) => {
    const descriptor = ORGANIZATION_STATUS_LABELS[status]
    return descriptor ? i18n._(descriptor) : status
  }
}

type GlobalUserStatus = 'active' | 'inactive' | 'banned'

const GLOBAL_USER_STATUS_LABELS: Record<GlobalUserStatus, MessageDescriptor> = {
  active: msg`Active`,
  inactive: msg`Inactive`,
  banned: msg`Banned`,
}

export function useGlobalUserStatusLabel(): (status: GlobalUserStatus) => string {
  const { i18n } = useLingui()
  return (status) => {
    const descriptor = GLOBAL_USER_STATUS_LABELS[status]
    return descriptor ? i18n._(descriptor) : status
  }
}

type ConnectionStatus = 'active' | 'inactive' | 'error'

const CONNECTION_STATUS_LABELS: Record<ConnectionStatus, MessageDescriptor> = {
  active: msg`Active`,
  inactive: msg`Inactive`,
  error: msg`Error`,
}

export function useConnectionStatusLabel(): (status: ConnectionStatus) => string {
  const { i18n } = useLingui()
  return (status) => {
    const descriptor = CONNECTION_STATUS_LABELS[status]
    return descriptor ? i18n._(descriptor) : status
  }
}

type DirectoryStatus = 'active' | 'inactive'

const DIRECTORY_STATUS_LABELS: Record<DirectoryStatus, MessageDescriptor> = {
  active: msg`Active`,
  inactive: msg`Inactive`,
}

export function useDirectoryStatusLabel(): (status: DirectoryStatus) => string {
  const { i18n } = useLingui()
  return (status) => {
    const descriptor = DIRECTORY_STATUS_LABELS[status]
    return descriptor ? i18n._(descriptor) : status
  }
}

type BillingStatus = 'ok' | 'overdue' | 'exceeded'

const BILLING_STATUS_LABELS: Record<BillingStatus, MessageDescriptor> = {
  ok: msg`OK`,
  overdue: msg`Overdue`,
  exceeded: msg`Exceeded`,
}

export function useBillingStatusLabel(): (status: BillingStatus) => string {
  const { i18n } = useLingui()
  return (status) => {
    const descriptor = BILLING_STATUS_LABELS[status]
    return descriptor ? i18n._(descriptor) : status
  }
}

// 机器状态 -> Badge tone 的唯一映射,页面不得各自猜色。
export function statusToneFor(status: string): BadgeTone {
  switch (status) {
    case 'active':
    case 'verified':
    case 'accepted':
    case 'success':
    case 'resolved':
    case 'delivered':
      return 'success'
    case 'pending':
    case 'invited':
    case 'investigating':
    case 'identified':
    case 'monitoring':
    case 'processing':
    case 'exceeded':
      return 'warning'
    case 'suspended':
    case 'revoked':
    case 'expired':
    case 'error':
    case 'failed':
    case 'critical':
    case 'banned':
    case 'overdue':
      return 'danger'
    default:
      return 'neutral'
  }
}
