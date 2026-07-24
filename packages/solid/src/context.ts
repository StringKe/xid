// XidContext: SolidJS context holding XidClient + publishableKey.
// Primitives access via useXidContext(); never call useContext(XidContext) directly.

import { createContext, useContext } from 'solid-js'

import type { XidClient } from '@xid-kit/core'

export type XidContextValue = {
  readonly client: XidClient
  readonly publishableKey: string
}

export const XidContext = createContext<XidContextValue | null>(null)

export function useXidContext(): XidContextValue {
  const ctx = useContext(XidContext)
  if (ctx === null) {
    throw new Error(
      '[xid-kit/solid] useXidContext: must be called inside <XidProvider>. ' +
        'Wrap your app with <XidProvider publishableKey="pk_..." />.',
    )
  }
  return ctx
}
