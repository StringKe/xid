// useAuth: top-level auth state composable (Vue port of @clerk/clerk-react useAuth).
// Returns isLoaded/isSignedIn/userId/sessionId/session + getToken/signOut reactive derivatives.

import { computed } from 'vue'

import type { GetTokenOptions, XidSession } from '@xid-kit/core'
import type { Result, XidError } from '@xid-kit/types'

import { useXidClient } from '../plugin'
import { useXidState } from './use-xid-state'

export type UseAuthReturn = {
  readonly isLoaded: boolean
  readonly isSignedIn: boolean
  readonly userId: string | null
  readonly sessionId: string | null
  // Active session object; null when signed out or not yet loaded.
  readonly session: XidSession | null
  getToken: (options?: GetTokenOptions) => Promise<Result<string, XidError>>
  signOut: (options?: { sessionId?: string }) => Promise<Result<null, XidError>>
}

export function useAuth(): UseAuthReturn {
  const client = useXidClient()
  const state = useXidState()

  const isLoaded = computed(() => state.value.isLoaded)
  const isSignedIn = computed(() => state.value.isSignedIn)
  const userId = computed(() => state.value.user?.id ?? null)
  const sessionId = computed(() => state.value.session?.id ?? null)
  const session = computed(() => state.value.session)

  return {
    get isLoaded() {
      return isLoaded.value
    },
    get isSignedIn() {
      return isSignedIn.value
    },
    get userId() {
      return userId.value
    },
    get sessionId() {
      return sessionId.value
    },
    get session() {
      return session.value
    },
    getToken: (options) => client.getToken(options),
    signOut: (options) => client.signOut(options),
  }
}
