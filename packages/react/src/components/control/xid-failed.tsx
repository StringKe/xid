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
