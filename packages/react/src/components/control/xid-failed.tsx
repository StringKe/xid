// XidFailed:SDK 加载遇到不可恢复错误(status==='error')时渲染 children。
// children 可通过 useAuth().session(null) + error 字段展示错误详情。

import type { ReactNode } from 'react'

import { useXidStore } from '../../hooks/use-xid-store'

export type XidFailedProps = {
  children: ReactNode
}

export function XidFailed({ children }: XidFailedProps): ReactNode {
  const state = useXidStore()
  if (state.status !== 'error') return null
  return children
}
