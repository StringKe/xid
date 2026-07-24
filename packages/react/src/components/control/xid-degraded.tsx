// XidDegraded:SDK 处于降级状态(status==='degraded',isLoaded===true 但有非致命错误)时渲染。
// 典型场景:/v1/me 返回错误但未完全阻断——SDK 已加载,会话可能不可用。

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
