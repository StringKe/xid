// useUser:当前登录用户视图 composable(对标 @clerk/clerk-react useUser 的 Vue 版)。
// 使用判别联合返回类型保证 TypeScript 类型收窄。

import { computed } from 'vue'

import type { XidUser } from '@xid-kit/core'

import { useXidState } from './use-xid-state'

export type UseUserReturn =
  | { isLoaded: false; isSignedIn: false; user: null }
  | { isLoaded: true; isSignedIn: false; user: null }
  | { isLoaded: true; isSignedIn: true; user: XidUser }

export function useUser(): { value: UseUserReturn } {
  const state = useXidState()

  const result = computed((): UseUserReturn => {
    if (!state.value.isLoaded) {
      return { isLoaded: false, isSignedIn: false, user: null }
    }
    if (!state.value.isSignedIn || state.value.user === null) {
      return { isLoaded: true, isSignedIn: false, user: null }
    }
    return { isLoaded: true, isSignedIn: true, user: state.value.user }
  })

  return result
}
