// 订阅 XidClient 并包成 Vue Ref；onScopeDispose 同时覆盖 onUnmounted 与 effectScope.stop()。

import { onScopeDispose, readonly, ref, type DeepReadonly, type Ref } from 'vue'

import type { XidState } from '@xid-kit/core'

import { useXidClient } from '../plugin'

export function useXidState(): DeepReadonly<Ref<XidState>> {
  const client = useXidClient()
  const state = ref<XidState>(client.getSnapshot())

  const unsubscribe = client.subscribe((nextState) => {
    state.value = nextState
  })

  onScopeDispose(unsubscribe)

  // DeepReadonly：防止消费者直接改状态。
  return readonly(state) as DeepReadonly<Ref<XidState>>
}
