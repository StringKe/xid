// 枚举值本地化标签映射。
// 所有展示给用户的机器枚举值(status/role/provider 等)通过此文件走 lingui macro,
// 不直接渲染机器字符串。

import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import type { MessageDescriptor } from '@lingui/core'

// --- 成员 / 邀请状态 ---

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

// --- 成员角色 ---

const ROLE_LABELS: Record<string, MessageDescriptor> = {
  member: msg`Member`,
  admin: msg`Admin`,
  viewer: msg`Viewer`,
  owner: msg`Owner`,
}

export function useRoleLabel(): (role: string) => string {
  const { i18n } = useLingui()
  return (role) => {
    const descriptor = ROLE_LABELS[role]
    return descriptor ? i18n._(descriptor) : role
  }
}

// --- SSO 连接状态 ---

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

// --- SCIM 目录状态 ---

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
