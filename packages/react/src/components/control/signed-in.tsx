// SignedIn:仅登录用户可见的控制容器。

import type { ReactNode } from 'react'

import { useXidStore } from '../../hooks/use-xid-store'

export type SignedInProps = {
  children: ReactNode
}

export function SignedIn({ children }: SignedInProps): ReactNode {
  const state = useXidStore()
  if (!state.isLoaded || !state.isSignedIn) return null
  return children
}
