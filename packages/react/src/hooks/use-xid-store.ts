// useSyncExternalStore 保证 concurrent mode 无 tearing;第三参 server snapshot 避免 SSR hydration mismatch。

import { useSyncExternalStore } from 'react'

import type { XidState } from '@xid-kit/core'

import { useXidContext } from '../context/xid-context'

export function useXidStore(): XidState {
  const { client } = useXidContext()
  return useSyncExternalStore(
    client.subscribe.bind(client),
    client.getSnapshot,
    () => client.getSnapshot(),
  )
}
