// XidProvider:注入 XidClient,启动时调用 client.load()。
// 对标 @clerk/clerk-react ClerkProvider。

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'

import {
  XidClient,
  type OidcXidClientOptions,
  type SameOriginXidClientOptions,
} from '@xid-kit/core'

import { XidContext } from './xid-context'

export type XidProviderProps =
  | (Omit<SameOriginXidClientOptions, 'secretKey'> & { children: ReactNode })
  | (OidcXidClientOptions & { children: ReactNode })

export function XidProvider(props: XidProviderProps): ReactNode {
  const { children } = props
  const [client] = useState(
    () =>
      new XidClient(
        props.mode === 'oidc'
          ? {
              mode: 'oidc',
              issuer: props.issuer,
              clientId: props.clientId,
              redirectUri: props.redirectUri,
              ...(props.scopes ? { scopes: props.scopes } : {}),
              ...(props.postLogoutRedirectUri
                ? { postLogoutRedirectUri: props.postLogoutRedirectUri }
                : {}),
              ...(props.tokenCache ? { tokenCache: props.tokenCache } : {}),
              ...(props.fetcher ? { fetcher: props.fetcher } : {}),
              ...(props.now ? { now: props.now } : {}),
            }
          : {
              mode: 'same-origin',
              ...(props.apiUrl ? { apiUrl: props.apiUrl } : {}),
              ...(props.fetcher ? { fetcher: props.fetcher } : {}),
              ...(props.now ? { now: props.now } : {}),
            },
      ),
  )

  // 首次挂载拉取登录态;AbortController 在卸载时取消。
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    abortRef.current = ac
    void client.load({ signal: ac.signal })
    return () => {
      ac.abort()
    }
  }, [client])

  const mode: 'same-origin' | 'oidc' = props.mode === 'oidc' ? 'oidc' : 'same-origin'
  const value = useMemo(() => ({ client, mode }), [client, mode])

  return <XidContext.Provider value={value}>{children}</XidContext.Provider>
}
