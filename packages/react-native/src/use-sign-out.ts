import { useCallback, useState } from 'react'

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
  const { signOut: signOutSession } = useXidRnContext()
  const [signOutState, setSignOutState] = useState<SignOutState>({ status: 'idle' })

  const signOut = useCallback(async (): Promise<void> => {
    setSignOutState({ status: 'pending' })
    try {
      await signOutSession()
      setSignOutState({ status: 'complete' })
    } catch (err) {
      setSignOutState({
        status: 'error',
        error: err instanceof Error ? err : new Error(String(err)),
      })
    }
  }, [signOutSession])

  return { signOutState, signOut }
}
