// SignedOut:仅未登录用户可见的控制容器。

import type { ReactNode } from 'react'

import { useXidStore } from '../../hooks/use-xid-store'

export type SignedOutProps = {
  children: ReactNode
}

export function SignedOut({ children }: SignedOutProps): ReactNode {
  const state = useXidStore()
  // 加载中也不显示(避免未登录页闪现)
  if (!state.isLoaded || state.isSignedIn) return null
  return children
}
