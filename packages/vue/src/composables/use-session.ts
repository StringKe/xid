// useSession:当前活跃 session composable(对标 @clerk/clerk-react useSession 的 Vue 版)。

import { computed } from 'vue'

import type { GetTokenOptions, XidSession } from '@xid-kit/core'
import type { Result, XidError } from '@xid-kit/types'

import { useXidClient } from '../plugin'
import { useXidState } from './use-xid-state'

export type UseSessionReturn =
  | { isLoaded: false; isSignedIn: false; session: null }
  | { isLoaded: true; isSignedIn: false; session: null }
  | {
      isLoaded: true
      isSignedIn: true
      session: XidSession
      getToken: (options?: GetTokenOptions) => Promise<Result<string, XidError>>
    }

export function useSession(): { value: UseSessionReturn } {
  const client = useXidClient()
  const state = useXidState()

  const result = computed((): UseSessionReturn => {
    if (!state.value.isLoaded) {
      return { isLoaded: false, isSignedIn: false, session: null }
    }
    if (!state.value.isSignedIn || state.value.session === null) {
      return { isLoaded: true, isSignedIn: false, session: null }
    }
    return {
      isLoaded: true,
      isSignedIn: true,
      session: state.value.session,
      getToken: (options) => client.getToken(options),
    }
  })

  return result
}
