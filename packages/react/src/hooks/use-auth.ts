// useAuth:顶层认证状态 hook(对标 @clerk/clerk-react useAuth)。
// 暴露 isLoaded/isSignedIn/userId/sessionId + getToken/signOut 操作。

import type { GetTokenOptions, XidSession } from '@xid-kit/core'
import { isGuestUser } from '@xid-kit/core'
import type { Result, XidError } from '@xid-kit/types'

import { useXidContext } from '../context/xid-context'
import { useXidStore } from './use-xid-store'

export type UseAuthReturn = {
  isLoaded: boolean
  isSignedIn: boolean
  // guest 判定:当前用户匿名开通(provisionedBy === 'anonymous'),与 Hosted UI isGuestUser 同口径。
  isAnonymous: boolean
  userId: string | null
  sessionId: string | null
  session: XidSession | null
  getToken: (options?: GetTokenOptions) => Promise<Result<string, XidError>>
  signOut: (options?: { sessionId?: string }) => Promise<Result<null, XidError>>
}

export function useAuth(): UseAuthReturn {
  const { client } = useXidContext()
  const state = useXidStore()

  return {
    isLoaded: state.isLoaded,
    isSignedIn: state.isSignedIn,
    isAnonymous: isGuestUser(state.user),
    userId: state.user?.id ?? null,
    sessionId: state.session?.id ?? null,
    session: state.session,
    getToken: (options) => client.getToken(options),
    signOut: (options) => client.signOut(options),
  }
}
