// useXidState:从 XidClient 订阅状态并包装为 Vue 响应式 Ref。
// 由具体 composable(useAuth/useUser/useOrganization/useSession)复用。
// onScopeDispose 在组件 onUnmounted 与 effectScope.stop() 两个路径都有效。

import { onScopeDispose, readonly, ref, type DeepReadonly, type Ref } from 'vue'

import type { XidState } from '@xid-kit/core'

import { useXidClient } from '../plugin'

export function useXidState(): DeepReadonly<Ref<XidState>> {
  const client = useXidClient()
  const state = ref<XidState>(client.getSnapshot())

  const unsubscribe = client.subscribe((nextState) => {
    state.value = nextState
  })

  // onScopeDispose 在组件卸载与 effectScope.stop() 时都会触发清理。
  onScopeDispose(unsubscribe)

  // DeepReadonly 防止 composable 消费者意外直接修改状态。
  return readonly(state) as DeepReadonly<Ref<XidState>>
}
