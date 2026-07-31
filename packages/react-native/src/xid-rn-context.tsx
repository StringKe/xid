// XidRnContext:RN 专属 context,以本地安全存储中的 OIDC token session 为唯一登录态。

import { createContext, useContext } from 'react'

import type { BrowserInterface } from './browser-interface'
import type { TokenCache } from './token-cache'
import type { StoredTokenSet, TokenSet } from './token-exchange'

export type XidRnContextValue = {
  tokenCache: TokenCache
  browser: BrowserInterface
  issuer: string
  clientId: string
  redirectUri: string
  scopes: readonly string[]
  fetcher: typeof fetch
  isLoaded: boolean
  session: StoredTokenSet | null
  restoreSession: () => Promise<StoredTokenSet | null>
  commitAuthorizationSession: (tokens: TokenSet) => Promise<StoredTokenSet>
  getAccessToken: () => Promise<string | null>
  clearSession: () => Promise<void>
  signOut: () => Promise<void>
}

export const XidRnContext = createContext<XidRnContextValue | null>(null)

export function useXidRnContext(): XidRnContextValue {
  const ctx = useContext(XidRnContext)
  if (ctx === null) {
    throw new Error(
      '[xid-kit/react-native] useXidRnContext: must be called inside <XidProvider>. ' +
        'Wrap your app with <XidProvider issuer="https://..." clientId="..." tokenCache={...} browser={...} />.',
    )
  }
  return ctx
}
