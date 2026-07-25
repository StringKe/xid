// useXid:返回完整 XidState 的响应式只读引用(对标 react 的 useAuth 原始状态)。
// 对标 Clerk Vue useAuth()。

import type { DeepReadonly, Ref } from 'vue'

import type { GetTokenOptions, XidState } from '@xid-kit/core'
import type { Result, XidError } from '@xid-kit/types'

import { useXidClient } from '../plugin'
import { useXidState } from './use-xid-state'

export type UseXidReturn = {
  state: DeepReadonly<Ref<XidState>>
  getToken: (options?: GetTokenOptions) => Promise<Result<string, XidError>>
  signOut: (options?: { sessionId?: string }) => Promise<Result<null, XidError>>
  setActiveOrganization: (organizationId: string | null) => Promise<Result<XidState, XidError>>
}

export function useXid(): UseXidReturn {
  const client = useXidClient()
  const state = useXidState()

  return {
    state,
    getToken: (options) => client.getToken(options),
    signOut: (options) => client.signOut(options),
    setActiveOrganization: (organizationId) => client.setActiveOrganization({ organizationId }),
  }
}
