// useSession:当前活跃 session 视图 hook(对标 @clerk/clerk-react useSession)。

import type { GetTokenOptions, XidSession } from '@xid-kit/core'
import type { Result, XidError } from '@xid-kit/types'

import { useXidContext } from '../context/xid-context'
import { useXidStore } from './use-xid-store'

export type UseSessionReturn =
  | { isLoaded: false; isSignedIn: false; session: null }
  | { isLoaded: true; isSignedIn: false; session: null }
  | {
      isLoaded: true
      isSignedIn: true
      session: XidSession
      getToken: (options?: GetTokenOptions) => Promise<Result<string, XidError>>
    }

export function useSession(): UseSessionReturn {
  const { client } = useXidContext()
  const state = useXidStore()

  if (!state.isLoaded) {
    return { isLoaded: false, isSignedIn: false, session: null }
  }
  if (!state.isSignedIn || state.session === null) {
    return { isLoaded: true, isSignedIn: false, session: null }
  }
  return {
    isLoaded: true,
    isSignedIn: true,
    session: state.session,
    getToken: (options) => client.getToken(options),
  }
}
