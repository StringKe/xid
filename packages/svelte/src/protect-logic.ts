import type { XidState } from '@xid-kit/core'
import type { OrganizationMembershipRole } from '@xid-kit/types'

export type ProtectOptions = {
  permission?: string
  role?: OrganizationMembershipRole
}

export function isAllowed(state: XidState, options: ProtectOptions): boolean {
  if (!state.isLoaded || !state.isSignedIn) return false

  const { permission, role } = options
  if (permission === undefined && role === undefined) return true

  const memberships = state.user?.organizationMemberships ?? []
  const activeMembership = memberships.find((m) => m.organization.id === state.organization?.id)

  if (role !== undefined && activeMembership?.role !== role) return false
  if (permission !== undefined && !activeMembership?.permissions.includes(permission)) return false

  return true
}
