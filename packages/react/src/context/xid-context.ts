// XidContext:React context 持有 XidClient 实例 + publishableKey。
// 组件与 hooks 通过 useXidContext() 访问,禁止直接用 useContext(XidContext)。

import { createContext, useContext } from 'react'

import type { XidClient } from '@xid-kit/core'

export type XidContextValue = {
  client: XidClient
  publishableKey: string
}

export const XidContext = createContext<XidContextValue | null>(null)

export function useXidContext(): XidContextValue {
  const ctx = useContext(XidContext)
  if (ctx === null) {
    throw new Error(
      '[xid-kit] useXidContext: must be called inside <XidProvider>. ' +
        'Wrap your app with <XidProvider publishableKey="pk_..." />.',
    )
  }
  return ctx
}
