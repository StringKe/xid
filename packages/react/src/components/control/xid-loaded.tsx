// isLoaded 为 true 即渲染(含 ready/degraded);细粒度降级请用 XidDegraded。

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
