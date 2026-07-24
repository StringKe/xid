// XidLoading:SDK 加载中(status==='loading',isLoaded===false)时渲染 children。
// 典型用法:渲染骨架屏或 spinner,hydration 完成后自动消失。

import type { ReactNode } from 'react'

import { useXidStore } from '../../hooks/use-xid-store'

export type XidLoadingProps = {
  children: ReactNode
}

export function XidLoading({ children }: XidLoadingProps): ReactNode {
  const state = useXidStore()
  if (state.isLoaded) return null
  return children
}
