// use-xid-store:订阅 XidStore 的 React adapter。
// 用 useSyncExternalStore 保证 concurrent mode 下 tearing-free 读取。

import { useSyncExternalStore } from 'react'

import type { XidState } from '@xid-kit/core'

import { useXidContext } from '../context/xid-context'

export function useXidStore(): XidState {
  const { client } = useXidContext()
  return useSyncExternalStore(
    client.subscribe.bind(client),
    client.getSnapshot,
    // server snapshot:SSR 场景返回初始未加载状态,避免 hydration mismatch。
    () => client.getSnapshot(),
  )
}
