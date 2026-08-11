import type { XidUser } from '@xid-kit/core'

import { useXidStore } from './use-xid-store'

export type UseUserReturn =
  | { isLoaded: false; isSignedIn: false; user: null }
  | { isLoaded: true; isSignedIn: false; user: null }
  | { isLoaded: true; isSignedIn: true; user: XidUser }

export function useUser(): UseUserReturn {
  const state = useXidStore()

  if (!state.isLoaded) {
    return { isLoaded: false, isSignedIn: false, user: null }
  }
  if (!state.isSignedIn || state.user === null) {
    return { isLoaded: true, isSignedIn: false, user: null }
  }
  return { isLoaded: true, isSignedIn: true, user: state.user }
}
