// 经 useXidContext 读取；禁止直接 useContext(XidContext)，以便缺少 Provider 时抛出明确错误。

import { createContext, useContext } from 'solid-js'

import type { XidClient } from '@xid-kit/core'

export type XidContextValue = {
  readonly client: XidClient
  readonly mode: 'same-origin' | 'oidc'
}

export const XidContext = createContext<XidContextValue | null>(null)

export function useXidContext(): XidContextValue {
  const ctx = useContext(XidContext)
  if (ctx === null) {
    throw new Error(
      '[xid-kit/solid] useXidContext: must be called inside <XidProvider>. ' +
        'Wrap your app with <XidProvider mode="oidc" issuer="https://..." clientId="..." redirectUri="..." />.',
    )
  }
  return ctx
}
