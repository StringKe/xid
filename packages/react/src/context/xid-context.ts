// 必须经 useXidContext() 访问,禁止直接 useContext(XidContext) 绕过 Provider 校验。

import { createContext, useContext } from 'react'

import type { XidClient } from '@xid-kit/core'

export type XidContextValue = {
  client: XidClient
  mode: 'same-origin' | 'oidc'
}

export const XidContext = createContext<XidContextValue | null>(null)

export function useXidContext(): XidContextValue {
  const ctx = useContext(XidContext)
  if (ctx === null) {
    throw new Error(
      '[xid-kit] useXidContext: must be called inside <XidProvider>. ' +
        'Wrap your app with <XidProvider mode="oidc" issuer="https://..." clientId="..." redirectUri="https://..." />.',
    )
  }
  return ctx
}
