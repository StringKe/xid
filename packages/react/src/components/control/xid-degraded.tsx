// degraded:非致命错误(如 /v1/me 失败)后 isLoaded 仍为 true,会话可能不可用。

import type { ReactNode } from 'react'

import { useXidStore } from '../../hooks/use-xid-store'

export type XidDegradedProps = {
  children: ReactNode
}

export function XidDegraded({ children }: XidDegradedProps): ReactNode {
  const state = useXidStore()
  if (state.status !== 'degraded') return null
  return children
}
