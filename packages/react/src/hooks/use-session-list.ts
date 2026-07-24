// useSessionList:多会话列表与 active session 切换 hook。

import type { XidSession, XidState } from '@xid-kit/core'
import type { Result, XidError } from '@xid-kit/types'

import { useXidContext } from '../context/xid-context'
import { useXidStore } from './use-xid-store'

export type UseSessionListReturn =
  | { isLoaded: false; sessions: readonly []; setActive: SetActiveSession }
  | {
      isLoaded: true
      sessions: readonly XidSession[]
      activeSession: XidSession | null
      setActive: SetActiveSession
    }

type SetActiveSession = (sessionId: string) => Promise<Result<XidState, XidError>>

export function useSessionList(): UseSessionListReturn {
  const { client } = useXidContext()
  const state = useXidStore()
  const setActive: SetActiveSession = (sessionId) => client.setActiveSession({ sessionId })

  if (!state.isLoaded) return { isLoaded: false, sessions: [], setActive }
  return {
    isLoaded: true,
    sessions: state.sessions,
    activeSession: state.session,
    setActive,
  }
}
