// XidRnContext:RN 专属 context,持有 tokenCache 与 browserInterface 两个适配器。
// 与 @xid-kit/core XidClient 的 web context 并列,供 RN hooks 访问注入的适配器。

import { createContext, useContext } from 'react'

import type { BrowserInterface } from './browser-interface'
import type { TokenCache } from './token-cache'
import type { StoredTokenSet } from './token-exchange'

export type XidRnContextValue = {
  tokenCache: TokenCache
  browser: BrowserInterface
  issuer: string
  clientId: string
  redirectUri: string
  scopes: readonly string[]
  isLoaded: boolean
  session: StoredTokenSet | null
  restoreSession: () => Promise<StoredTokenSet | null>
  getAccessToken: () => Promise<string | null>
  clearSession: () => Promise<void>
}

export const XidRnContext = createContext<XidRnContextValue | null>(null)

export function useXidRnContext(): XidRnContextValue {
  const ctx = useContext(XidRnContext)
  if (ctx === null) {
    throw new Error(
      '[xid-kit/react-native] useXidRnContext: must be called inside <XidProvider>. ' +
        'Wrap your app with <XidProvider publishableKey="pk_..." tokenCache={...} browser={...} />.',
    )
  }
  return ctx
}
