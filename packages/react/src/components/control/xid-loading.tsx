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
