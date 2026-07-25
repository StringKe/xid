// useOrganization:当前活跃 org hook(对标 @clerk/clerk-react useOrganization)。
// 含 setActive 切换 org + 成员关系列表。

import type { XidOrganization, XidOrganizationMembership } from '@xid-kit/core'
import type { Result, XidError } from '@xid-kit/types'

import { useXidContext } from '../context/xid-context'
import { useXidStore } from './use-xid-store'

export type UseOrganizationReturn =
  | { isLoaded: false; isSignedIn: false; organization: null; membership: null }
  | { isLoaded: true; isSignedIn: false; organization: null; membership: null }
  | {
      isLoaded: true
      isSignedIn: true
      organization: XidOrganization | null
      membership: XidOrganizationMembership | null
      setActive: (organizationId: string | null) => Promise<Result<unknown, XidError>>
    }

export function useOrganization(): UseOrganizationReturn {
  const { client } = useXidContext()
  const state = useXidStore()

  if (!state.isLoaded) {
    return { isLoaded: false, isSignedIn: false, organization: null, membership: null }
  }
  if (!state.isSignedIn) {
    return { isLoaded: true, isSignedIn: false, organization: null, membership: null }
  }

  const membership =
    state.user?.organizationMemberships.find((m) => m.organization.id === state.organization?.id) ??
    null

  return {
    isLoaded: true,
    isSignedIn: true,
    organization: state.organization,
    membership,
    setActive: (organizationId) => client.setActiveOrganization({ organizationId }),
  }
}
