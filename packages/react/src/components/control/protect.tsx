// Protect:权限门控容器(对标 Clerk <Protect>)。
// 检查 isSignedIn + 可选 permission/role;不满足时渲染 fallback 或 null。

import type { ReactNode } from 'react'

import { useXidStore } from '../../hooks/use-xid-store'

export type ProtectProps = {
  children: ReactNode
  // 要求拥有该 permission(org 权限字符串,如 "org:member:read")
  permission?: string
  // 要求拥有该 role(如 "org:admin")
  role?: string
  // 不满足时渲染(默认 null)
  fallback?: ReactNode
}

export function Protect({ children, permission, role, fallback = null }: ProtectProps): ReactNode {
  const state = useXidStore()

  if (!state.isLoaded || !state.isSignedIn) return fallback

  if (permission !== undefined || role !== undefined) {
    const memberships = state.user?.organizationMemberships ?? []
    const activeMembership = memberships.find((m) => m.organization.id === state.organization?.id)

    if (role !== undefined && activeMembership?.role !== role) return fallback
    if (permission !== undefined && !activeMembership?.permissions.includes(permission))
      return fallback
  }

  return children
}
