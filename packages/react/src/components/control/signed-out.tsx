import type { ReactNode } from 'react'

import { useXidStore } from '../../hooks/use-xid-store'

export type SignedOutProps = {
  children: ReactNode
}

export function SignedOut({ children }: SignedOutProps): ReactNode {
  const state = useXidStore()
  // 加载完成前不渲染,避免未登录页在 hydration 期间闪现
  if (!state.isLoaded || state.isSignedIn) return null
  return children
}
