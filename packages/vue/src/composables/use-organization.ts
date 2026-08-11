import { computed } from 'vue'

import type { XidOrganization, XidOrganizationMembership, XidState } from '@xid-kit/core'
import type { Result, XidError } from '@xid-kit/types'

import { useXidClient } from '../plugin'
import { useXidState } from './use-xid-state'

export type UseOrganizationReturn =
  | { isLoaded: false; isSignedIn: false; organization: null; membership: null }
  | { isLoaded: true; isSignedIn: false; organization: null; membership: null }
  | {
      isLoaded: true
      isSignedIn: true
      organization: XidOrganization | null
      membership: XidOrganizationMembership | null
      setActive: (organizationId: string | null) => Promise<Result<XidState, XidError>>
    }

export function useOrganization(): { value: UseOrganizationReturn } {
  const client = useXidClient()
  const state = useXidState()

  const result = computed((): UseOrganizationReturn => {
    if (!state.value.isLoaded) {
      return { isLoaded: false, isSignedIn: false, organization: null, membership: null }
    }
    if (!state.value.isSignedIn) {
      return { isLoaded: true, isSignedIn: false, organization: null, membership: null }
    }

    const memberships = state.value.user?.organizationMemberships ?? []
    const membership =
      memberships.find((m) => m.organization.id === state.value.organization?.id) ?? null

    return {
      isLoaded: true,
      isSignedIn: true,
      organization: state.value.organization,
      membership,
      setActive: (organizationId) => client.setActiveOrganization({ organizationId }),
    }
  })

  return result
}
