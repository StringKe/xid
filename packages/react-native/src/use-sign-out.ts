// useSignOut(RN):清除本地 token 缓存并调用 @xid-kit/core signOut。

import { useCallback, useState } from 'react'

import { useAuth } from '@xid-kit/react'

import { useXidRnContext } from './xid-rn-context'

export type SignOutState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'complete' }
  | { status: 'error'; error: Error }

export type UseSignOutReturn = {
  signOutState: SignOutState
  signOut: () => Promise<void>
}

export function useSignOut(): UseSignOutReturn {
  const { clearSession } = useXidRnContext()
  const auth = useAuth()
  const [signOutState, setSignOutState] = useState<SignOutState>({ status: 'idle' })

  const signOut = useCallback(async (): Promise<void> => {
    setSignOutState({ status: 'pending' })
    try {
      // 清本地 token 缓存。
      await clearSession()
      // 通知 XidClient 服务端清 session cookie。
      const result = await auth.signOut()
      if (!result.ok) {
        throw new Error(`[xid-kit/react-native] Sign out failed: ${result.error.message}`)
      }
      setSignOutState({ status: 'complete' })
    } catch (err) {
      setSignOutState({
        status: 'error',
        error: err instanceof Error ? err : new Error(String(err)),
      })
    }
  }, [clearSession, auth])

  return { signOutState, signOut }
}
