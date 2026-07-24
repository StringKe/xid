// XidLoaded:SDK hydration 完成后才渲染 children(status==='ready' 或 'degraded')。
// isLoaded 为 true 即认为初始化结束,不区分 ready/degraded;需要更精细判断用 XidDegraded。

import type { ReactNode } from 'react'

import { useXidStore } from '../../hooks/use-xid-store'

export type XidLoadedProps = {
  children: ReactNode
}

export function XidLoaded({ children }: XidLoadedProps): ReactNode {
  const state = useXidStore()
  if (!state.isLoaded) return null
  return children
}
