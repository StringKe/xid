import type { ReactNode } from 'react'
import type { OrganizationMembershipRole } from '@xid-kit/types'

import { useXidStore } from '../../hooks/use-xid-store'

export type ProtectProps = {
  children: ReactNode
  permission?: string
  role?: OrganizationMembershipRole
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
