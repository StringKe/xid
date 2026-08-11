import type { XidOrganizationMembership, XidState } from '@xid-kit/core'
import type { Result, XidError } from '@xid-kit/types'

import { useXidContext } from '../context/xid-context'
import { useXidStore } from './use-xid-store'

export type UseOrganizationListReturn =
  | { isLoaded: false; isSignedIn: false; memberships: readonly []; setActive: SetActiveOrg }
  | { isLoaded: true; isSignedIn: false; memberships: readonly []; setActive: SetActiveOrg }
  | {
      isLoaded: true
      isSignedIn: true
      memberships: readonly XidOrganizationMembership[]
      activeMembership: XidOrganizationMembership | null
      setActive: SetActiveOrg
    }

type SetActiveOrg = (organizationId: string | null) => Promise<Result<XidState, XidError>>

export function useOrganizationList(): UseOrganizationListReturn {
  const { client } = useXidContext()
  const state = useXidStore()
  const setActive: SetActiveOrg = (organizationId) =>
    client.setActiveOrganization({ organizationId })

  if (!state.isLoaded) {
    return { isLoaded: false, isSignedIn: false, memberships: [], setActive }
  }
  if (!state.isSignedIn || state.user === null) {
    return { isLoaded: true, isSignedIn: false, memberships: [], setActive }
  }

  const memberships = state.user.organizationMemberships
  const activeMembership =
    memberships.find((membership) => membership.organization.id === state.organization?.id) ?? null

  return {
    isLoaded: true,
    isSignedIn: true,
    memberships,
    activeMembership,
    setActive,
  }
}
