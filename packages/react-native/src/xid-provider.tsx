// tokenCache / browser 由调用方注入，不硬绑任何 native 模块。

import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'

import type { BrowserInterface } from './browser-interface'
import type { TokenCache } from './token-cache'
import { XidSessionManager } from './session-manager'
import type { StoredTokenSet, TokenSet } from './token-exchange'
import { XidRnContext } from './xid-rn-context'

export type XidProviderProps = {
  children: ReactNode
  tokenCache: TokenCache
  browser: BrowserInterface
  issuer: string
  clientId: string
  redirectUri: string
  scopes?: readonly string[]
  fetcher?: typeof fetch
}

export function XidProvider({
  tokenCache,
  browser,
  issuer,
  clientId,
  redirectUri,
  scopes = ['openid', 'profile', 'email'],
  fetcher = fetch,
  children,
}: XidProviderProps): ReactNode {
  const manager = useMemo(() => new XidSessionManager({ tokenCache }), [tokenCache])
  const [session, setSession] = useState<StoredTokenSet | null>(null)
  const [isLoaded, setIsLoaded] = useState(false)

  const restoreSession = useCallback(async (): Promise<StoredTokenSet | null> => {
    const restored = await manager.restore()
    setSession(restored)
    setIsLoaded(true)
    return restored
  }, [manager])

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    const restored = await restoreSession()
    return restored?.accessToken ?? null
  }, [restoreSession])

  const commitAuthorizationSession = useCallback(
    async (tokens: TokenSet): Promise<StoredTokenSet> => manager.commitAuthorizationSession(tokens),
    [manager],
  )

  const clearSession = useCallback(async (): Promise<void> => {
    await manager.clear()
    setSession(null)
    setIsLoaded(true)
  }, [manager])

  const signOut = useCallback(async (): Promise<void> => {
    await manager.signOut()
    setSession(null)
    setIsLoaded(true)
  }, [manager])

  useEffect(() => {
    let isCurrent = true
    void manager.restore().then(
      (restored) => {
        if (!isCurrent) return
        setSession(restored)
        setIsLoaded(true)
      },
      () => {
        if (!isCurrent) return
        setSession(null)
        setIsLoaded(true)
      },
    )
    return () => {
      isCurrent = false
    }
  }, [manager])

  const rnContextValue = useMemo(
    () => ({
      tokenCache,
      browser,
      issuer,
      clientId,
      redirectUri,
      scopes,
      fetcher,
      isLoaded,
      session,
      restoreSession,
      commitAuthorizationSession,
      getAccessToken,
      clearSession,
      signOut,
    }),
    [
      tokenCache,
      browser,
      issuer,
      clientId,
      redirectUri,
      scopes,
      fetcher,
      isLoaded,
      session,
      restoreSession,
      commitAuthorizationSession,
      getAccessToken,
      clearSession,
      signOut,
    ],
  )

  return <XidRnContext.Provider value={rnContextValue}>{children}</XidRnContext.Provider>
}
